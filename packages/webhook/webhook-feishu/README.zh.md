---
description: "面向需要把经认证的 JSON 事件接入 webhook 运行时的部署的签名飞书 webhook 适配器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-webhook-feishu

[English](README.md) | 中文

## Summary

`dsh-webhook-feishu` 在注入的 `ctx.webServer` 上注册一个精确 HTTP 路由。它限制原始 JSON 请求体大小、校验飞书 token（可选解密 AES-256-CBC 载荷）、回显 `url_verification` challenge、投影出提供方中立的事件、调用 `ctx.webhookRuntime.dispatch()`，并返回 `200` 而不等待规则或 Session。同一插件还内置飞书通道：一条受信规则把每条 p2p 文本消息转成 Session 请求，一个 session/event 监听器把 assistant 文本泵回原聊天。当部署需要为通用 webhook 运行时提供经认证的飞书入口以及一个可用的聊天通道时使用它。

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
| `source` | 传给规则的非空适配器实例名，例如 `primary-feishu`。 |
| `path` | 精确的非根路径名，不带结尾斜杠、query 或 fragment。 |
| `tokenEnv` | 保存飞书 verification token 的凭据引用。 |
| `encryptKeyEnv` | 可选的保存飞书 encrypt key 的凭据引用。 |
| `maxBodyBytes` | 未处理请求体的正安全整数上限。 |
| `appIdEnv` | 保存飞书 app id 的凭据引用，用于出站回复。 |
| `appSecretEnv` | 保存飞书 app secret 的凭据引用，用于出站回复。 |
| `workspacePath` | 支撑每个飞书创建 Session 的绝对目录。 |
| `agentPreset` | 发布前应用的 Agent 组合预设。 |
| `permissionPreset` | prompt 受理前应用的权限预设。 |
| `titlePrefix` | 可选的 Session 标题前缀；默认为 `Feishu`。 |
| `model` | 可选的显式 `provider`/`model` 路由，可带 `maxTokens`；缺省使用当前默认。 |

只有 `source`、`path`、`tokenEnv`、`maxBodyBytes`、`appIdEnv`、`appSecretEnv`、`workspacePath`、`agentPreset` 和 `permissionPreset` 是必需的。凭据引用在每次请求或换取 token 时解析，因此轮换凭据会影响下一次使用，而无需重新加载插件。

<a id="http-contract"></a>
## HTTP contract

只接受 `POST application/json`。适配器读取有界 UTF-8 请求体、解析顶层 JSON 对象，并在应答前解析 verification token 凭据。`type` 为 `url_verification` 的载荷在 token 校验通过后回显其 `challenge`，永不投递。带字符串 `encrypt` 字段的载荷先按飞书的方案解密（SHA-256 派生密钥、AES-256-CBC、16 字节 IV 前缀），再走同样处理。其余载荷必须携带 v2.0 `header` 对象，其中包含 `event_id`、`event_type` 和 `token`；token 在投递前用长度安全的常数时间比较。它从不记录 token、密钥或载荷。

| Status | Meaning |
|---|---|
| `200` | challenge 已回显，或已验证的事件已在内存中投递。 |
| `400` | 请求体、JSON、header 字段或 challenge 非法。 |
| `401` | token 不匹配或解密失败。 |
| `405` | 方法不是 `POST`。 |
| `413` | 声明或流式请求体超过 `maxBodyBytes`。 |
| `415` | 媒体类型不是 `application/json`。 |
| `503` | 凭据或 webhook 运行时不可用。 |

`200` 不表示任何规则匹配或 Session 已创建。飞书事件的具体字段校验属于每条规则；适配器只保证经认证的通用 JSON。

<a id="feishu-channel"></a>
## Feishu channel

内置受信规则 `webhook-feishu:<source>` 只处理来自自身配置 source 的 `im.message.receive_v1` 投递，且只处理 `message_type` 为 `text` 的 p2p 聊天。它解析 `content` JSON 字符串、拒绝空文本、在 512 条 FIFO 有界窗口内按 `event_id` 去重、把投递绑定到其 `chat_id`，并返回一个 Session 请求：workspace、预设和可选 model 来自配置，prompt 是原始消息文本。Session 标题为 `<titlePrefix>: <消息文本标题化的前 48 字符>`。

一个 `session/event` 监听器在首条 `user/message` 事件携带本适配器的 webhook source 时把创建的 Session 绑回其聊天，然后把每条非空 `assistant/message` 文本以飞书文本消息的形式发送到 `POST /open-apis/im/v1/messages?receive_id_type=chat_id`。发送按 Session 串行化，失败的发送只记录警告，不影响 Session。

出站发送方用 `appIdEnv` 和 `appSecretEnv` 凭据换取 `tenant_access_token`，以单飞方式缓存并在飞书声明过期前一分钟刷新，每次出站 HTTP 交换有 15 秒超时上限。

<a id="dedicated-listener-composition"></a>
## Dedicated listener composition

常规 Web profile 已拥有 `ctx.webServer`。在只隔离 `webServer` 的分组里挂载另一个 `dsh-host-webserver` 和本适配器；适配器仍继承 credentials 和 `webhookRuntime`。将该路由置于 TLS 反向代理之后，UI 保持独立端口。

<a id="model-experience"></a>
## Model Experience

间接地，通过 `dsh-webhook`：本包不贡献提示词或工具 schema；内置规则拥有每个 Session 请求、模型路由和回复文本。

#### KV Cache effect

无关。token 校验、解密和 HTTP 投递不触碰模型请求；任何新 Session 前缀属于运行时和内置规则的配置。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **无 TLS** —— 注入的开发用 WebServer 通常仅回环，位于 TLS 反向代理或隧道之后。
- **仅支持 v2.0 事件** —— 不带 v2.0 `header` 对象的载荷会被拒绝；v1 回调格式不在范围内。
- **通道状态仅存内存** —— 去重窗口和 delivery→chat、session→chat 绑定都存在进程内存中；重启后回复路由与去重历史丢失。
- **仅 p2p 文本** —— 群聊、非文本消息和卡片交互不会创建 Session。
- **每条消息一个 Session** —— 每条被接受的消息都创建全新 Session，聊天在消息之间没有对话记忆。
- **每段非空 assistant 文本都会发送** —— 多步 turn 的每一步文本都会作为独立飞书消息送达。
- **不校验发送者身份** —— 适配器接受的每条 p2p 文本都会创建 Session；部署通过飞书应用可用范围与网络暴露面限制触达。
- **不确认下游工作** —— `200` 先于任意规则调用和 Session 创建。
- **不接受表单编码** —— 飞书必须发送 `application/json`；`application/x-www-form-urlencoded` 会被拒绝。


<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。认证与输入校验发生在精确的 HTTP 操作处，内置规则拥有飞书消息校验，dsh-host-webserver 拥有路由/释放对称性。
