
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  WebhookDeliveryId,
  WebhookSourceId,
  type VerifiedWebhookDelivery,
  type WebhookRule,
} from '@deepseek-ai/dsh-webhook'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFeishuChannel, type FeishuChannelConfig } from '../src/channel.ts'
import { createFeishuSender, type FetchLike } from '../src/sender.ts'
import type { FeishuJsonObject, FeishuWebhookEvent } from '../src/types.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const baseConfig: FeishuChannelConfig = {
  source: 'primary',
  workspacePath: '/feishu-workspace',
  agentPreset: 'chat',
  permissionPreset: 'sandbox',
}

const senderConfig = {
  appIdEnv: credentialRef('DSH_TEST_APP_ID'),
  appSecretEnv: credentialRef('DSH_TEST_APP_SECRET'),
}

/** Extract one recorded request body as text for assertions. */
function bodyText(init?: RequestInit): string {
  const body = init?.body
  return typeof body === 'string' ? body : JSON.stringify(body)
}

/** Transport answering one token payload and recording every send. */
function recordingFetch(): { fetchImpl: FetchLike; sends: { url: string; init?: RequestInit }[] } {
  const sends: { url: string; init?: RequestInit }[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.includes('tenant_access_token')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'token-1', expire: 7200 }), { status: 200 })
    }
    sends.push({ url, ...(init === undefined ? {} : { init }) })
    return new Response(JSON.stringify({ code: 0 }), { status: 200 })
  }
  return { fetchImpl, sends }
}

/** Context with the services the channel reads, the sender, and the created rule. */
function channelHarness(fetchImpl: FetchLike, config: Partial<FeishuChannelConfig> = {}): {
  ctx: Context
  rule: WebhookRule<'feishu'>
  disposeChannel: () => void
  removeRule: ReturnType<typeof vi.fn>
} {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('credentials', {
    resolve: async () => ({ value: 'credential-value', source: 'environment' }),
  } as never)
  const removeRule = vi.fn(async () => {})
  const registerRule = vi.fn((_rule: WebhookRule<'feishu'>) => removeRule)
  ctx.provide('webhookRuntime', { register: registerRule } as never)
  const sender = createFeishuSender(ctx, senderConfig, fetchImpl)
  const disposeChannel = createFeishuChannel(ctx, { ...baseConfig, ...config }, sender)
  const call = registerRule.mock.calls[0]?.[0]
  if (call === undefined) throw new Error('channel registered no rule')
  return { ctx, rule: call, disposeChannel, removeRule }
}

function delivery(event: FeishuWebhookEvent, id = 'evt-1', source = 'primary'): VerifiedWebhookDelivery<'feishu'> {
  return {
    kind: 'feishu',
    source: WebhookSourceId(source),
    deliveryId: WebhookDeliveryId(id),
    event,
    receivedAt: 0,
  }
}

function messagePayload(fields: FeishuJsonObject): FeishuJsonObject {
  return {
    schema: '2.0',
    header: { event_id: 'evt-1', event_type: 'im.message.receive_v1', token: 't' },
    event: { message: fields },
  }
}

function textEvent(text: string, overrides: Record<string, JsonValue | undefined> = {}): FeishuWebhookEvent {
  const merged: Record<string, JsonValue | undefined> = {
    chat_id: 'oc-1',
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text }),
    ...overrides,
  }
  const fields: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) fields[key] = value
  }
  return { name: 'im.message.receive_v1', payload: messagePayload(fields) }
}

