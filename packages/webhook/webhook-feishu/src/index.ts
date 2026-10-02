/** Feishu channel for an externally supplied webhook delivery transport. */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { WebhookModelSelection } from '@deepseek-ai/dsh-webhook'
import z from '@deepseek-ai/schemastery'
import { createFeishuChannel } from './channel.ts'
import { createFeishuSender } from './sender.ts'

export type * from './types.ts'

/** Cordis function-plugin name. */
export const name = 'webhook-feishu'
/** Host services required to turn external deliveries into Feishu Sessions and replies. */
export const inject = ['webhookRuntime', 'credentials', 'agents', 'workspaceRegistry']

/** Feishu channel configuration for a transport such as the long-connection ingress. */
export interface Config {
  /** Adapter instance name carried to rules. */
  readonly source: string
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

/** Validate channel facts that Schemastery cannot express. */
function assertConfig(config: Config): void {
  if (config.source.trim() !== config.source || config.source === '') {
    throw new Error('webhook-feishu source must be a non-empty trimmed string')
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

/** Register the Feishu trusted rule and outbound reply pump. */
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
  ctx.effect(
    () => createFeishuChannel(ctx, channelConfig, sender),
    `webhook-feishu: channel ${config.source}`,
  )
}
