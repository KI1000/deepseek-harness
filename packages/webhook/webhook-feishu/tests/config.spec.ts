import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Context with the services consumed directly by apply. */
function harness(): {
  ctx: Context
  registerRule: ReturnType<typeof vi.fn>
  removeRule: ReturnType<typeof vi.fn>
} {
  const ctx = new Context()
  contexts.push(ctx)
  const removeRule = vi.fn(async () => {})
  const registerRule = vi.fn(() => removeRule)
  ctx.provide('webhookRuntime', { register: registerRule } as never)
  ctx.provide('credentials', {} as never)
  return { ctx, registerRule, removeRule }
}

const valid = {
  source: 'primary',
  appIdEnv: 'DSH_FEISHU_APP_ID',
  appSecretEnv: 'DSH_FEISHU_APP_SECRET',
  workspacePath: '/feishu-workspace',
  agentPreset: 'chat',
  permissionPreset: 'sandbox',
} satisfies Config

describe('Feishu channel plugin config', () => {
  it('registers only the channel rule and removes it with the plugin fiber', async () => {
    const test = harness()
    apply(test.ctx, valid)
    expect(test.registerRule).toHaveBeenCalledOnce()
    expect(test.registerRule.mock.calls[0]?.[0]).toMatchObject({
      id: 'webhook-feishu:primary',
      kind: 'feishu',
    })
    await test.ctx.fiber.dispose()
    expect(test.removeRule).toHaveBeenCalledOnce()
  })

  it('accepts channel reply and prompt options', () => {
    const test = harness()
    expect(() => { apply(test.ctx, {
      ...valid,
      titlePrefix: '店小二',
      botName: 'ToneClaw',
      model: { provider: 'deepseek', model: 'deepseek-chat' },
    }) }).not.toThrow()
    expect(test.registerRule).toHaveBeenCalledOnce()
  })

  it.each([
    [{ ...valid, source: '' }, /source/],
    [{ ...valid, source: ' primary' }, /source/],
    [{ ...valid, workspacePath: 'relative/path' }, /workspacePath/],
    [{ ...valid, agentPreset: ' ' }, /agentPreset/],
    [{ ...valid, permissionPreset: '' }, /permissionPreset/],
    [{ ...valid, titlePrefix: ' ' }, /titlePrefix/],
    [{ ...valid, botName: ' ' }, /botName/],
    [{ ...valid, model: { provider: ' ', model: 'm' } }, /model\.provider/],
    [{ ...valid, model: { provider: 'p' } as NonNullable<Config['model']> }, /model\.provider/],
  ] as const)('rejects invalid config %# before rule registration', (config, message) => {
    const test = harness()
    expect(() => { apply(test.ctx, config) }).toThrow(message)
    expect(test.registerRule).not.toHaveBeenCalled()
  })
})