describe('Feishu channel rule', () => {
  const signal = new AbortController().signal

  it('creates one Session request from a p2p text message', () => {
    const { rule } = channelHarness(recordingFetch().fetchImpl)
    expect(rule.id).toBe('webhook-feishu:primary')
    expect(rule.run(delivery(textEvent('  hello\n  world  ')), signal)).toEqual({
      workspacePath: '/feishu-workspace',
      title: 'Feishu: hello world',
      prompt: '  hello\n  world  ',
      agentPreset: 'chat',
      permissionPreset: 'sandbox',
    })
  })

  it('honors a custom title prefix and forwards an explicit model route', () => {
    const { rule } = channelHarness(recordingFetch().fetchImpl, {
      titlePrefix: '店小二',
      model: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 4096 },
    })
    expect(rule.run(delivery(textEvent('hi')), signal)).toEqual({
      workspacePath: '/feishu-workspace',
      title: '店小二: hi',
      prompt: 'hi',
      agentPreset: 'chat',
      permissionPreset: 'sandbox',
      model: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 4096 },
    })
  })

  it('truncates long titles with an ellipsis', () => {
    const { rule } = channelHarness(recordingFetch().fetchImpl)
    expect(rule.run(delivery(textEvent('x'.repeat(120))), signal)).toMatchObject({
      title: `Feishu: ${'x'.repeat(47)}…`,
    })
  })

  it('creates one Session request from a bot-mentioned group text message', () => {
    const { rule } = channelHarness(recordingFetch().fetchImpl)
    const event = textEvent(' @_user_1  hello\n  world  ', {
      chat_type: 'group',
      mentions: [{ key: '@_user_1', name: 'ToneClaw' }],
    })
    expect(rule.run(delivery(event), signal)).toEqual({
      workspacePath: '/feishu-workspace',
      title: 'Feishu: ToneClaw hello world',
      prompt: ' ToneClaw  hello\n  world  ',
      agentPreset: 'chat',
      permissionPreset: 'sandbox',
    })
  })

  it('removes the configured bot mention while retaining other display names', () => {
    const { rule } = channelHarness(recordingFetch().fetchImpl, { botName: 'ToneClaw' })
    const event = textEvent('@_user_1 tell @_user_2 hello', {
      chat_type: 'group',
      mentions: [
        { key: '@_user_1', name: 'ToneClaw' },
        { key: '@_user_2', name: 'Alice' },
      ],
    })
    expect(rule.run(delivery(event), signal)).toMatchObject({ prompt: ' tell Alice hello' })
  })

  it.each([
    ['other source', delivery(textEvent('hi'), 'evt-1', 'secondary')],
    ['other event type', delivery({ name: 'im.message.message_read_v1', payload: messagePayload({}) })],
    ['missing event object', delivery({ name: 'im.message.receive_v1', payload: { schema: '2.0' } })],
    ['non-object message', delivery({ name: 'im.message.receive_v1', payload: { event: { message: 'nope' } } })],
    ['group chat without a mention', delivery(textEvent('hi', { chat_type: 'group' }))],
    ['group chat with only the mention', delivery(textEvent('@_user_1', {
      chat_type: 'group',
      mentions: [{ key: '@_user_1', name: 'ToneClaw' }],
    }))],
    ['non-text message', delivery(textEvent('hi', { message_type: 'image' }))],
    ['missing chat id', delivery(textEvent('hi', { chat_id: '' }))],
    ['missing content', delivery(textEvent('hi', { content: undefined }))],
    ['unparseable content', delivery(textEvent('hi', { content: 'not-json' }))],
    ['content without text', delivery(textEvent('hi', { content: JSON.stringify({ ignored: true }) }))],
    ['blank text', delivery(textEvent('   '))],
  ] as const)('ignores deliveries that create no Session: %s', (_label, ignored) => {
    const { rule } = channelHarness(recordingFetch().fetchImpl)
    expect(rule.run(ignored, signal)).toBeNull()
  })

  it('deduplicates redelivered events within the bounded window', () => {
    const { rule } = channelHarness(recordingFetch().fetchImpl)
    expect(rule.run(delivery(textEvent('hi')), signal)).not.toBeNull()
    expect(rule.run(delivery(textEvent('hi')), signal)).toBeNull()
    expect(rule.run(delivery(textEvent('hi'), 'evt-2'), signal)).not.toBeNull()
  })

  it('evicts the oldest delivery past the deduplication window', () => {
    const { rule } = channelHarness(recordingFetch().fetchImpl)
    expect(rule.run(delivery(textEvent('hi'), 'evt-0'), signal)).not.toBeNull()
    for (let index = 1; index <= 512; index += 1) {
      expect(rule.run(delivery(textEvent('hi'), `evt-${index}`), signal)).not.toBeNull()
    }
    expect(rule.run(delivery(textEvent('hi'), 'evt-0'), signal)).not.toBeNull()
  })
})

