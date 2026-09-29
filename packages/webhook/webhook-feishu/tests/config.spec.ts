import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Context with only the services direct apply reads. */
function harness(): { ctx: Context; register: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } {
  const ctx = new Context()
  contexts.push(ctx)
  const remove = vi.fn()
  const register = vi.fn(() => remove)
  ctx.provide('webServer', { register } as never)
  ctx.provide('webhookRuntime', {} as never)
  ctx.provide('credentials', {} as never)
  return { ctx, register, remove }
}

const valid = {
  source: 'primary',
  path: '/feishu',
  tokenEnv: 'DSH_FEISHU_VERIFICATION_TOKEN',
  maxBodyBytes: 1024,
} satisfies Config

describe('Feishu webhook plugin config', () => {
  it('registers one exact route and removes it with the plugin fiber', async () => {
    const test = harness()
    apply(test.ctx, valid)
    expect(test.register).toHaveBeenCalledWith(expect.objectContaining({ kind: 'exact', path: '/feishu' }))
    await test.ctx.fiber.dispose()
    expect(test.remove).toHaveBeenCalledOnce()
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
  ] as const)('rejects invalid config %# before route registration', (config, message) => {
    const test = harness()
    expect(() => { apply(test.ctx, config) }).toThrow(message)
    expect(test.register).not.toHaveBeenCalled()
  })
})
