# Agent Note: Feishu webhook provider adapter

Status: proposed

English | [中文](2026-09-30-feishu-webhook-adapter.zh.md)

## Problem

An IM ingress must turn one operator message into one dsh Session.

The generic webhook runtime owns rule dispatch and Workspace-backed Session creation, and `dsh-webhook-github` proves the provider-adapter shape.

No Feishu adapter exists, so Feishu event subscriptions cannot reach the runtime.

## Proposal

Add `packages/webhook/webhook-feishu` as a provider adapter mirroring `dsh-webhook-github`.

The adapter registers one exact route on the injected `ctx.webServer`, reads a bounded UTF-8 body, and verifies the Feishu verification token with a length-safe constant-time comparison.

An optional encrypt key enables Feishu's AES-256-CBC payload decryption (SHA-256 key derivation, 16-byte IV prefix).

A payload whose type is `url_verification` echoes its challenge after token verification and never dispatches.

Every other payload must carry a v2.0 header with `event_id`, `event_type`, and `token`, and dispatches as `VerifiedWebhookDelivery<'feishu'>`.

The package ships no rule; a consuming trusted rule owns Session requests and outbound replies.

### Scope boundary

Outbound delivery back to Feishu chats stays outside this adapter.

It belongs to the consuming channel plugin that registers the rule and follows Session events.

## Alternatives considered

- A new `channel` package group with its own service definition — rejected because the architecture extension table already routes external webhook ingress through `ctx.webhookRuntime` plus a provider adapter, and the webhook group already owns that shape.

- Bundling the Session-creation rule and the Feishu reply client into this adapter — rejected because adapters guarantee authenticated generic JSON while rules own model-visible requests, and the split keeps the adapter replaceable and the rule testable.

- Long polling instead of webhook ingress — rejected because Feishu event subscription is push-based and the runtime dispatch contract is fire-and-forget.

## Acceptance criteria

- The package typechecks, and the vitest suite passes with 100% line, statement, branch, and function coverage.

- `url_verification` echoes the challenge after token verification and never dispatches.

- A valid v2.0 event dispatches `kind: 'feishu'` with the header event id, and an encrypted payload decrypts before the same treatment.

- Invalid tokens, malformed headers, oversized bodies, and unsupported encodings answer 400/401/413/415 without dispatch.

## Risks

- Feishu retry redelivery can create repeated Sessions because the runtime performs no delivery deduplication, so rules must key on `deliveryId`.

- The adapter trusts only the configured verification token, so a leaked token lets anyone forge events and deployments must keep the credential private and serve the route behind TLS.
