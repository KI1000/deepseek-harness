# Agent Note：飞书 webhook 提供方适配器

Status: proposed

[English](2026-09-30-feishu-webhook-adapter.md) | 中文

## Problem

IM 入口必须把一条操作者消息变成一个 dsh Session。

通用 webhook 运行时拥有规则投递与基于 Workspace 的 Session 创建，`dsh-webhook-github` 已验证了提供方适配器的形状。

目前不存在飞书适配器，因此飞书事件订阅无法到达该运行时。

## Proposal

新增 `packages/webhook/webhook-feishu`，作为镜像 `dsh-webhook-github` 的提供方适配器。

适配器在注入的 `ctx.webServer` 上注册一个精确路由，读取有界 UTF-8 请求体，并用长度安全的常数时间比较校验飞书 verification token。

可选的 encrypt key 启用飞书的 AES-256-CBC 载荷解密（SHA-256 派生密钥、16 字节 IV 前缀）。

`type` 为 `url_verification` 的载荷在 token 校验后回显 challenge，永不投递。

其余载荷必须携带包含 `event_id`、`event_type`、`token` 的 v2.0 header，并以 `VerifiedWebhookDelivery<'feishu'>` 投递。

本包不内置规则；消费它的受信规则拥有 Session 请求与出站回复。

### Scope boundary

回写到飞书聊天的出站投递不属于本适配器。

它属于注册规则并跟随 Session 事件的消费方通道插件。

## Alternatives considered

- 新建自带服务定义的 `channel` 包分组——拒绝，因为 architecture 扩展表已经把外部 webhook 入口指定为 `ctx.webhookRuntime` 加提供方适配器，且 webhook 分组已拥有该形状。

- 把建 Session 规则与飞书回复客户端捆绑进本适配器——拒绝，因为适配器只保证经认证的通用 JSON，而规则拥有模型可见请求，拆分让适配器可替换、规则可测试。

- 用长轮询替代 webhook 入口——拒绝，因为飞书事件订阅是推送式，而运行时的投递契约是 fire-and-forget。

## Acceptance criteria

- 本包通过类型检查，vitest 套件以 100% 行、语句、分支、函数覆盖率通过。

- `url_verification` 在 token 校验后回显 challenge 且永不投递。

- 合法 v2.0 事件以 header 中的 event id 投递 `kind: 'feishu'`，加密载荷先解密再走同样处理。

- 非法 token、畸形 header、超限请求体与不支持的编码应答 400/401/413/415 且不投递。

## Risks

- 飞书的重试重投可能创建重复 Session，因为运行时不做投递去重，规则必须以 `deliveryId` 为键。

- 适配器只信任配置的 verification token，一旦泄露任何人都能伪造事件，部署必须保管好凭据并让路由位于 TLS 之后。
