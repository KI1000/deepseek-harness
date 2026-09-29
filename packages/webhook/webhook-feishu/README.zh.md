---
description: "面向需要把经认证的 JSON 事件接入 webhook 运行时的部署的签名飞书 webhook 适配器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-webhook-feishu

[English](README.md) | 中文

## Summary

`dsh-webhook-feishu` 在注入的 `ctx.webServer` 上注册一个精确 HTTP 路由。它限制原始 JSON 请求体大小、校验飞书 token（可选解密 AES-256-CBC 载荷）、回显 `url_verification` challenge、投影出提供方中立的事件、调用 `ctx.webhookRuntime.dispatch()`，并返回 `200` 而不等待规则或 Session。当部署需要为通用 webhook 运行时提供经认证的飞书入口时使用它。

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
| `source` | 传给规则的非空适配器实例名，例如 `primary-feishu`。 |
| `path` | 精确的非根路径名，不带结尾斜杠、query 或 fragment。 |
| `tokenEnv` | 保存飞书 verification token 的凭据引用。 |
| `encryptKeyEnv` | 可选的保存飞书 encrypt key 的凭据引用。 |
| `maxBodyBytes` | 未处理请求体的正安全整数上限。 |

只有 `source`、`path`、`tokenEnv` 和 `maxBodyBytes` 是必需的。凭据引用在每次请求时解析，因此轮换凭据会影响下一次投递，而无需重新加载插件。

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

<a id="dedicated-listener-composition"></a>
## Dedicated listener composition

常规 Web profile 已拥有 `ctx.webServer`。在只隔离 `webServer` 的分组里挂载另一个 `dsh-host-webserver` 和本适配器；适配器仍继承 credentials 和 `webhookRuntime`。将该路由置于 TLS 反向代理之后，UI 保持独立端口。

<a id="model-experience"></a>
## Model Experience

间接地，通过 `dsh-webhook`：本适配器不贡献提示词或工具 schema；匹配的规则拥有 Session 请求和模型可见文本。

#### KV Cache effect

无关。token 校验、解密和 HTTP 投递不触碰模型请求；任何新 Session 前缀属于消费它的规则和运行时。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **无 TLS** —— 注入的开发用 WebServer 通常仅回环，位于 TLS 反向代理或隧道之后。
- **仅支持 v2.0 事件** —— 不带 v2.0 `header` 对象的载荷会被拒绝；v1 回调格式不在范围内。
- **不内置规则** —— Session 创建与出站回复属于消费它的受信规则和插件。
- **不确认下游工作** —— `200` 先于任意规则调用和 Session 创建。
- **不接受表单编码** —— 飞书必须发送 `application/json`；`application/x-www-form-urlencoded` 会被拒绝。


<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。认证与输入校验发生在精确的 HTTP 操作处；dsh-host-webserver 拥有路由/释放对称性。
