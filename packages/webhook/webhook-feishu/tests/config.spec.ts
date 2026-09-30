import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Context with only the services direct apply reads. */
function harness(): {
  ctx: Context
  register: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  registerRule: ReturnType<typeof vi.fn>
  removeRule: ReturnType<typeof vi.fn>
} {
  const ctx = new Context()
  contexts.push(ctx)
  const removeRule = vi.fn(async () => {})
  const registerRule = vi.fn(() => removeRule)
  const remove = vi.fn()
  const register = vi.fn(() => remove)
  ctx.provide('webServer', { register } as never)
  ctx.provide('webhookRuntime', { register: registerRule } as never)
  ctx.provide('credentials', {} as never)
  return { ctx, register, remove, registerRule, removeRule }
}

const valid = {
  source: 'primary',
  path: '/feishu',
  tokenEnv: 'DSH_FEISHU_VERIFICATION_TOKEN',
  appIdEnv: 'DSH_FEISHU_APP_ID',
  appSecretEnv: 'DSH_FEISHU_APP_SECRET',
  maxBodyBytes: 1024,
  workspacePath: '/feishu-workspace',
  agentPreset: 'chat',
  permissionPreset: 'sandbox',
} satisfies Config

describe('Feishu webhook plugin config', () => {
  it('registers one exact route plus the channel rule and removes both with the plugin fiber', async () => {
    const test = harness()
    apply(test.ctx, valid)
    expect(test.register).toHaveBeenCalledWith(expect.objectContaining({ kind: 'exact', path: '/feishu' }))
    expect(test.registerRule).toHaveBeenCalledWith(expect.objectContaining({
      id: 'webhook-feishu:primary',
      kind: 'feishu',
    }))
    await test.ctx.fiber.dispose()
    expect(test.remove).toHaveBeenCalledOnce()
    expect(test.removeRule).toHaveBeenCalledOnce()
  })

  it('accepts an optional encrypt key reference', () => {
    const test = harness()
    expect(() => { apply(test.ctx, { ...valid, encryptKeyEnv: 'DSH_FEISHU_ENCRYPT_KEY' }) }).not.toThrow()
    expect(test.register).toHaveBeenCalledOnce()
  })

  it.each([
    [{ ...valid, source: '' }, /source/],
    [{ ...valid, source: ' primary' }, /source/],
    [{ ...valid, path: 'feishu' }, /path/],
    [{ ...valid, path: '/' }, /path/],
    [{ ...valid, path: '/feishu/' }, /path/],
    [{ ...valid, path: '/feishu?q=1' }, /path/],
    [{ ...valid, path: '/feishu#x' }, /path/],
    [{ ...valid, tokenEnv: 'not valid' }, /credential ref/],
    [{ ...valid, encryptKeyEnv: 'not valid' }, /credential ref/],
    [{ ...valid, workspacePath: 'relative/path' }, /workspacePath/],
    [{ ...valid, agentPreset: ' ' }, /agentPreset/],
    [{ ...valid, permissionPreset: '' }, /permissionPreset/],
    [{ ...valid, titlePrefix: ' ' }, /titlePrefix/],
    [{ ...valid, model: { provider: ' ', model: 'm' } }, /model\.provider/],
    [{ ...valid, model: { provider: 'p' } as NonNullable<Config['model']> }, /model\.provider/],
  ] as const)('rejects invalid config %# before route registration', (config, message) => {
    const test = harness()
    expect(() => { apply(test.ctx, config) }).toThrow(message)
    expect(test.register).not.toHaveBeenCalled()
    expect(test.registerRule).not.toHaveBeenCalled()
  })
})
