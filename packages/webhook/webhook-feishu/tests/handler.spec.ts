import { createCipheriv, createHash } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createFeishuWebhookHandler } from '../src/handler.ts'

const servers: Server[] = []
const TOKEN_REF = 'DSH_FEISHU_VERIFICATION_TOKEN'
const KEY_REF = 'DSH_FEISHU_ENCRYPT_KEY'

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => { resolve() }))))
})

/** One mutable fake for credential rotation and dispatch observation. */
function fakeContext(token = 'fixture-token', encryptKey?: string): {
  ctx: Context
  dispatch: ReturnType<typeof vi.fn>
  setToken(value: string | undefined): void
  warnings: ReturnType<typeof vi.fn>
} {
  let currentToken = token as string | undefined
  const dispatch = vi.fn()
  const warnings = vi.fn()
  return {
    ctx: {
      credentials: {
        resolve: async (ref: string) => {
          if (ref === KEY_REF) return encryptKey === undefined ? undefined : { value: encryptKey, source: 'environment' }
          return currentToken === undefined ? undefined : { value: currentToken, source: 'environment' }
        },
      },
      webhookRuntime: { dispatch },
      logger: { warn: warnings },
    } as unknown as Context,
    dispatch,
    setToken(value) { currentToken = value },
    warnings,
  }
}

/** Start a real Node server around the package-owned route handler. */
async function serve(ctx: Context, options: { maxBodyBytes?: number; encryptKeyEnv?: boolean } = {}): Promise<string> {
  const handler = createFeishuWebhookHandler(ctx, {
    source: 'primary',
    tokenEnv: credentialRef(TOKEN_REF),
    ...(options.encryptKeyEnv === true ? { encryptKeyEnv: credentialRef(KEY_REF) } : {}),
    maxBodyBytes: options.maxBodyBytes ?? 1024,
  })
  const server = createServer((request, response) => { void handler(request, response) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return `http://127.0.0.1:${String(port)}`
}

/** Encrypt one payload with the Feishu AES-256-CBC scheme (16-byte IV prefix). */
function encryptFor(key: string, payload: object): string {
  const iv = Buffer.alloc(16, 0)
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(key).digest(), iv)
  return Buffer.concat([iv, cipher.update(JSON.stringify(payload), 'utf-8'), cipher.final()]).toString('base64')
}

/** Send one Feishu-shaped request. */
async function post(
  base: string,
  body: string,
  options: { contentType?: string; method?: string } = {},
): Promise<Response> {
  return await fetch(base, {
    method: options.method ?? 'POST',
    headers: { 'content-type': options.contentType ?? 'application/json' },
    ...(options.method === 'GET' ? {} : { body }),
  })
}

/** Send body chunks without Content-Length through a real Node client socket. */
async function postChunked(base: string, chunks: readonly string[]): Promise<{ body: string; status: number }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(base, {
      method: 'POST',
      headers: { connection: 'close', 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => { resolve({ body, status: response.statusCode ?? 0 }) })
    })
    request.once('error', reject)
    request.once('socket', (socket) => { socket.setNoDelay(true) })
    for (const chunk of chunks) request.write(chunk)
    request.end()
  })
}

/** One v2.0 im.message.receive_v1 delivery. */
function eventBody(token = 'fixture-token'): string {
  return JSON.stringify({
    schema: '2.0',
    header: { event_id: 'evt-1', event_type: 'im.message.receive_v1', token, create_time: '1' },
    event: { message: { content: '{"text":"hi"}' } },
  })
}

