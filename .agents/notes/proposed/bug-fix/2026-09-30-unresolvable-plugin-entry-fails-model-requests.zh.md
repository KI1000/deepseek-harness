# Agent Note：无法解析包身份的活跃插件条目会让每次模型请求失败

Status: proposed

[English](2026-09-30-unresolvable-plugin-entry-fails-model-requests.md) | 中文

## Problem

通过 overlay（`--patch`）或示例 `cordis.yml` 挂载一个 workspace 包，能让它被激活：Loader 解析到模块，`apply` 执行，路由与服务都能起来。但这不会让这份组合有能力*描述*它。`@deepseek-ai/dsh-base` 里默认开启的 `plugin-package-inventory-deepseek`，会在每次官方 DeepSeek 请求时解析**每一个活跃 Loader 条目**的包身份，并在遇到第一个解析不出的条目时抛错。

在一个新增了 `packages/webhook/webhook-feishu` 并从 overlay 挂载它的分支上，实测到的失败是：

```
plugin-package-inventory-deepseek: cannot resolve active package "@deepseek-ai/dsh-webhook-feishu"
  at PackageIdentityResolver.resolve (packages/llm/plugin-package-inventory-deepseek/src/index.ts:123)
  at async collectActivePluginPackages (packages/llm/plugin-package-inventory-deepseek/src/index.ts:178)
  at async Object.prepare (packages/llm/plugin-package-inventory-deepseek/src/index.ts:200)
  at async Proxy.prepare (packages/llm/deepseek-llm-api-extensions/src/index.ts:111)
  at async prepareRequestExtensions (packages/llm/llm-deepseek/src/request-extensions.ts:26)
```

`prepareRequestExtensions` 把这个抛出包装成 `LlmError: DeepSeek request extension preparation failed`（`REQUEST_EXTENSION`），于是这一轮在适配器发出任何 HTTP 之前就以 `{kind:'error'}` 结束。在插件清单保持默认的情况下实测得到：

| 挂载它的 app 是否声明 | 是否安装（app 的 `node_modules` 里可见链接） | 清单条目是否启用 | 第一次 assistant 尝试 |
|---|---|---|---|
| 是 | 是 | 是 | 抵达 provider |
| 否 | 是 | 是 | `REQUEST_EXTENSION` |
| 否 | 否 | 是 | `REQUEST_EXTENSION` |
| 否 | 否 | 否 | 抵达 provider |

最后一行把责任方隔离了出来：只关掉这一个条目、完全不动包图，模型调用就恢复了，所以这条约束属于这个消费方的解析过程，而不是 Loader 是否愿意激活该插件。

两个机制叠加成了这个陷阱。Loader 的激活走源码/tsconfig 路径图，所以一个 workspace 包无论有没有人声明它都能被激活。而 `ctx.pluginPackages` 背后的解析表则是**被声明出来的**依赖闭包——来自锚点 app 的安装作用域、来自被挂载 bundle 的 profile 作用域；`dependencyClosure` 会跳过它在磁盘上找不到的依赖（“已声明但未安装的依赖不可能对 Loader 可见”），而 `PluginPackages.packageOf` 只对锚点 `node_modules` 本来就看得见的名字回退到原生查找。于是，一个没有任何地方声明的条目（或声明了但没安装的条目）会被激活，同时又是无法被描述的。

`dsh_plugin_packages` 是给 provider 的参考性元数据：它描述 provider 可以预期的这份组合。现在每一次官方请求都依赖于**每一个活跃条目**都可被描述，而一个仅仅“没被声明”的条目会打掉整个请求，且报错既不指向它自己，也不指向缺失的声明。启动全程绿灯；第一条消息就失败。

## Proposal

**清单改为“解析不出就省略”，而不是让请求失败。** 解析不出的身份，只是对一个确实在运行的插件的“描述缺口”，因此这次贡献丢掉该条目，并让其他所有可解析条目保持逐字节不变。`dsh_plugin_packages` 会在组合能被解析的范围内继续描述这份组合——这也是该字段诚实的读法。

**把省略报告到组合能回答它的地方。** 被丢掉的 specifier、所属 Loader 树 base、以及尝试过的各个锚点，一起进入一条诊断（prepare 时告警，同样的细节也进启动诊断），让根因在启动时出现，而不是出现在用户的第一条消息上。

**cookbook 写清挂载要求。** `docs/cookbook/adding-a-package.md` 补上那条已经约束着上游适配器的规则：通过 overlay 或示例 `cordis.yml` 挂载的包，还必须由挂载它的 app（或 profile）声明**并且**安装，或者通过一个声明了它的 bundle 来挂载。`dsh-webhook-github` 就是先例——由 `apps/cli` 声明，并从 `apps/cli/config/examples/github-review/cordis.yml` 挂载。

## Alternatives considered

**保留抛出，只改进报错信息。** 最省事，也最不容易让畸形组合被放过，但它仍然把一个“未声明的插件”变成一场会话死亡：overlay 的使用者没有任何办法让这个请求走完，而且之后每一轮都会重复同样的崩溃。诊断 + 省略则能让插件继续工作，同时把组合修好。

**只写文档，不改代码。** 这条要求确实存在而且现在缺失，但文档帮不到一个已经在运行期坏掉的组合；而且文档门禁也不知道某个包到底该由哪个 app、profile 或 bundle 来负责。

**在挂载用的 overlay 里关掉清单条目。** 今天这样做是可行的，上游的 snapshot 配置正是这么做的（`- id: plugin-package-inventory-deepseek` 配 `disabled: true`，约十五个文件），但这是拿整个会话的 provider 元数据去换这次挂载，而且用户 overlay 也不是学这条规则的地方。

**只要求声明，不要安装这一步。** 被上面的实测否掉：已声明但未链接的包依然解析不出，只做一半规则会留下同样的崩溃。

**把清单的作用域收窄到请求发起 agent 的 preset 树。** 归档的[插件清单承载每个 agent preset 的组合](../../archived/architecture/2026-08-29-plugin-inventory-agent-preset-scopes.md)这条 note 已经决定了 provider 要描述两个平面，此处不重新开这个决定；而未解析的情形在 host 平面同样存在。

## Acceptance criteria

- 当存在一个无法解析包身份的活跃条目时，该轮第一次 assistant 尝试不再是 `REQUEST_EXTENSION` 错误，且 `dsh_plugin_packages` 恰好省略该条目，同时每一个可解析条目保持当前的 name/version 形状。
- 该省略产生一条诊断，指明 specifier 与尝试过的锚点。
- 一个解析测试双向锁定：解析不出的条目被省略并上报，解析得出的条目仍被贡献。
- `docs/cookbook/adding-a-package.md` 载明 overlay 与示例挂载的“声明 + 安装”要求，并以 `dsh-webhook-github` 作为范本。
- 一个门禁会让“新加入的 workspace 包没有被任何 app、profile 或 bundle 声明”失败，使该情形在 `doc-sync`/`constraints` 阶段被抓住，而不是等到第一次模型请求。

## Risks

- 省略条目会削弱这个字段本就承载的元数据。今天还没有消费方读 `dsh_plugin_packages` 来做决策，所以省略只是报告缺口；一旦将来有 provider 侧读者，它就变成行为差异——这条 note 就是重新审视该点的位置。
- 放松抛出会掩盖“依赖被误删”造成的坏组合。真正能抓住这一类的是上面提议的门禁，在它存在之前，诊断必须足够响。
- cookbook 规则给每个新包都加了一步，包括那些因为通过声明它的 bundle 挂载、从未受影响的包，所以规则必须写清它何时适用。
