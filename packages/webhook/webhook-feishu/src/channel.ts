
/** Feishu trusted rule, session binding, and outbound reply pump. */

import type { Context } from '@deepseek-ai/cordis'
import { WebhookRuleId, type VerifiedWebhookDelivery, type WebhookRule, type WebhookSessionRequest } from '@deepseek-ai/dsh-webhook'
import type {} from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import type { FeishuSender } from './sender.ts'
import type { FeishuJsonObject, FeishuWebhookEvent } from './types.ts'

/** Feishu event type that carries one inbound IM message. */
const MESSAGE_EVENT_TYPE = 'im.message.receive_v1'

/** Sessions derive titles from message text; keep titles scannable. */
const TITLE_TEXT_LIMIT = 48

/** FIFO capacity of the delivery deduplication window (Feishu retries recent events). */
const DEDUP_CAPACITY = 512

/** FIFO capacity of the delivery-to-chat and session-to-chat binding tables. */
const BINDING_CAPACITY = 512

/** Channel facts and Session-request fields shared by the rule and the reply pump. */
export interface FeishuChannelConfig {
  /** Adapter instance this channel serves; rules ignore deliveries from other sources. */
  readonly source: string
  /** Absolute workspace directory backing every Feishu-created Session. */
  readonly workspacePath: string
  /** Agent composition preset applied before publication. */
  readonly agentPreset: string
  /** Permission preset applied before prompt admission. */
  readonly permissionPreset: string
  /** Session title prefix; defaults to `Feishu`. */
  readonly titlePrefix?: string
  /** Optional explicit model route forwarded verbatim to the runtime. */
  readonly model?: WebhookSessionRequest['model']
}

/** Insert into a FIFO-bounded map, evicting the oldest entry past capacity. */
function boundedSet<V>(map: Map<string, V>, key: string, value: V, capacity: number): void {
  map.set(key, value)
  if (map.size > capacity) {
    const oldest = map.keys().next()
    if (!oldest.done) map.delete(oldest.value)
  }
}

/** Return one JSON-object value, or undefined for every other JSON shape. */
function asObject(value: unknown): FeishuJsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as FeishuJsonObject
    : undefined
}

/** Return one object field of a verified payload, or undefined. */
function objectField(payload: FeishuJsonObject, field: string): FeishuJsonObject | undefined {
  return asObject(payload[field])
}

/** Return one string field of a verified payload, or undefined. */
function stringField(record: FeishuJsonObject, field: string): string | undefined {
  const value = record[field]
  return typeof value === 'string' ? value : undefined
}

/** Replace Feishu mention placeholders with their display names. */
function mentionText(text: string, mentions: unknown): string | undefined {
  if (!Array.isArray(mentions)) return text
  let withoutMentionKeys = text
  for (const raw of mentions) {
    const mention = asObject(raw)
    if (mention === undefined) continue
    const key = stringField(mention, 'key')
    if (key === undefined || key === '') continue
    const name = stringField(mention, 'name') ?? ''
    text = text.split(key).join(name)
    withoutMentionKeys = withoutMentionKeys.split(key).join('')
  }
  if (withoutMentionKeys.trim() === '') return undefined
  return text
}

/** Parse one Feishu `content` JSON string into its non-empty `text` value. */
function messageText(content: string, mentions?: unknown): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return undefined
  }
  const record = asObject(parsed)
  const text = record === undefined ? undefined : stringField(record, 'text')
  const unmentioned = text === undefined ? undefined : mentionText(text, mentions)
  return unmentioned !== undefined && unmentioned.trim() !== '' ? unmentioned : undefined
}

/** Collapse one message text into a bounded single-line title tail. */
function titleText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= TITLE_TEXT_LIMIT ? collapsed : `${collapsed.slice(0, TITLE_TEXT_LIMIT - 1)}…`
}

/** Join the text blocks of one assistant message, or undefined when it carries no visible text. */
function assistantText(
  message: { readonly content: ReadonlyArray<{ readonly type: string; readonly text?: unknown }> },
): string | undefined {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  const joined = parts.join('\n').trim()
  return joined === '' ? undefined : joined
}

/**
 * Create the Feishu channel over an injected webhook runtime: one trusted rule
 * turns each p2p text message and each bot-mentioned group text message into
 * a Session request, and one session/event listener binds created Sessions
 * back to their chats and pumps assistant text out through the sender. All
 * binding state is in-memory and bounded.
 * @param ctx - adapter context carrying the webhook runtime.
 * @param config - channel facts and Session-request fields.
 * @param sender - outbound Feishu text sender.
 * @returns a disposer that removes the rule and the session/event listener.
 */
