/** Feishu HTTP token verification, decryption, and fire-and-forget dispatch. */

import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import {
  WebhookDeliveryId,
  WebhookSourceId,
  type VerifiedWebhookDelivery,
} from '@deepseek-ai/dsh-webhook'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { readBoundedUtf8Body, WebhookHttpError } from './body.ts'
import type { FeishuJsonObject } from './types.ts'

/** Handler values validated once at plugin load. */
export interface FeishuWebhookHandlerConfig {
  readonly source: string
  readonly tokenEnv: CredentialRef
  readonly encryptKeyEnv?: CredentialRef
  readonly maxBodyBytes: number
}

/** Whether Content-Type names JSON with at most one UTF-8 charset parameter. */
function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false
  const parts = value.split(';').map(part => part.trim())
  const [mediaType, parameter, ...extra] = parts
  if (mediaType?.toLowerCase() !== 'application/json') return false
  if (parameter === undefined) return true
  return extra.length === 0 && /^charset=(?:utf-8|"utf-8")$/i.test(parameter)
}

/** Send one empty or plain-text response exactly once. */
function respond(response: ServerResponse, status: number, message?: string): void {
  if (message === undefined) {
    response.writeHead(status)
    response.end()
    return
  }
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(message)
}

/** Send one JSON response exactly once. */
function respondJson(response: ServerResponse, status: number, payload: string): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(payload)
}

/** Length-safe token comparison over fixed-size digests. */
function tokensMatch(expected: string, actual: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(expected).digest(),
    createHash('sha256').update(actual).digest(),
  )
}

/** Convert a parsed value into the adapter's verified-object guarantee. */
function parsePayload(body: string): FeishuJsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // JSON.parse is the only statement in the try; no other failure is normalized.
    throw new WebhookHttpError(400, 'request body is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WebhookHttpError(400, 'Feishu webhook payload must be a JSON object')
  }
  const snapshot = snapshotJsonValue(parsed)
  if (snapshot === undefined) throw new WebhookHttpError(400, 'Feishu webhook payload is not lossless JSON')
  return snapshot as FeishuJsonObject
}

/** Decrypt one Feishu AES-256-CBC payload (16-byte IV prefix, SHA-256 key). */
function decryptEvent(encrypted: string, encryptKey: string): FeishuJsonObject {
  const data = Buffer.from(encrypted, 'base64')
  if (data.length <= 32) throw new WebhookHttpError(400, 'encrypted Feishu payload is too short')
  let plaintext: string
  try {
    const decipher = createDecipheriv(
      'aes-256-cbc',
      createHash('sha256').update(encryptKey).digest(),
      data.subarray(0, 16),
    )
    plaintext = Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString('utf-8')
  } catch {
    // Decryption failures carry key material hints nowhere safe to echo.
    throw new WebhookHttpError(401, 'encrypted Feishu payload failed verification')
  }
  return parsePayload(plaintext)
}

/** Resolve one required credential value or refuse the request. */
async function resolveCredential(
  ctx: Context,
  ref: CredentialRef | undefined,
  unavailableMessage: string,
  unconfiguredMessage: string,
): Promise<string> {
  if (ref === undefined) throw new WebhookHttpError(503, unconfiguredMessage)
  const credential = await ctx.credentials.resolve(ref)
  if (credential === undefined || credential.value === '') throw new WebhookHttpError(503, unavailableMessage)
  return credential.value
}

/** Require one non-empty v2.0 event header field. */
function requiredHeaderField(header: FeishuJsonObject, field: string): string {
  const value = header[field]
  if (typeof value !== 'string' || value === '') {
    throw new WebhookHttpError(400, `Feishu event header.${field} must be a non-empty string`)
  }
  return value
}

/** Verify one resolved plaintext payload and either echo the challenge or dispatch. */
function answer(
  ctx: Context,
  config: FeishuWebhookHandlerConfig,
  response: ServerResponse,
  payload: FeishuJsonObject,
  expectedToken: string,
): void {
  if (payload['type'] === 'url_verification') {
    const challenge = payload['challenge']
    if (typeof challenge !== 'string' || challenge === '') {
      throw new WebhookHttpError(400, 'Feishu url_verification requires a non-empty challenge')
    }
    const token = payload['token']
    if (typeof token !== 'string' || !tokensMatch(expectedToken, token)) {
      throw new WebhookHttpError(401, 'invalid Feishu verification token')
    }
    respondJson(response, 200, JSON.stringify({ challenge }))
    return
  }
  const headerValue = payload['header']
  if (headerValue === undefined || headerValue === null
    || typeof headerValue !== 'object' || Array.isArray(headerValue)) {
    throw new WebhookHttpError(400, 'Feishu event requires a v2.0 header object')
  }
  const header: FeishuJsonObject = headerValue
  const token = requiredHeaderField(header, 'token')
  if (!tokensMatch(expectedToken, token)) throw new WebhookHttpError(401, 'invalid Feishu verification token')
  const delivery: VerifiedWebhookDelivery<'feishu'> = {
    kind: 'feishu',
    source: WebhookSourceId(config.source),
    deliveryId: WebhookDeliveryId(requiredHeaderField(header, 'event_id')),
    event: { name: requiredHeaderField(header, 'event_type'), payload },
    receivedAt: Date.now(),
  }
  try {
    ctx.webhookRuntime.dispatch(delivery)
  } catch {
    ctx.logger.warn('webhook-feishu: dispatch unavailable')
    throw new WebhookHttpError(503, 'webhook runtime is unavailable')
  }
  respond(response, 200)
}

/**
 * Create one exact-route Feishu handler.
 * @param ctx - adapter context carrying credentials and webhook runtime.
 * @param config - validated source, credential references, and body ceiling.
 * @returns an HTTP handler that answers after in-memory dispatch, never rule settlement.
 */
export function createFeishuWebhookHandler(
  ctx: Context,
  config: FeishuWebhookHandlerConfig,
): WebRoute['handler'] {
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        throw new WebhookHttpError(405, 'method not allowed')
      }
      if (!isJsonContentType(request.headers['content-type'])) {
        throw new WebhookHttpError(415, 'content type must be application/json')
      }
      const body = await readBoundedUtf8Body(request, config.maxBodyBytes)
      const payload = parsePayload(body)
      const expectedToken = await resolveCredential(
        ctx,
        config.tokenEnv,
        'Feishu verification token is unavailable',
        'Feishu verification token is unavailable',
      )
      if (typeof payload['encrypt'] === 'string') {
        const encryptKey = await resolveCredential(
          ctx,
          config.encryptKeyEnv,
          'Feishu encrypt key is unavailable',
          'Feishu encrypt key is not configured',
        )
        answer(ctx, config, response, decryptEvent(payload['encrypt'], encryptKey), expectedToken)
        return
      }
      answer(ctx, config, response, payload, expectedToken)
    } catch (error: unknown) {
      if (error instanceof WebhookHttpError) {
        respond(response, error.status, error.message)
        return
      }
      ctx.logger.warn('webhook-feishu: request failed')
      respond(response, 503, 'webhook ingress is unavailable')
    }
  }
}
