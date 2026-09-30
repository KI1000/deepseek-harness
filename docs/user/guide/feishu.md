# Answer Feishu messages with Sessions

English | [中文](feishu.zh.md)

This opt-in overlay adds a signed Feishu endpoint to `dsh web`. Every p2p text message the Feishu app delivers to that endpoint creates a titled root Session in the configured workspace, and each non-empty assistant text returns to the chat as a Feishu text message.

## Prerequisites

- A Feishu custom app with bot capability whose `app_id`, `app_secret`, and verification token are available through the `DSH_FEISHU_APP_ID`, `DSH_FEISHU_APP_SECRET`, and `DSH_FEISHU_VERIFICATION_TOKEN` credential references.
- An event subscription to `im.message.receive_v1` that delivers `application/json` to a public URL.
- The bot permission that sends messages into chats, so replies can be delivered.
- A TLS reverse proxy or tunnel that forwards that public URL to the loopback listener.

The overlay defaults the Session workspace to the launch directory and the listener to `127.0.0.1:3082`. Override them with `DSH_FEISHU_WORKSPACE` and `DSH_FEISHU_WEBHOOK_PORT`, and override the preset pair with `DSH_FEISHU_AGENT_PRESET` and `DSH_FEISHU_PERMISSION_PRESET`.

## Start DSH

`DSH_`-prefixed names are bootstrap-only, so dsh refuses them in a `.env` file. Export the channel settings in the launching environment instead:

```sh
export DSH_FEISHU_WORKSPACE=/path/to/seller-workspace
export DSH_FEISHU_PERMISSION_PRESET=workspace-write
```

From a development checkout:

```sh
pnpm dsh web --patch apps/cli/config/examples/feishu/cordis.yml
```

An installed DSH uses the same overlay through an absolute path:

```sh
dsh web --patch /absolute/path/to/feishu/cordis.yml
```

For a permanent profile, append the rows from `cordis.yml` to `$DSH_HOME/profiles/web/cordis.patch.yml` and start with `dsh web`. The shipped CLI already contains the webhook runtime and the Feishu channel package, so the rows alone activate them. A profile layer may hard-code this machine's workspace, port, and presets instead of the `!!js` environment defaults.

## Expose the dedicated endpoint

The main Web UI and `/api` remain on port 3080. The overlay mounts a second WebServer in an isolated realm; only `POST /webhook/feishu` is registered there, and every other path returns `404`. A Caddy configuration can expose only that listener:

```caddyfile
hooks.example.com {
  route {
    @feishu path /webhook/feishu
    reverse_proxy @feishu 127.0.0.1:3082
    respond 404
  }
}
```

Configure the Feishu app with:

```text
Request URL: https://hooks.example.com/webhook/feishu
Events:      im.message.receive_v1
Token:       DSH_FEISHU_VERIFICATION_TOKEN value
Encrypt key: optional; set encryptKeyEnv on the adapter row when the app encrypts events
```

## Rule behavior

The bundled rule serves only its configured source, only `p2p` chats, and only `text` messages. It parses Feishu's JSON-string `content`, rejects empty text, deduplicates `event_id` in a bounded in-memory window, and returns a Session request whose workspace, presets, title, and prompt come from plugin configuration. Group chats, non-text messages, and redelivered events create no Session. The first accepted message of a chat creates its Session; later messages from that chat continue the same Session while its Agent is live and unarchived, so a chat keeps one conversation.

A delivery binds to its chat when the created Session's first `user/message` event carries this adapter's webhook source, so replies follow the chat that started the Session.

## Answering the chat

Every non-empty assistant text of a bound Session posts one Feishu text message to that chat through `POST /open-apis/im/v1/messages?receive_id_type=chat_id`. The sender caches `tenant_access_token` with single-flight refresh, refreshes it a minute before its stated expiry, and bounds each request with a fifteen-second timeout. A failed reply is logged and never blocks the Session.

## Known limitations

- The deduplication window and both binding tables live in process memory, so a restart drops reply routing and dedup history; re-message the bot after a restart.
- A Feishu retry that arrives after the deduplication window passes creates another Session.
- Continuity is process-local: a chat continues its bound Session while that Agent is live and unarchived, so a restart or an archived Session starts a fresh one.
- Every non-empty assistant text sends its own message, so a multi-step turn arrives as several Feishu messages.
- The listener serves plain HTTP; TLS belongs to the reverse proxy or tunnel in front of it.
- The adapter accepts events only in the v2.0 `header` shape and only as `application/json`.

## Delivery semantics

The webhook runtime stores no delivery or execution state. A `200` answer means the verification token matched and the payload dispatched in memory; it does not mean the rule matched or that a Session was created. A crash loses dispatches whose prompt was never admitted.

The verification token and the app secret authenticate Feishu ingress and replies only. They grant the created Agent no Feishu or seller-platform authority; configure that authority separately.