export function createFeishuChannel(
  ctx: Context,
  config: FeishuChannelConfig,
  sender: FeishuSender,
): () => void {
  const deduplication = new Map<string, true>()
  const chatByDelivery = new Map<string, string>()
  const chatBySession = new Map<string, string>()
  const sessionByChat = new Map<string, SessionId>()
  const sendQueues = new Map<string, Promise<void>>()

  function enqueueSend(sessionId: string, chatId: string, text: string): void {
    const previous = sendQueues.get(sessionId) ?? Promise.resolve()
    const task: Promise<void> = previous
      .then(() => sender.sendText(chatId, text))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`webhook-feishu: reply to ${JSON.stringify(chatId)} failed: ${reason}`)
      })
      .finally(() => {
        if (sendQueues.get(sessionId) === task) sendQueues.delete(sessionId)
      })
    sendQueues.set(sessionId, task)
  }

  const ruleId = WebhookRuleId(`webhook-feishu:${config.source}`)

  /**
   * Append one inbound message to the chat's existing Session instead of
   * creating another one. Reuse needs the bound Agent to still be live and
   * its Session to be outside the archive set; anything else falls back to a
   * fresh Session so a chat never loses a message to a dead binding.
   * @param chatId - Feishu chat that sent the message.
   * @param delivery - exact verified delivery recorded in the message source.
   * @param text - parsed non-empty message text.
   * @returns whether the message was appended to the bound Session.
   */
  function followUpBoundSession(chatId: string, delivery: VerifiedWebhookDelivery<'feishu'>, text: string): boolean {
    const sessionId = sessionByChat.get(chatId)
    if (sessionId === undefined) return false
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) {
      ctx.logger.debug(`webhook-feishu: bound Session ${JSON.stringify(sessionId)} is not live`)
      return false
    }
    if (ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)) {
      ctx.logger.debug(`webhook-feishu: bound Session ${JSON.stringify(sessionId)} is archived`)
      return false
    }
    boundedSet(chatBySession, sessionId, chatId, BINDING_CAPACITY)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'webhook',
        provider: delivery.kind,
        source: delivery.source,
        deliveryId: delivery.deliveryId,
        ruleId,
        form: 'notice',
        summary: boundContextSummary(`${delivery.kind} webhook handled by ${ruleId}`),
      },
    }))
    return true
  }

  const rule: WebhookRule<'feishu'> = {
    id: ruleId,
    kind: 'feishu',
    run: (delivery) => {
      if (delivery.source !== config.source) return null
      const event: FeishuWebhookEvent = delivery.event
      if (event.name !== MESSAGE_EVENT_TYPE) return null
      const body = objectField(event.payload, 'event')
      const message = body === undefined ? undefined : objectField(body, 'message')
      if (message === undefined) {
        ctx.logger.debug(`webhook-feishu: ${JSON.stringify(delivery.deliveryId)} carried no event.message object`)
        return null
      }
      const chatType = stringField(message, 'chat_type')
      const isGroup = chatType === 'group'
      if (chatType !== 'p2p' && !isGroup) return null
      if (stringField(message, 'message_type') !== 'text') return null
      const mentions = message['mentions']
      if (isGroup && (!Array.isArray(mentions) || mentions.length === 0)) return null
      const chatId = stringField(message, 'chat_id')
      const content = stringField(message, 'content')
      if (chatId === undefined || chatId === '' || content === undefined) {
        ctx.logger.warn(`webhook-feishu: ${JSON.stringify(delivery.deliveryId)} ${chatType} text message lacked chat_id or content`)
        return null
      }
      const text = messageText(content, mentions)
      if (text === undefined) {
        ctx.logger.warn(`webhook-feishu: ${JSON.stringify(delivery.deliveryId)} text message content was unusable or carried no visible text`)
        return null
      }
      if (deduplication.has(delivery.deliveryId)) {
        ctx.logger.debug(`webhook-feishu: ${JSON.stringify(delivery.deliveryId)} is a redelivered event`)
        return null
      }
      boundedSet(deduplication, delivery.deliveryId, true, DEDUP_CAPACITY)
      boundedSet(chatByDelivery, delivery.deliveryId, chatId, BINDING_CAPACITY)
      if (followUpBoundSession(chatId, delivery, text)) return null
      return {
        workspacePath: config.workspacePath,
        title: `${config.titlePrefix ?? 'Feishu'}: ${titleText(text)}`,
        prompt: text,
        agentPreset: config.agentPreset,
        permissionPreset: config.permissionPreset,
        ...(config.model === undefined ? {} : { model: config.model }),
      } satisfies WebhookSessionRequest
    },
  }

  const listener = ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') {
      const source = event.data.source
      if (source.kind !== 'webhook' || source.provider !== 'feishu' || source.source !== config.source) return
      const chatId = chatByDelivery.get(source.deliveryId)
      if (chatId !== undefined) {
        boundedSet(chatBySession, session.id, chatId, BINDING_CAPACITY)
        boundedSet(sessionByChat, chatId, session.id, BINDING_CAPACITY)
      }
      return
    }
    if (event.type !== 'assistant/message') return
    const chatId = chatBySession.get(session.id)
    if (chatId === undefined) return
    const text = assistantText(event.data.message)
    if (text === undefined) return
    enqueueSend(session.id, chatId, text)
  })

  const disposeRule = ctx.webhookRuntime.register(rule)
  return () => {
    listener()
    void disposeRule()
  }
}
