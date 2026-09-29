/** Feishu event values projected after signature verification. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Verified Feishu JSON object. Event-specific field validation belongs to each rule. */
export type FeishuJsonObject = { readonly [key: string]: JsonValue }

/** Provider event supplied to `WebhookRule<'feishu'>`. */
export interface FeishuWebhookEvent {
  /** Raw Feishu event type such as `im.message.receive_v1`, or `url_verification`. */
  readonly name: string
  /** Verified JSON object exactly as parsed from the request body. */
  readonly payload: FeishuJsonObject
}

declare module '@deepseek-ai/dsh-webhook' {
  interface WebhookEventMap {
    feishu: FeishuWebhookEvent
  }
}
