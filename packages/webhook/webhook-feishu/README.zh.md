---
description: "面向外部传输的 DeepSeek Harness webhook 投递的飞书通道适配器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-webhook-feishu

[English](README.md) | 中文

## 概述

`dsh-webhook-feishu` 拥有飞书会话通道：受信规则把外部传输来的 `im.message.receive_v1` 投递投影成 Session 请求，`session/event` 监听器把 assistant 文本泵回原聊天。投递传输本身刻意不在本包范围内。请使用外部 ingress，例如飞书长连接适配器；本包既不监听 HTTP，也不需要公网回调地址。

## 目录

- [配置](#configuration)
- [飞书通道](#feishu-channel)
- [外部 ingress 契约](#external-ingress-contract)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="configuration"></a>
## 配置

| Key | Meaning |
|---|---|
| `source` | 传给规则的非空适配器实例名，例如 `primary-feishu`。 |
| `appIdEnv` | 保存飞书 app id 的凭据引用，用于出站回复。 |
| `appSecretEnv` | 保存飞书 app secret 的凭据引用，用于出站回复。 |
| `workspacePath` | 支撑每个飞书创建 Session 的绝对目录。 |
| `agentPreset` | 发布前应用的 Agent 组合预设。 |
| `permissionPreset` | prompt 受理前应用的权限预设。 |
| `titlePrefix` | 可选的 Session 标题前缀；默认为 `Feishu`。 |
| `botName` | 可选的飞书机器人显示名；群聊 prompt 会移除匹配的 mention 占位符。 |
| `model` | 可选的显式 `provider`/`model` 路由，可带 `maxTokens`；缺省使用当前默认。 |

除 `titlePrefix`、`botName` 和 `model` 外的字段都是必需的。凭据引用会在出站发送方换取 tenant token 时解析，因此轮换凭据会影响下一次发送。

<a id="feishu-channel"></a>
## 飞书通道

受信规则 `webhook-feishu:<source>` 只处理来自自身配置 source 的 `im.message.receive_v1` 投递，且只处理 p2p 文本消息，或群聊中 @ 机器人的文本消息。它解析 `content` JSON 字符串，把 mention 占位符替换为显示名，移除匹配可选 `botName` 的占位符，拒绝替换后没有可见文本的消息，在 512 条 FIFO 有界窗口内按 `event_id` 去重，把投递绑定到其 `chat_id`，并返回 Session 请求。聊天的第一条被接受消息创建其 Session；此后同一聊天的每条消息都会在该 Session 的 Agent 仍存活且未被归档时向同一 Session 追加。

一个 `session/event` 监听器把创建的 Session 绑回其聊天，然后把每条非空 `assistant/message` 文本以飞书文本消息的形式发送出去。发送按 Session 串行化，失败的发送只记录警告，不影响 Session。出站发送方用配置凭据换取 `tenant_access_token`，以单飞方式缓存并在飞书声明过期前一分钟刷新，每次出站 HTTP 交换有 15 秒超时上限。

<a id="external-ingress-contract"></a>
## 外部 ingress 契约

传输适配器必须派发一个经过验证的 `feishu` delivery，携带稳定 `deliveryId`、飞书事件名，以及包含 `event.message` 的 v2.0 payload。它拥有连接生命周期、重连和传输层重试。通道只拥有规则校验、去重、Session 连续性和出站回复。

<a id="model-experience"></a>
## 模型体验

间接，通过 `dsh-webhook`：本包不贡献提示词或工具 schema；内置规则拥有每个 Session 请求、模型路由和回复文本。

#### KV Cache effect

无关。传输派发不触碰模型请求；任何新 Session 前缀属于运行时和内置规则的配置。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **仅支持文本** —— 非文本消息和卡片交互不会创建 Session。
- **通道状态仅存内存** —— 去重窗口以及 delivery/Session/chat 绑定都存在进程内存中；重启后路由与连续性会丢失。
- **连续性仅限进程内** —— 只有当绑定的 Agent 仍存活且未归档时聊天才继续其 Session。
- **每段非空 assistant 文本都会发送** —— 多步 turn 的每一步文本都会作为独立飞书消息送达。
- **不校验发送者身份** —— 接受的 p2p 文本和平台投递的群内 @ 文本都会创建 Session；触达范围由飞书应用控制。
