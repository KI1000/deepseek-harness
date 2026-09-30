/** Per-chat Session continuity: one chat keeps talking to its bound Session. */

import { Context } from '@deepseek-ai/cordis'
import {
  WebhookDeliveryId,
  WebhookSourceId,
  type VerifiedWebhookDelivery,
  type WebhookRule,
} from '@deepseek-ai/dsh-webhook'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFeishuChannel, type FeishuChannelConfig } from '../src/channel.ts'
import type { FeishuSender } from '../src/sender.ts'
import type { FeishuJsonObject, FeishuWebhookEvent } from '../src/types.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const config: FeishuChannelConfig = {
  source: 'primary',
  workspacePath: '/feishu-workspace',
  agentPreset: 'chat',
  permissionPreset: 'sandbox',
}

/** One agent whose follow-up calls the test records. */
function fakeAgent(): { agent: { followup: ReturnType<typeof vi.fn> }; followup: ReturnType<typeof vi.fn> } {
  const followup = vi.fn()
  return { agent: { followup }, followup }
}

interface Harness {
  ctx: Context
  rule: WebhookRule<'feishu'>
  followup: ReturnType<typeof vi.fn>
  sends: { chatId: string; text: string }[]
  bind: () => Promise<void>
}

/** Channel over a fake agents registry, archive set, and sender. */
function harness(options: { live?: boolean; archived?: boolean } = {}): Harness {
  const ctx = new Context()
  contexts.push(ctx)
  const { agent, followup } = fakeAgent()
  const live = new Map<string, unknown>()
  if (options.live !== false) live.set('session-1', agent)
  const archived = options.archived === true ? ['session-1'] : []
  ctx.provide('agents', { get: (id: string) => live.get(id) } as never)
  ctx.provide('workspaceRegistry', { archivedSessionIds: archived } as never)
  const removeRule = vi.fn(async () => {})
  const registerRule = vi.fn((_rule: WebhookRule<'feishu'>) => removeRule)
  ctx.provide('webhookRuntime', { register: registerRule } as never)
  const sends: { chatId: string; text: string }[] = []
  const sender: FeishuSender = {
    sendText: async (chatId, text) => {
      sends.push({ chatId, text })
      return undefined
    },
  }
  createFeishuChannel(ctx, config, sender)
  const rule = registerRule.mock.calls[0]?.[0]
  if (rule === undefined) throw new Error('channel registered no rule')
  const bind = async (): Promise<void> => {
    await ctx.serial('session/event', { id: 'session-1' } as never, {
      type: 'user/message',
      seq: 1,
      time: 0,
      data: {
        role: 'user',
        id: 'm1',
        content: [],
        source: {
          kind: 'webhook',
          provider: 'feishu',
          source: 'primary',
          deliveryId: 'evt-1',
          ruleId: 'webhook-feishu:primary',
          form: 'notice',
          summary: 'feishu webhook handled',
        },
      },
    } as never)
  }
  return { ctx, rule, followup, sends, bind }
}

function delivery(event: FeishuWebhookEvent, id = 'evt-1'): VerifiedWebhookDelivery<'feishu'> {
  return {
    kind: 'feishu',
    source: WebhookSourceId('primary'),
    deliveryId: WebhookDeliveryId(id),
    event,
    receivedAt: 0,
  }
}

function textEvent(text: string, chatId = 'oc-1'): FeishuWebhookEvent {
  const fields: FeishuJsonObject = {
    chat_id: chatId,
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text }),
  }
  return {
    name: 'im.message.receive_v1',
    payload: { schema: '2.0', header: { event_id: 'evt-1' }, event: { message: fields } },
  }
}

const signal = new AbortController().signal

describe('Feishu channel continuity', () => {
  it('appends a later message from the same chat to its bound Session', async () => {
    const { rule, followup, bind } = harness()
    expect(rule.run(delivery(textEvent('first')), signal)).not.toBeNull()
    await bind()
    expect(rule.run(delivery(textEvent('second'), 'evt-2'), signal)).toBeNull()
    expect(followup).toHaveBeenCalledTimes(1)
    expect(followup.mock.calls[0]?.[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'second' }],
      source: {
        kind: 'webhook',
        provider: 'feishu',
        source: 'primary',
        deliveryId: 'evt-2',
        ruleId: 'webhook-feishu:primary',
        form: 'notice',
        summary: 'feishu webhook handled by webhook-feishu:primary',
      },
    })
  })

  it('still deduplicates a redelivery of a continued message', async () => {
    const { rule, followup, bind } = harness()
    expect(rule.run(delivery(textEvent('first')), signal)).not.toBeNull()
    await bind()
    expect(rule.run(delivery(textEvent('second'), 'evt-2'), signal)).toBeNull()
    expect(rule.run(delivery(textEvent('second'), 'evt-2'), signal)).toBeNull()
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('starts a new Session when the bound Agent is no longer live', async () => {
    const { rule, bind } = harness({ live: false })
    expect(rule.run(delivery(textEvent('first')), signal)).not.toBeNull()
    await bind()
    expect(rule.run(delivery(textEvent('second'), 'evt-2'), signal)).toMatchObject({
      title: 'Feishu: second',
      prompt: 'second',
    })
  })

  it('starts a new Session when the bound Session is archived', async () => {
    const { rule, followup, bind } = harness({ archived: true })
    expect(rule.run(delivery(textEvent('first')), signal)).not.toBeNull()
    await bind()
    expect(rule.run(delivery(textEvent('second'), 'evt-2'), signal)).not.toBeNull()
    expect(followup).not.toHaveBeenCalled()
  })

  it('keeps two chats on separate Sessions and answers the continued one', async () => {
    const harnessed = harness()
    const { rule, ctx, sends, bind } = harnessed
    expect(rule.run(delivery(textEvent('first')), signal)).not.toBeNull()
    await bind()
    expect(rule.run(delivery(textEvent('other chat', 'oc-2'), 'evt-3'), signal)).toMatchObject({ prompt: 'other chat' })
    expect(rule.run(delivery(textEvent('second'), 'evt-2'), signal)).toBeNull()
    await ctx.serial('session/event', { id: 'session-1' } as never, {
      type: 'assistant/message',
      seq: 2,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', id: 'm2', content: [{ type: 'text', text: 'answered' }], source: {} },
        stream: [],
      },
    } as never)
    await vi.waitFor(() => { expect(sends).toEqual([{ chatId: 'oc-1', text: 'answered' }]) })
  })
})
