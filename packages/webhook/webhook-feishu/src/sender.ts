/** Outbound Feishu IM sender with a cached tenant_access_token. */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/** Feishu Open API endpoint that exchanges app credentials for a tenant token. */
const TENANT_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'

/** Feishu Open API endpoint that posts one IM message. */
const SEND_MESSAGE_URL = 'https://open.feishu.cn/open-apis/im/v1/messages'

/** Hard ceiling for one outbound HTTP exchange so replies cannot hang a session queue. */
const REQUEST_TIMEOUT_MS = 15_000

/** Re-fetch the tenant token this long before its stated expiry. */
const TOKEN_REFRESH_MARGIN_MS = 60_000

/** Fallback token lifetime when Feishu omits the `expire` field. */
const DEFAULT_TOKEN_LIFETIME_MS = 60 * 60 * 1000

/** Credential references the sender resolves for every token acquisition. */
export interface FeishuSenderConfig {
  /** Credential reference containing the Feishu app id. */
  readonly appIdEnv: CredentialRef
  /** Credential reference containing the Feishu app secret. */
  readonly appSecretEnv: CredentialRef
}

/** Minimal transport shape so tests can inject a fake `fetch`. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Outbound text sender used by the reply pump. */
export interface FeishuSender {
  /**
   * Send one text message into one chat.
   * @param chatId - Feishu chat id that receives the message.
   * @param text - non-empty message text sent as a Feishu `text` message.
   * @throws network, HTTP status, and Feishu API refusals propagate to the caller.
   */
  sendText(chatId: string, text: string): Promise<void>
}

interface CachedTenantToken {
  readonly value: string
  readonly expiresAt: number
}

/** Return one object field, or undefined when it is absent or not an object. */
function objectField(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Return one non-empty string field, or undefined. */
function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Parse one bounded Feishu response body as a JSON object. */
async function readJsonObject(response: Response, subject: string): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`Feishu ${subject} response was not JSON`)
  }
  const record = objectField(parsed)
  if (record === undefined) throw new Error(`Feishu ${subject} response was not a JSON object`)
  return record
}

/** Resolve one required credential value or refuse outbound work. */
async function requiredCredential(ctx: Context, ref: CredentialRef, subject: string): Promise<string> {
  const credential = await ctx.credentials.resolve(ref)
  if (credential === undefined || credential.value === '') {
    throw new Error(`Feishu ${subject} credential is unavailable`)
  }
  return credential.value
}

/** Extract the positive-integer `expire` seconds or the fallback lifetime. */
function tokenLifetimeMs(payload: Record<string, unknown>): number {
  const expire = payload['expire']
  return typeof expire === 'number' && Number.isSafeInteger(expire) && expire > 1
    ? expire * 1000
    : DEFAULT_TOKEN_LIFETIME_MS
}

/**
 * Create one outbound Feishu sender.
 * @param ctx - adapter context carrying the credentials service.
 * @param config - credential references for the app id and app secret.
 * @param fetchImpl - transport override for tests; defaults to global `fetch`.
 * @returns one sender whose token cache is single-flight and expires ahead of Feishu's stated lifetime.
 */
export function createFeishuSender(
  ctx: Context,
  config: FeishuSenderConfig,
  fetchImpl: FetchLike = fetch,
): FeishuSender {
  let cached: CachedTenantToken | undefined
  let loading: Promise<CachedTenantToken> | undefined

  async function loadTenantToken(): Promise<CachedTenantToken> {
    const appId = await requiredCredential(ctx, config.appIdEnv, 'app id')
    const appSecret = await requiredCredential(ctx, config.appSecretEnv, 'app secret')
    const response = await fetchImpl(TENANT_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Feishu tenant_access_token request failed with status ${response.status}`)
    const payload = await readJsonObject(response, 'tenant_access_token')
    if (payload['code'] !== 0) {
      const reason = stringField(payload, 'msg') ?? 'unknown reason'
      throw new Error(`Feishu tenant_access_token was refused (code ${String(payload['code'])}): ${reason}`)
    }
    const token = stringField(payload, 'tenant_access_token')
    if (token === undefined) throw new Error('Feishu tenant_access_token response carried no token')
    return {
      value: token,
      expiresAt: Date.now() + Math.max(tokenLifetimeMs(payload) - TOKEN_REFRESH_MARGIN_MS, 1000),
    }
  }

  async function tenantToken(): Promise<string> {
    if (cached !== undefined && Date.now() < cached.expiresAt) return cached.value
    loading ??= loadTenantToken().finally(() => {
      loading = undefined
    })
    cached = await loading
    return cached.value
  }

  return {
    async sendText(chatId, text) {
      const token = await tenantToken()
      const response = await fetchImpl(`${SEND_MESSAGE_URL}?receive_id_type=chat_id`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`Feishu message send failed with status ${response.status}`)
      const payload = await readJsonObject(response, 'message send')
      if (payload['code'] !== 0) {
        const reason = stringField(payload, 'msg') ?? 'unknown reason'
        throw new Error(`Feishu message send was refused (code ${String(payload['code'])}): ${reason}`)
      }
    },
  }
}
