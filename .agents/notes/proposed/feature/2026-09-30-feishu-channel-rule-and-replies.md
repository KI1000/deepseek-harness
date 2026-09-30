# Agent Note: Feishu channel rule and outbound replies

Status: proposed

English | [中文](2026-09-30-feishu-channel-rule-and-replies.zh.md)

## Problem

The Feishu adapter only carries authenticated JSON to the runtime. Without a rule, every Feishu message dies at dispatch; without an outbound sender, the created Session can never answer the chat, so the adapter alone is not a usable channel.

The [adapter note](2026-09-30-feishu-webhook-adapter.md) scoped rules and replies to "a consuming channel plugin", but no such plugin exists, and the deployment that needs this channel wants one plugin that works after mounting, not a mandatory second package for the default path.

## Proposal

Ship the channel inside `dsh-webhook-feishu`: one trusted rule registered on `ctx.webhookRuntime` plus one `session/event` listener created in the same plugin fiber.

The rule serves only its configured source, only p2p chats, and only `message_type` `text`. It parses Feishu's JSON-string `content`, rejects empty text, deduplicates `event_id` in a bounded FIFO window, binds delivery to `chat_id`, and returns a Session request whose workspace, presets, and optional model come from plugin configuration. A chat whose bound Session is still live and unarchived continues it through `ctx.agents.followup()` instead of creating another Session.

The listener re-binds a Session to its chat when the first `user/message` event carries this adapter's webhook source, then forwards each non-empty `assistant/message` text to Feishu's IM send API through a sender that caches `tenant_access_token` with single-flight refresh and a per-request timeout.

### Superseded scope boundary

This decision supersedes the adapter note's scope boundary and its rejected alternative against bundling. The seam separation survives where it matters: the HTTP adapter still guarantees only authenticated generic JSON, and the rule remains an ordinary `WebhookRule` that a deployment could replace; bundling only changes who registers it by default.

## Alternatives considered

- A separate `webhook-feishu-channel` package — rejected because the two halves share configuration, credential references, and lifecycle, and a split forces every deployment to mount two plugins to get one working channel.

- Reusing the delivery payload to route replies instead of binding through the first `user/message` event — rejected because the runtime keeps no delivery-to-Session association and the durable message source already records the delivery identity.

- Replying only with each turn's final assistant message — rejected because detecting turn end needs flush bookkeeping across cancellation and disposal; sending every non-empty assistant text loses no content and keeps the pump stateless per message.

## Acceptance criteria

- The package typechecks, and the vitest suite passes with full line, branch, and function coverage of the rule, binding, pump, and sender.

- Non-p2p, non-text, malformed, and redelivered messages create no Session; a p2p text message creates one request with the configured workspace, presets, title, and prompt.

- A later message from a chat whose bound Session is live and unarchived appends one `user/message` to that Session and creates no request.

- An assistant text for a bound Session posts exactly one Feishu text message to the bound chat; unbound sessions and textless steps send nothing.

- The token cache fetches once across concurrent sends and refetches past the refreshed expiry.

## Risks

- All channel state is memory-only, so a restart drops reply routing; deployed users must re-message the bot after a restart.

- Feishu retry windows longer than the dedup window can create duplicate Sessions; the window trades memory for a bounded guarantee.
