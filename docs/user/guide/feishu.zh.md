# 通过飞书消息创建会话

[English](feishu.md) | 中文

此可选 overlay 会为 `dsh web` 增加一个签名飞书端点。飞书应用投递到该端点的每条 p2p 文本消息都会在已配置 workspace 中创建一个带标题的根 Session，而每段非空 assistant 文本都会以飞书文本消息回到对应会话。

## 前置条件

- 一个具备机器人能力的飞书自建应用，其 `app_id`、`app_secret` 与 verification token 可通过 `DSH_FEISHU_APP_ID`、`DSH_FEISHU_APP_SECRET` 与 `DSH_FEISHU_VERIFICATION_TOKEN` 凭据引用访问。
- 订阅 `im.message.receive_v1` 事件，并以 `application/json` 投递到公共 URL。
- 允许机器人向会话发送消息的权限，以便投递回复。
- 一个可把该公共 URL 转发到 loopback 监听器的 TLS 反向代理或 tunnel。

overlay 默认使用启动目录作为 Session workspace，并监听 `127.0.0.1:3082`。可通过 `DSH_FEISHU_WORKSPACE` 与 `DSH_FEISHU_WEBHOOK_PORT` 覆盖它们，并通过 `DSH_FEISHU_AGENT_PRESET` 与 `DSH_FEISHU_PERMISSION_PRESET` 覆盖 preset 组合。

## 启动 DSH

`DSH_` 前缀的名称属于 bootstrap-only，dsh 会拒绝把它们写进 `.env` 文件。请在启动环境中导出这些通道设置：

```sh
export DSH_FEISHU_WORKSPACE=/path/to/seller-workspace
export DSH_FEISHU_PERMISSION_PRESET=workspace-write
```

在开发 checkout 中运行：

```sh
pnpm dsh web --patch apps/cli/config/examples/feishu/cordis.yml
```

安装版 DSH 通过绝对路径使用同一 overlay：

```sh
dsh web --patch /absolute/path/to/feishu/cordis.yml
```

对于永久 profile，把 `cordis.yml` 中的行追加到 `$DSH_HOME/profiles/web/cordis.patch.yml`，然后运行 `dsh web`。随附 CLI 已经包含 webhook runtime 与飞书通道包；只需这些行即可激活它们。profile 层也可以直接写死本机的 workspace、端口与 preset，而不使用 `!!js` 环境默认值。

## 暴露专用端点

主 Web UI 与 `/api` 继续位于端口 3080。overlay 会在隔离 realm 中挂载第二个 WebServer；其中只注册 `POST /webhook/feishu`，其他路径均返回 `404`。Caddy 配置可以只暴露该监听器：

```caddyfile
hooks.example.com {
  route {
    @feishu path /webhook/feishu
    reverse_proxy @feishu 127.0.0.1:3082
    respond 404
  }
}
```

飞书应用配置如下：

```text
Request URL: https://hooks.example.com/webhook/feishu
Events:      im.message.receive_v1
Token:       DSH_FEISHU_VERIFICATION_TOKEN value
Encrypt key: optional; set encryptKeyEnv on the adapter row when the app encrypts events
```

## 规则行为

该内置规则只服务它已配置的来源、只处理 `p2p` 会话、只处理 `text` 消息。它会解析飞书以 JSON 字符串承载的 `content`，拒绝空文本，在有界内存窗口中对 `event_id` 去重，并返回一个 Session 请求：其中的 workspace、preset、标题与提示词都来自插件配置。群聊、非文本消息与重复投递的事件都不会创建 Session。

当所创建 Session 的首条 `user/message` 事件带有此 adapter 的 webhook source 时，该次投递便会绑定到对应会话，因此回复会跟随发起该 Session 的会话。

## 回复会话

已绑定 Session 的每段非空 assistant 文本都会通过 `POST /open-apis/im/v1/messages?receive_id_type=chat_id` 向该会话发送一条飞书文本消息。发送方以 single-flight 刷新缓存 `tenant_access_token`，在其声明的过期时间前一分钟刷新，并为每次请求设置十五秒超时。发送失败只记录日志，绝不阻塞 Session。

## 已知限制

- 去重窗口与两张绑定表都只存在于进程内存，因此重启会丢失回复路由与去重历史；重启后需重新给机器人发消息。
- 在去重窗口之外到达的飞书重运会创建另一个 Session。
- 每条被接受的消息都会创建全新的 Session，因此同一会话在多条消息之间没有对话记忆。
- 每段非空 assistant 文本都会单独发送一条消息，因此多步 turn 会以多条飞书消息到达。
- 监听器只提供明文 HTTP；TLS 由其前面的反向代理或 tunnel 负责。
- adapter 只接受 v2.0 `header` 形状的事件，且只接受 `application/json`。

## 投递语义

webhook runtime 不保存投递或执行状态。`200` 响应表示 verification token 匹配且负载已在内存中派发；它并不表示该规则已匹配，也不表示已创建 Session。崩溃会丢失尚未接纳提示词的派发。

verification token 与应用密钥只用于认证飞书入站与回复。它们不会赋予所创建 Agent 任何飞书或卖家平台权限；该权限需要单独配置。
