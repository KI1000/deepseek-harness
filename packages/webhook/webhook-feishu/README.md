---
description: "Signed Feishu webhook adapter for deployments routing authenticated JSON events into the webhook runtime."
kind: "package-reference"
---

# @deepseek-ai/dsh-webhook-feishu

English | [中文](README.zh.md)

## Summary

`dsh-webhook-feishu` registers one exact HTTP route on the injected `ctx.webServer`. It bounds the raw JSON body, verifies Feishu tokens (optionally decrypting AES-256-CBC payloads), echoes `url_verification` challenges, projects a provider-neutral delivery, calls `ctx.webhookRuntime.dispatch()`, and returns `200` without waiting for rules or Sessions. Use it when a deployment needs authenticated Feishu ingress for the generic webhook runtime.

## Table of Contents

- [Configuration](#configuration)
- [HTTP contract](#http-contract)
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

Only `source`, `path`, `tokenEnv`, and `maxBodyBytes` are required. Credential references are resolved for every request, so rotation affects the next delivery without reloading the plugin.

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

<a id="dedicated-listener-composition"></a>
## Dedicated listener composition

The normal Web profile already owns `ctx.webServer`. Mount another `dsh-host-webserver` and this adapter inside a group that isolates only `webServer`; the adapter still inherits credentials and `webhookRuntime`. Serve the route behind a TLS reverse proxy while the UI remains on its own port.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-webhook`: this adapter contributes no prompt or tool schema; a matching rule owns the Session request and model-visible text.

#### KV Cache effect

Independent. Token verification, decryption, and HTTP dispatch do not touch a model request; any new Session prefix belongs to the consuming rule and runtime.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No TLS** — the injected development WebServer is normally loopback-only behind a TLS reverse proxy or tunnel.
- **v2.0 events only** — payloads without a v2.0 `header` object are rejected; v1 callback formats are out of scope.
- **No bundled rule** — Session creation and outbound replies belong to consuming trusted rules and plugins.
- **No provider acknowledgement of downstream work** — `200` precedes arbitrary rule calls and Session creation.
- **No form encoding** — Feishu must send `application/json`; `application/x-www-form-urlencoded` is rejected.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Authentication and input validation occur at the exact HTTP operation; dsh-host-webserver owns route/disposer symmetry.
