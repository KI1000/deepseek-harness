import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFeishuSender, type FetchLike } from '../src/sender.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

interface RecordedRequest {
  readonly url: string
  readonly init?: RequestInit
}

/** Extract one recorded request body as text for assertions. */
function bodyText(init?: RequestInit): string {
  const body = init?.body
  return typeof body === 'string' ? body : JSON.stringify(body)
}

/** Context with only the credentials service the sender reads. */
function harness(credential?: { value: string }): Context {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('credentials', {
    resolve: async () => credential,
  } as never)
  return ctx
}

/** Transport that records requests and answers token or send payloads. */
function recordingFetch(overrides?: {
  readonly tokenStatus?: number
  readonly tokenPayload?: unknown
  readonly sendStatus?: number
  readonly sendPayload?: unknown
}): { fetchImpl: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({ url, ...(init === undefined ? {} : { init }) })
    if (url.includes('tenant_access_token')) {
      return new Response(JSON.stringify(overrides?.tokenPayload ?? { code: 0, tenant_access_token: 'token-1', expire: 7200 }), {
        status: overrides?.tokenStatus ?? 200,
      })
    }
    return new Response(JSON.stringify(overrides?.sendPayload ?? { code: 0 }), { status: overrides?.sendStatus ?? 200 })
  }
  return { fetchImpl, requests }
}

const senderConfig = {
  appIdEnv: credentialRef('DSH_TEST_APP_ID'),
  appSecretEnv: credentialRef('DSH_TEST_APP_SECRET'),
}

describe('Feishu sender', () => {
  it('sends one text message with a bearer token and chat_id routing', async () => {
    const { fetchImpl, requests } = recordingFetch()
    const sender = createFeishuSender(harness({ value: 'credential-value' }), senderConfig, fetchImpl)
    await sender.sendText('oc-1', 'hello')
    expect(requests[0]?.url).toBe('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal')
    expect(JSON.parse(bodyText(requests[0]?.init))).toEqual({
      app_id: 'credential-value',
      app_secret: 'credential-value',
    })
    expect(requests[1]?.url).toBe('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id')
    expect(requests[1]?.init?.headers).toMatchObject({ authorization: 'Bearer token-1' })
    expect(JSON.parse(bodyText(requests[1]?.init))).toEqual({
      receive_id: 'oc-1',
      msg_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
    })
  })

  it('caches the tenant token single-flight and refreshes it past the margin', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { fetchImpl, requests } = recordingFetch()
      const sender = createFeishuSender(harness({ value: 'credential-value' }), senderConfig, fetchImpl)
      await Promise.all([sender.sendText('oc-1', 'one'), sender.sendText('oc-1', 'two')])
      expect(requests.filter(request => request.url.includes('tenant_access_token'))).toHaveLength(1)
      vi.setSystemTime(60 * 60 * 1000)
      await sender.sendText('oc-1', 'three')
      expect(requests.filter(request => request.url.includes('tenant_access_token'))).toHaveLength(1)
      vi.setSystemTime(2 * 60 * 60 * 1000)
      await sender.sendText('oc-1', 'four')
      expect(requests.filter(request => request.url.includes('tenant_access_token'))).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to the default lifetime when Feishu omits expire', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { fetchImpl, requests } = recordingFetch({ tokenPayload: { code: 0, tenant_access_token: 'token-1' } })
      const sender = createFeishuSender(harness({ value: 'credential-value' }), senderConfig, fetchImpl)
      await sender.sendText('oc-1', 'one')
      vi.setSystemTime(30 * 60 * 1000)
      await sender.sendText('oc-1', 'two')
      expect(requests.filter(request => request.url.includes('tenant_access_token'))).toHaveLength(1)
      vi.setSystemTime(2 * 60 * 60 * 1000)
      await sender.sendText('oc-1', 'three')
      expect(requests.filter(request => request.url.includes('tenant_access_token'))).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    { label: 'token http status', tokenStatus: 500, message: /tenant_access_token request failed with status 500/ },
    { label: 'token error code', tokenPayload: { code: 99991663, msg: 'bad app id' }, message: /refused.*bad app id/s },
    { label: 'token error code without msg', tokenPayload: { code: 99991663 }, message: /refused.*unknown reason/s },
    { label: 'token payload without token', tokenPayload: { code: 0 }, message: /carried no token/ },
    { label: 'token non-json body', tokenBody: 'not-json', message: /response was not JSON/ },
    { label: 'token non-object body', tokenBody: 'null', message: /response was not a JSON object/ },
  ] as const)('refuses unusable token responses: $label', async ({ tokenStatus, tokenPayload, tokenBody, message }) => {
    const requests: RecordedRequest[] = []
    const fetchImpl: FetchLike = async (url) => {
      requests.push({ url })
      if (url.includes('tenant_access_token')) {
        return new Response(tokenBody ?? JSON.stringify(tokenPayload ?? { code: 0 }), { status: tokenStatus ?? 200 })
      }
      return new Response(JSON.stringify({ code: 0 }), { status: 200 })
    }
    const sender = createFeishuSender(harness({ value: 'credential-value' }), senderConfig, fetchImpl)
    await expect(sender.sendText('oc-1', 'hello')).rejects.toThrow(message)
  })

  it.each([
    { label: 'send http status', sendStatus: 502, message: /message send failed with status 502/ },
    { label: 'send error code', sendPayload: { code: 230001, msg: 'chat not found' }, message: /message send was refused.*chat not found/s },
    { label: 'send non-object body', sendPayload: 'nope', message: /message send response was not a JSON object/ },
  ] as const)('refuses unusable send responses: $label', async ({ sendStatus, sendPayload, message }) => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('tenant_access_token')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'token-1', expire: 7200 }), { status: 200 })
      }
      return new Response(JSON.stringify(sendPayload ?? { code: 0 }), { status: sendStatus ?? 200 })
    }
    const sender = createFeishuSender(harness({ value: 'credential-value' }), senderConfig, fetchImpl)
    await expect(sender.sendText('oc-1', 'hello')).rejects.toThrow(message)
  })

  it('refuses an unavailable app id credential', async () => {
    const { fetchImpl } = recordingFetch()
    const sender = createFeishuSender(harness(undefined), senderConfig, fetchImpl)
    await expect(sender.sendText('oc-1', 'hello')).rejects.toThrow(/app id credential is unavailable/)
  })
})
