---
description: "Feishu channel adapter for externally transported DeepSeek Harness webhook deliveries."
kind: "package-reference"
---

# @deepseek-ai/dsh-webhook-feishu

English | [中文](README.zh.md)

## Summary

`dsh-webhook-feishu` owns the Feishu conversation channel: a trusted rule projects an externally transported `im.message.receive_v1` delivery into a Session request, and a `session/event` listener pumps assistant text back to the originating chat. Delivery transport is deliberately out of scope. Use an external ingress such as a Feishu long-connection adapter; the package neither listens on HTTP nor requires a public callback URL.

## Table of Contents

- [Configuration](#configuration)
- [Feishu channel](#feishu-channel)
- [External ingress contract](#external-ingress-contract)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration"></a>
## Configuration

| Key | Meaning |
|---|---|
| `source` | Non-empty adapter instance carried to rules, such as `primary-feishu`. |
| `appIdEnv` | Credential reference containing the Feishu app id used for outbound replies. |
| `appSecretEnv` | Credential reference containing the Feishu app secret used for outbound replies. |
| `workspacePath` | Absolute directory backing every Feishu-created Session. |
| `agentPreset` | Agent composition preset applied before publication. |
| `permissionPreset` | Permission preset applied before prompt admission. |
| `titlePrefix` | Optional Session title prefix; defaults to `Feishu`. |
| `botName` | Optional Feishu bot display name; matching group mention placeholders are removed from prompts. |
| `model` | Optional explicit `provider`/`model` route with optional `maxTokens`; omission uses the current default. |

All fields except `titlePrefix`, `botName`, and `model` are required. Credential references are resolved when the outbound sender exchanges them for a tenant token, so rotation affects the next send.

<a id="feishu-channel"></a>
## Feishu channel

The trusted rule `webhook-feishu:<source>` handles only `im.message.receive_v1` deliveries from its own configured source, and only text messages in p2p chats or bot-mentioned group chats. It parses the `content` JSON string, substitutes mention placeholders with display names, removes placeholders matching optional `botName`, rejects text that is empty after mention removal, deduplicates `event_id` values in a bounded 512-entry FIFO window, binds the delivery to its `chat_id`, and returns a Session request. The first accepted message of a chat creates its Session; later messages append to that Session while its Agent is live and the Session is unarchived.

A `session/event` listener binds each created Session back to its chat, then forwards every non-empty `assistant/message` text as a Feishu text message. Sends serialize per Session, and a failed send logs a warning without disturbing the Session. The sender exchanges the configured credentials for a `tenant_access_token`, caches it with single-flight refresh one minute ahead of Feishu's stated expiry, and bounds every outbound exchange with a 15-second timeout.

<a id="external-ingress-contract"></a>
## External ingress contract

The transport adapter must dispatch a verified `feishu` delivery with a stable `deliveryId`, the Feishu event name, and a v2.0 payload containing `event.message`. It owns connection lifecycle, reconnects, and transport-level retries. The channel owns only rule validation, deduplication, Session continuity, and outbound replies.

**Runtime invariant:** No companion is published because rule acceptance, Session binding, and reply serialization are observable through the webhook and Session contracts; the channel owns no additional mutable runtime relation.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-webhook`, this package contributes no prompt or tool schema; the bundled rule owns each Session request, model route, and reply text.

#### KV Cache effect

Independent. Transport dispatch does not touch a model request; any new Session prefix belongs to the runtime and the bundled rule's configuration.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **Text only** — non-text messages and card interactions create no Session.
- **Memory-only channel state** — deduplication and delivery/Session/chat bindings live in process memory; a restart loses routing and continuity.
- **Continuity is process-local** — a chat continues its bound Session only while that Agent is live and unarchived.
- **Every non-empty assistant text sends** — a multi-step turn delivers each step's text as its own Feishu message.
- **No sender identity checks** — accepted p2p text and platform-delivered @-bot group text create a Session; deployment reachability is controlled by the Feishu app.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
