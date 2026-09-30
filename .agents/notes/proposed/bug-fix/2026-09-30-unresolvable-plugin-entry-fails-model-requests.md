# Agent Note: An active plugin entry without a resolvable package identity fails every model request

Status: proposed

English | [中文](2026-09-30-unresolvable-plugin-entry-fails-model-requests.zh.md)

## Problem

Mounting a workspace plugin through an overlay (`--patch`) or an example `cordis.yml` activates it: the Loader resolves the module, `apply` runs, and the plugin's routes and services come up. It does not make the composition able to *describe* it. `plugin-package-inventory-deepseek`, default-on in `@deepseek-ai/dsh-base`, resolves the package identity of every active Loader entry on each official DeepSeek request and throws on the first entry it cannot resolve.

The observed failure, on a branch that adds `packages/webhook/webhook-feishu` and mounts it from an overlay:

```
plugin-package-inventory-deepseek: cannot resolve active package "@deepseek-ai/dsh-webhook-feishu"
  at PackageIdentityResolver.resolve (packages/llm/plugin-package-inventory-deepseek/src/index.ts:123)
  at async collectActivePluginPackages (packages/llm/plugin-package-inventory-deepseek/src/index.ts:178)
  at async Object.prepare (packages/llm/plugin-package-inventory-deepseek/src/index.ts:200)
  at async Proxy.prepare (packages/llm/deepseek-llm-api-extensions/src/index.ts:111)
  at async prepareRequestExtensions (packages/llm/llm-deepseek/src/request-extensions.ts:26)
```

`prepareRequestExtensions` wraps that throw as `LlmError: DeepSeek request extension preparation failed` (`REQUEST_EXTENSION`), so the turn ends with `{kind:'error'}` before the adapter issues any HTTP. Measured, with the inventory left at its default:

| Declared by the mounting app | Installed (link visible to the app's `node_modules`) | Inventory entry enabled | First assistant attempt |
|---|---|---|---|
| yes | yes | yes | reaches the provider |
| no | yes | yes | `REQUEST_EXTENSION` |
| no | no | yes | `REQUEST_EXTENSION` |
| no | no | no | reaches the provider |

The last row isolates the owner: disabling this one entry restores the model call with no package-graph edits at all, so the constraint belongs to this consumer's resolution, not to the Loader's willingness to activate the plugin.

Two mechanisms combine to make the trap. Loader activation resolves modules through the source/tsconfig path graph, so a workspace package activates whether or not anything declares it. The resolution table behind `ctx.pluginPackages` is instead the *declared* dependency closure — installation scope from the anchoring app, profile scope from the mounted bundles — and `dependencyClosure` skips a dependency it cannot find on disk ("a declared-but-uninstalled dependency cannot be loader-visible"), while `PluginPackages.packageOf` only falls back to native lookup for names the anchoring `node_modules` can already see. An entry declared nowhere, or declared but not installed, therefore activates and is simultaneously undescribable.

`dsh_plugin_packages` is advisory provider metadata: a description of the composition the provider can expect. Every official request now depends on every *active* entry being describable, and an entry that is merely undeclared takes down the request while naming neither itself nor the missing declaration. Startup stays green; the first message fails.

## Proposal

**The inventory omits an entry it cannot resolve instead of failing the request.** An unresolvable identity is a reporting gap about a plugin that is demonstrably running, so the contribution drops that entry and keeps every resolvable entry byte-identical. `dsh_plugin_packages` keeps describing the composition as far as the composition can be resolved, which is the honest reading of the field.

**The omission is reported where the composition can answer it.** The dropped specifier, the owning Loader tree base, and the anchors tried travel into one diagnostic (a warning at prepare time, and the same detail in startup diagnostics), so the root cause appears at boot rather than on a user's first message.

**The cookbook states the mounting requirement.** `docs/cookbook/adding-a-package.md` gains the rule that already binds upstream adapters: a package mounted by an overlay or an example `cordis.yml` must also be declared by the mounting app (or the profile) *and* installed, or mounted through a bundle that declares it. `dsh-webhook-github` is the precedent - declared by `apps/cli` and mounted from `apps/cli/config/examples/github-review/cordis.yml`.

## Alternatives considered

**Keep the throw and only improve the message.** Cheapest, and it preserves least-surprise for malformed compositions, but it still converts an undeclared plugin into a dead session: the user of an overlay has no way to complete the request, and every later turn repeats the same crash. A diagnostic plus omission lets the plugin keep working while the composition is fixed.

**Document the requirement only, with no code change.** The requirement is real and missing today, but documentation cannot help a composition that is already broken at runtime, and the doc gate does not know which app, profile, or bundle should own a given package.

**Disable the inventory entry in the mounting overlay.** This works today and upstream snapshot configs do exactly this (`- id: plugin-package-inventory-deepseek` with `disabled: true`) in roughly fifteen files, but it buys the mount at the cost of the provider metadata for the whole session, and a user overlay is the wrong place to learn that rule.

**Require the declaration alone, without the install step.** Rejected by the measurement above: a declared-but-unlinked package stays unresolvable, so half the rule would leave the same crash in place.

**Scope the inventory to the requesting agent's preset tree only.** The archived [plugin inventory carrying every agent preset's composition](../../archived/architecture/2026-08-29-plugin-inventory-agent-preset-scopes.md) note already decides that the provider describes both planes, and that decision is not reopened here; the unresolved case exists in the host plane too.

## Acceptance criteria

- With an active entry whose package identity cannot be resolved, the turn's first assistant attempt is not a `REQUEST_EXTENSION` error, and `dsh_plugin_packages` omits exactly that entry while every resolvable entry keeps its current name/version shape.
- The omission emits one diagnostic naming the specifier and the anchors tried.
- A resolution test pins both directions: an unresolvable entry is omitted and reported, a resolvable one is still contributed.
- `docs/cookbook/adding-a-package.md` carries the declaration-and-install requirement for overlay and example mounts, with `dsh-webhook-github` as the worked example.
- A gate fails a newly added workspace package that no app, profile, or bundle declares, so the condition is caught in `doc-sync`/`constraints` rather than at the first model request.

## Risks

- Omitting an entry weakens the metadata the field exists to carry. Today no consumer reads `dsh_plugin_packages` to make a decision, so the omission is a reporting gap; a future provider-side reader would turn it into a behavior difference, and this note is the place to re-examine that.
- Loosening the throw hides compositions broken by an accidental dependency removal. The proposed gate is what actually catches that class, and the diagnostic must stay loud enough until it exists.
- The cookbook rule adds a step to every new package, including ones that were never affected because they mount through a declaring bundle, so the rule has to name when it applies.