describe('Feishu channel reply pump', () => {
  const webhookSource = {
    kind: 'webhook' as const,
    provider: 'feishu',
    source: 'primary',
    deliveryId: 'evt-1',
    ruleId: 'webhook-feishu:primary',
    form: 'notice' as const,
    summary: 'feishu webhook handled',
  }

  function sessionFixture(id: string): never {
    return { id } as never
  }

  function userMessageEvent(source: Record<string, unknown>): never {
    return {
      type: 'user/message',
      seq: 1,
      time: 0,
      data: { role: 'user', id: 'm1', content: [], source },
    } as never
  }

  function assistantMessageEvent(blocks: ReadonlyArray<{ type: string; text?: string }>): never {
    return {
      type: 'assistant/message',
      seq: 2,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', id: 'm2', content: blocks, source: {} },
        stream: [],
      },
    } as never
  }

  it('binds a webhook user message to its chat and sends assistant text back', async () => {
    const { fetchImpl, sends } = recordingFetch()
    const harness = channelHarness(fetchImpl)
    expect(harness.rule.run(delivery(textEvent('hi')), new AbortController().signal)).not.toBeNull()
    await harness.ctx.serial('session/event', sessionFixture('session-1'), userMessageEvent(webhookSource))
    await harness.ctx.serial('session/event', sessionFixture('session-1'), assistantMessageEvent([
      { type: 'reasoning', text: 'hidden' },
      { type: 'text', text: 'line one' },
      { type: 'text', text: 'line two' },
    ]))
    await vi.waitFor(() => { expect(sends).toHaveLength(1) })
    expect(JSON.parse(bodyText(sends[0]?.init))).toEqual({
      receive_id: 'oc-1',
      msg_type: 'text',
      content: JSON.stringify({ text: 'line one\nline two' }),
    })
    harness.disposeChannel()
  })

  it('sends nothing without a bound webhook user message', async () => {
    const { fetchImpl, sends } = recordingFetch()
    const harness = channelHarness(fetchImpl)
    await harness.ctx.serial('session/event', sessionFixture('session-1'), assistantMessageEvent([
      { type: 'text', text: 'unbound' },
    ]))
    await harness.ctx.serial('session/event', sessionFixture('session-1'), userMessageEvent({
      ...webhookSource,
      provider: 'github',
    }))
    expect(sends).toHaveLength(0)
  })

  it('sends no message for textless assistant steps and keeps the queue usable after failures', async () => {
    let failSends = true
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('tenant_access_token')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'token-1', expire: 7200 }), { status: 200 })
      }
      if (failSends) return new Response(JSON.stringify({ code: 230001, msg: 'chat not found' }), { status: 200 })
      return new Response(JSON.stringify({ code: 0 }), { status: 200 })
    }
    const harness = channelHarness(fetchImpl)
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    expect(harness.rule.run(delivery(textEvent('hi')), new AbortController().signal)).not.toBeNull()
    await harness.ctx.serial('session/event', sessionFixture('session-1'), userMessageEvent(webhookSource))
    await harness.ctx.serial('session/event', sessionFixture('session-1'), assistantMessageEvent([
      { type: 'tool-call', text: 'ignored' },
    ]))
    await harness.ctx.serial('session/event', sessionFixture('session-1'), assistantMessageEvent([
      { type: 'text', text: 'will fail' },
    ]))
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('reply to "oc-1" failed')) })
    failSends = false
    await harness.ctx.serial('session/event', sessionFixture('session-1'), assistantMessageEvent([
      { type: 'text', text: 'will succeed' },
    ]))
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledOnce() })
    harness.disposeChannel()
  })

  it('removes the rule with the channel disposer', () => {
    const harness = channelHarness(recordingFetch().fetchImpl)
    harness.disposeChannel()
    expect(harness.removeRule).toHaveBeenCalledOnce()
  })
})
