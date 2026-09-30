# Agent Note：飞书通道规则与出站回复

Status: proposed

[English](2026-09-30-feishu-channel-rule-and-replies.md) | 中文

## Problem

飞书适配器只把经认证的 JSON 交给运行时。没有规则，每条飞书消息在 dispatch 处即死；没有出站发送方，创建的 Session 永远无法回复聊天，因此仅适配器构不成可用通道。

[适配器 note](2026-09-30-feishu-webhook-adapter.zh.md)曾把规则与回复划给"消费它的通道插件"，但这样的插件并不存在，而需要这条通道的部署想要的是挂载即用的一个插件，而不是默认路径上强制的第二个包。

## Proposal

把通道放进 `dsh-webhook-feishu`：在同一插件 fiber 里注册 `ctx.webhookRuntime` 上的一条受信规则，外加一个 `session/event` 监听器。

规则只服务自身配置的 source、只处理 p2p 聊天、只处理 `message_type` 为 `text` 的消息。它解析飞书的 JSON 字符串 `content`、拒绝空文本、在有界 FIFO 窗口内按 `event_id` 去重、把投递绑定到 `chat_id`，并返回一个 Session 请求：workspace、预设与可选 model 来自插件配置。

监听器在首条 `user/message` 事件携带本适配器 webhook source 时把 Session 重新绑定到聊天，然后把每条非空 `assistant/message` 文本经出站发送方送到飞书 IM 发送 API；发送方以单飞方式缓存 `tenant_access_token` 并带单请求超时。

### 被取代的范围边界

本决策取代适配器 note 的范围边界及其"反对内置"的备选记录。接缝分离在关键处保留：HTTP 适配器仍只保证经认证的通用 JSON，规则仍是部署可替换的普通 `WebhookRule`；内置只改变默认由谁注册它。

## Alternatives considered

- 独立的 `webhook-feishu-channel` 包 —— 否决，因为两半共享配置、凭据引用与生命周期，拆开会让每个部署挂两个插件才得到一条可用通道。

- 复用投递载荷做回复路由而不经首条 `user/message` 事件绑定 —— 否决，因为运行时不保存 delivery 到 Session 的关联，而持久化消息 source 已记录投递身份。

- 只回复每个 turn 的最终 assistant 消息 —— 否决，因为判定 turn 结束需要跨取消与释放的 flush 记账；发送每条非空 assistant 文本不丢内容，且让泵对单条消息保持无状态。

## Acceptance criteria

- 包通过类型检查，vitest 全绿并完整覆盖规则、绑定、泵与发送方的行、分支与函数。

- 非 p2p、非文本、畸形与重投递消息不创建 Session；p2p 文本消息创建一个带配置 workspace、预设、标题与 prompt 的请求。

- 已绑定 Session 的 assistant 文本恰好向绑定聊天发送一条飞书文本消息；未绑定 Session 与无文本步骤不发送。

- token 缓存在并发发送下只取一次，并在刷新后的过期点之后重新获取。

## Risks

- 通道状态仅存内存，重启即丢回复路由；重启后用户需要重新向机器人发消息。

- 超过去重窗口的飞书重推可能造成重复 Session；窗口以有界保证换取内存上限。
