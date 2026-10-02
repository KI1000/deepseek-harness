/** Signed Feishu HTTP adapter for the provider-neutral webhook runtime. */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WebhookModelSelection } from '@deepseek-ai/dsh-webhook'
import z from '@deepseek-ai/schemastery'
import { createFeishuChannel } from './channel.ts'
import { createFeishuWebhookHandler } from './handler.ts'
import { createFeishuSender } from './sender.ts'

export type * from './types.ts'

/** Cordis function-plugin name. */
export const name = 'webhook-feishu'
/** Host services required before the exact route can register. */
export const inject = ['webServer', 'webhookRuntime', 'credentials', 'agents', 'workspaceRegistry']

/** Required Feishu ingress configuration. */
export interface Config {
  /** Adapter instance name carried to rules. */
  readonly source: string
  /** Exact absolute route path. */
  readonly path: string
  /** Credential reference containing the Feishu verification token. */
  readonly tokenEnv: string
  /** Optional credential reference containing the Feishu encrypt key. */
  readonly encryptKeyEnv?: string
  /** Positive raw body ceiling in bytes. */
  readonly maxBodyBytes: number
  /** Credential reference containing the Feishu app id used for outbound replies. */
  readonly appIdEnv: string
  /** Credential reference containing the Feishu app secret used for outbound replies. */
  readonly appSecretEnv: string
  /** Absolute workspace directory backing every Feishu-created Session. */
  readonly workspacePath: string
  /** Agent composition preset applied to every Feishu-created Session. */
  readonly agentPreset: string
  /** Permission preset applied to every Feishu-created Session. */
  readonly permissionPreset: string
  /** Session title prefix; defaults to `Feishu`. */
  readonly titlePrefix?: string
  /** Feishu bot display name; matching group mention placeholders are removed from prompts. */
  readonly botName?: string
  /** Optional explicit model route for every Feishu-created Session. */
  readonly model?: WebhookModelSelection
}

export const Config: z<Config> = z.object({
  source: z.string().required(),
  path: z.string().required(),
  tokenEnv: z.string().role('credential-ref').required(),
  encryptKeyEnv: z.string().role('credential-ref'),
  maxBodyBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  appIdEnv: z.string().role('credential-ref').required(),
  appSecretEnv: z.string().role('credential-ref').required(),
  workspacePath: z.string().required(),
  agentPreset: z.string().required(),
  permissionPreset: z.string().required(),
  titlePrefix: z.string(),
  botName: z.string(),
  model: z.object({
    provider: z.string(),
    model: z.string(),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  }),
})

/** Validate route and source facts that Schemastery cannot express. */
/** Normalize the optional model route; schemastery materializes the nested object even when the key is absent. */
function resolvedModel(config: Config): WebhookModelSelection | undefined {
  const provider = config.model?.provider
  const model = config.model?.model
  const maxTokens = config.model?.maxTokens
  const providerPresent = typeof provider === 'string' && provider.trim() !== ''
  const modelPresent = typeof model === 'string' && model.trim() !== ''
  if (!providerPresent && !modelPresent) return undefined
  if (!providerPresent || !modelPresent) {
    throw new Error('webhook-feishu model.provider and model.model must be non-empty strings when model is present')
  }
  return {
    provider: provider.trim(),
    model: model.trim(),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  }
}

/** Validate route and source facts that Schemastery cannot express. */
function assertConfig(config: Config): void {
  if (config.source.trim() !== config.source || config.source === '') {
    throw new Error('webhook-feishu source must be a non-empty trimmed string')
  }
  if (!config.path.startsWith('/') || config.path === '/' || config.path.endsWith('/')
    || config.path.includes('?') || config.path.includes('#')) {
    throw new Error('webhook-feishu path must be an absolute non-root pathname without a trailing slash, query, or fragment')
  }
  if (!isAbsolute(config.workspacePath)) {
    throw new Error('webhook-feishu workspacePath must be an absolute path')
  }
  if (config.agentPreset.trim() === '') {
    throw new Error('webhook-feishu agentPreset must be a non-empty string')
  }
  if (config.permissionPreset.trim() === '') {
    throw new Error('webhook-feishu permissionPreset must be a non-empty string')
  }
  if (config.titlePrefix !== undefined && config.titlePrefix.trim() === '') {
    throw new Error('webhook-feishu titlePrefix must be a non-empty string when present')
  }
  if (config.botName !== undefined && config.botName.trim() === '') {
    throw new Error('webhook-feishu botName must be a non-empty string when present')
  }
  resolvedModel(config)
}

/** Register one signed Feishu endpoint plus the bundled rule and reply pump. */
export function apply(ctx: Context, config: Config): void {
  assertConfig(config)
  const model = resolvedModel(config)
  const sender = createFeishuSender(ctx, {
    appIdEnv: credentialRef(config.appIdEnv),
    appSecretEnv: credentialRef(config.appSecretEnv),
  })
  const channelConfig = {
    source: config.source,
    workspacePath: config.workspacePath,
    agentPreset: config.agentPreset,
    permissionPreset: config.permissionPreset,
    ...(config.titlePrefix === undefined ? {} : { titlePrefix: config.titlePrefix }),
    ...(config.botName === undefined ? {} : { botName: config.botName }),
    ...(model === undefined ? {} : { model }),
  }
  const route = {
    kind: 'exact' as const,
    path: config.path,
    handler: createFeishuWebhookHandler(ctx, {
      source: config.source,
      tokenEnv: credentialRef(config.tokenEnv),
      ...(config.encryptKeyEnv === undefined ? {} : { encryptKeyEnv: credentialRef(config.encryptKeyEnv) }),
      maxBodyBytes: config.maxBodyBytes,
    }),
  }
  ctx.effect(
    () => ctx.webServer.register(route),
    `webhook-feishu: ${config.path}`,
  )
  ctx.effect(
    () => createFeishuChannel(ctx, channelConfig, sender),
    `webhook-feishu: channel ${config.source}`,
  )
}