describe('Feishu webhook HTTP handler', () => {
  it('answers a url_verification challenge without dispatching', async () => {
    const fake = fakeContext()
    const base = await serve(fake.ctx)
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc', token: 'fixture-token' })
    const response = await post(base, body)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ challenge: 'abc' })
    expect(fake.dispatch).not.toHaveBeenCalled()
  })

  it('verifies, projects, dispatches, and answers 200', async () => {
    const fake = fakeContext()
    const base = await serve(fake.ctx)
    const response = await post(base, eventBody(), { contentType: 'application/json; charset=utf-8' })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    expect(fake.dispatch).toHaveBeenCalledOnce()
    const dispatched: unknown = fake.dispatch.mock.calls[0]?.[0]
    expect(dispatched).toMatchObject({
      kind: 'feishu',
      source: 'primary',
      deliveryId: 'evt-1',
      event: { name: 'im.message.receive_v1', payload: { schema: '2.0' } },
    })
    expect(typeof (dispatched as { receivedAt?: unknown }).receivedAt).toBe('number')
  })

  it('resolves the token for each request so rotation takes effect immediately', async () => {
    const fake = fakeContext()
    const base = await serve(fake.ctx)
    expect((await post(base, eventBody())).status).toBe(200)
    fake.setToken('second')
    expect((await post(base, eventBody('second'))).status).toBe(200)
    expect(fake.dispatch).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['method', { method: 'GET' }, 405],
    ['content type', { contentType: 'text/plain' }, 415],
    ['verification token', undefined, 401],
  ] as const)('rejects an invalid %s before dispatch', async (_label, options, status) => {
    const fake = fakeContext()
    const base = await serve(fake.ctx)
    const body = options === undefined
      ? eventBody('wrong-token')
      : JSON.stringify({ type: 'url_verification', challenge: 'abc', token: 'fixture-token' })
    const response = await post(base, body, options)
    expect(response.status).toBe(status)
    if (status === 405) expect(response.headers.get('allow')).toBe('POST')
    expect(fake.dispatch).not.toHaveBeenCalled()
  })

  it('rejects a url_verification challenge without a non-empty challenge', async () => {
    const fake = fakeContext()
    const base = await serve(fake.ctx)
    const body = JSON.stringify({ type: 'url_verification', challenge: '', token: 'fixture-token' })
    expect((await post(base, body)).status).toBe(400)
    expect(fake.dispatch).not.toHaveBeenCalled()
  })

  it('rejects a url_verification challenge without a string token', async () => {
    const fake = fakeContext()
    const base = await serve(fake.ctx)
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc', token: 123 })
    expect((await post(base, body)).status).toBe(401)
    expect(fake.dispatch).not.toHaveBeenCalled()
  })

  it('rejects an encrypted payload shorter than one IV plus one block', async () => {
    const fake = fakeContext('fixture-token', 'fixture-key')
    const base = await serve(fake.ctx, { encryptKeyEnv: true })
    const body = JSON.stringify({ encrypt: Buffer.alloc(31).toString('base64') })
    expect((await post(base, body)).status).toBe(400)
    expect(fake.dispatch).not.toHaveBeenCalled()
  })

  it.each([
    ['header', JSON.stringify({ schema: '2.0', event: {} })],
    ['header.event_id', JSON.stringify({ schema: '2.0', header: { event_type: 'x', token: 'fixture-token' } })],
    ['header.event_type', JSON.stringify({ schema: '2.0', header: { event_id: 'e', token: 'fixture-token' } })],
    ['header.token', JSON.stringify({ schema: '2.0', header: { event_id: 'e', event_type: 'x' } })],
    ['not JSON', '{', 400],
    ['array', '[]', 400],
    ['non-lossless number', '{"value":1e400}'],
  ] as const)('rejects a request with an invalid %s', async (_label, body, expected = 400) => {
    const fake = fakeContext()
    const base = await serve(fake.ctx)
    const response = await post(base, body)
    expect(response.status).toBe(expected)
    expect(fake.dispatch).not.toHaveBeenCalled()
  })

  it('rejects a declared body over the configured cap', async () => {
    const fake = fakeContext()
    const base = await serve(fake.ctx, { maxBodyBytes: 2 })
    expect((await post(base, '{} ')).status).toBe(413)
    expect(fake.dispatch).not.toHaveBeenCalled()
  })

  it('answers 413 for a chunked body over the cap without resetting the connection', async () => {
    const fake = fakeContext()
    const base = await serve(fake.ctx, { maxBodyBytes: 2 })
    await expect(postChunked(base, ['abc'])).resolves.toEqual({
      body: 'request body is too large',
      status: 413,
    })
    expect(fake.dispatch).not.toHaveBeenCalled()
  })

  it('decrypts an encrypted challenge and event with the configured key', async () => {
    const fake = fakeContext('fixture-token', 'fixture-key')
    const base = await serve(fake.ctx, { encryptKeyEnv: true })
    const challenge = await post(base, JSON.stringify({
      encrypt: encryptFor('fixture-key', { type: 'url_verification', challenge: 'enc', token: 'fixture-token' }),
    }))
    expect(challenge.status).toBe(200)
    expect(await challenge.json()).toEqual({ challenge: 'enc' })
    const event = await post(base, JSON.stringify({ encrypt: encryptFor('fixture-key', JSON.parse(eventBody()) as object) }))
    expect(event.status).toBe(200)
    expect(fake.dispatch).toHaveBeenCalledOnce()
    expect(fake.dispatch.mock.calls[0]?.[0]).toMatchObject({ kind: 'feishu', deliveryId: 'evt-1' })
  })

  it.each([
    ['wrong key', 'fixture-token', 'fixture-key', 'other-key', 401],
    ['unconfigured key', 'fixture-token', 'fixture-key', undefined, 503],
  ] as const)('rejects an encrypted payload with a %s', async (_label, token, key, configured, status) => {
    const fake = fakeContext(token, configured)
    const base = await serve(fake.ctx, { encryptKeyEnv: configured !== undefined })
    const body = JSON.stringify({ encrypt: encryptFor(key, { type: 'url_verification', challenge: 'x', token }) })
    expect((await post(base, body)).status).toBe(status)
  })

  it('answers 503 when the token credential or runtime is unavailable', async () => {
    const missing = fakeContext()
    missing.setToken(undefined)
    const missingBase = await serve(missing.ctx)
    expect((await post(missingBase, eventBody())).status).toBe(503)

    const closing = fakeContext()
    closing.dispatch.mockImplementation(() => { throw new Error('closing') })
    const closingBase = await serve(closing.ctx)
    expect((await post(closingBase, eventBody())).status).toBe(503)
    expect(closing.warnings).toHaveBeenCalledTimes(1)
  })

  it('does not leak the token, key, or payload in an infrastructure diagnostic', async () => {
    const fake = fakeContext('fixture-token', 'fixture-key')
    ;(fake.ctx.credentials.resolve as ReturnType<typeof vi.fn> | undefined) = vi.fn(async () => {
      throw new Error('credential store unavailable')
    }) as never
    const base = await serve(fake.ctx, { encryptKeyEnv: true })
    expect((await post(base, eventBody())).status).toBe(503)
    const diagnostics = JSON.stringify(fake.warnings.mock.calls)
    expect(diagnostics).not.toContain('fixture-token')
    expect(diagnostics).not.toContain('fixture-key')
  })

  it('rejects a missing Content-Type before body processing', async () => {
    const fake = fakeContext()
    const handler = createFeishuWebhookHandler(fake.ctx, {
      source: 'primary',
      tokenEnv: credentialRef(TOKEN_REF),
      maxBodyBytes: 1024,
    })
    const request = { method: 'POST', headers: {} } as unknown as IncomingMessage
    const writeHead = vi.fn()
    const response = { setHeader: vi.fn(), writeHead, end: vi.fn() } as unknown as ServerResponse
    await handler(request, response)
    expect(writeHead).toHaveBeenCalledWith(415, expect.any(Object))
    expect(fake.dispatch).not.toHaveBeenCalled()
  })
})
