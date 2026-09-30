---
description: "Signed Feishu webhook adapter for deployments routing authenticated JSON events into the webhook runtime."
kind: "package-reference"
---

# @deepseek-ai/dsh-webhook-feishu

English | [中文](README.zh.md)

## Summary

`dsh-webhook-feishu` registers one exact HTTP route on the injected `ctx.webServer`. It bounds the raw JSON body, verifies Feishu tokens (optionally decrypting AES-256-CBC payloads), echoes `url_verification` challenges, projects a provider-neutral delivery, calls `ctx.webhookRuntime.dispatch()`, and returns `200` without waiting for rules or Sessions. The same plugin also ships the Feishu channel: one bundled trusted rule turns each p2p text message into a Session request, and a session/event listener pumps assistant text back to the originating chat. Use it when a deployment needs authenticated Feishu ingress plus a working chat channel for the generic webhook runtime.

## Table of Contents

- [Configuration](#configuration)
- [HTTP contract](#http-contract)
- [Feishu channel](#feishu-channel)
- [Dedicated listener composition](#dedicated-listener-composition)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration"></a>
## Configuration

| Key | Meaning |
|---|---|
| `source` | Non-empty adapter instance carried to rules, such as `primary-feishu`. |
| `path` | Exact non-root pathname without trailing slash, query, or fragment. |
| `tokenEnv` | Credential reference containing the Feishu verification token. |
| `encryptKeyEnv` | Optional credential reference containing the Feishu encrypt key. |
| `maxBodyBytes` | Positive safe-integer ceiling for the untouched request body. |
| `appIdEnv` | Credential reference containing the Feishu app id used for outbound replies. |
| `appSecretEnv` | Credential reference containing the Feishu app secret used for outbound replies. |
| `workspacePath` | Absolute directory backing every Feishu-created Session. |
| `agentPreset` | Agent composition preset applied before publication. |
| `permissionPreset` | Permission preset applied before prompt admission. |
| `titlePrefix` | Optional Session title prefix; defaults to `Feishu`. |
| `model` | Optional explicit `provider`/`model` route with optional `maxTokens`; omission uses the current default. |

Only `source`, `path`, `tokenEnv`, `maxBodyBytes`, `appIdEnv`, `appSecretEnv`, `workspacePath`, `agentPreset`, and `permissionPreset` are required. Credential references are resolved per request or token acquisition, so rotation affects the next use without reloading the plugin.

<a id="http-contract"></a>
## HTTP contract

Only `POST application/json` is accepted. The adapter reads a bounded UTF-8 body, parses a top-level JSON object, and resolves the verification-token credential before answering. A payload whose `type` is `url_verification` is answered with its `challenge` after token verification and never dispatched. A payload with a string `encrypt` field is decrypted with Feishu's scheme (SHA-256 key derivation, AES-256-CBC, 16-byte IV prefix) before the same treatment. Every other payload must carry a v2.0 `header` object with `event_id`, `event_type`, and `token`; the token is compared with a length-safe constant-time comparison before dispatch. It never logs the token, key, or payload.

| Status | Meaning |
|---|---|
| `200` | Challenge echoed, or verified event dispatched in memory. |
| `400` | Body, JSON, header fields, or challenge were invalid. |
| `401` | Token mismatch or decryption failure. |
| `405` | Method was not `POST`. |
| `413` | Declared or streamed body exceeded `maxBodyBytes`. |
| `415` | Media type was not `application/json`. |
| `503` | Credential or webhook runtime was unavailable. |

`200` does not state that any rule matched or that a Session was created. Feishu event-specific field validation belongs to each rule; the adapter guarantees only authenticated generic JSON.

<a id="feishu-channel"></a>
## Feishu channel

The bundled trusted rule `webhook-feishu:<source>` handles only `im.message.receive_v1` deliveries from its own configured source, and only p2p chats whose `message_type` is `text`. It parses the `content` JSON string, rejects empty text, deduplicates `event_id` values in a bounded 512-entry FIFO window, binds the delivery to its `chat_id`, and returns a Session request whose workspace, presets, and optional model come from configuration and whose prompt is the raw message text. The Session title is `<titlePrefix>: <the first 48 title characters of the text>`.

A `session/event` listener binds each created Session back to its chat when the first `user/message` event carries this adapter's webhook source, then forwards every non-empty `assistant/message` text to `POST /open-apis/im/v1/messages?receive_id_type=chat_id` as a Feishu text message. Sends serialize per Session, and a failed send logs a warning without disturbing the Session.

The outbound sender exchanges the `appIdEnv` and `appSecretEnv` credentials for a `tenant_access_token`, caches it with single-flight refresh one minute ahead of Feishu's stated expiry, and bounds every outbound HTTP exchange with a 15-second timeout.

<a id="dedicated-listener-composition"></a>
## Dedicated listener composition

The normal Web profile already owns `ctx.webServer`. Mount another `dsh-host-webserver` and this adapter inside a group that isolates only `webServer`; the adapter still inherits credentials and `webhookRuntime`. Serve the route behind a TLS reverse proxy while the UI remains on its own port.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-webhook`: this package contributes no prompt or tool schema; the bundled rule owns each Session request, model route, and reply text.

#### KV Cache effect

Independent. Token verification, decryption, and HTTP dispatch do not touch a model request; any new Session prefix belongs to the runtime and the bundled rule's configuration.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No TLS** — the injected development WebServer is normally loopback-only behind a TLS reverse proxy or tunnel.
- **v2.0 events only** — payloads without a v2.0 `header` object are rejected; v1 callback formats are out of scope.
- **Memory-only channel state** — the deduplication window and the delivery-to-chat and session-to-chat bindings live in process memory; a restart loses reply routing and dedup history.
- **p2p text only** — group chats, non-text messages, and card interactions create no Session.
- **One Session per message** — every accepted message creates a fresh Session, so a chat carries no conversation memory across messages.
- **Every non-empty assistant text sends** — a multi-step turn delivers each step's text as its own Feishu message.
- **No sender identity checks** — every p2p text the adapter accepts creates a Session; deployments restrict reachability through the Feishu app availability and network exposure.
- **No provider acknowledgement of downstream work** — `200` precedes arbitrary rule calls and Session creation.
- **No form encoding** — Feishu must send `application/json`; `application/x-www-form-urlencoded` is rejected.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Authentication and input validation occur at the exact HTTP operation, the bundled rule owns Feishu message validation, and dsh-host-webserver owns route/disposer symmetry.
