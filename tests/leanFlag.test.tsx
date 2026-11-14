// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* The flag starts off and follows /api/locale-config. Every test takes fresh
   modules: the flag and the language are module state. */

function serverSays(body: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => body })),
  )
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('initLocale', () => {
  it('starts with lean off', async () => {
    const { isLean } = await import('../src/lib/lean')
    expect(isLean()).toBe(false)
  })

  it('reads lean from the config it asks for once', async () => {
    serverSays({ defaultLocale: 'pt-BR', lean: true })
    const { initLocale, getLocale } = await import('../src/lib/i18n')
    const { isLean } = await import('../src/lib/lean')
    await initLocale()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(isLean()).toBe(true)
    expect(getLocale()).toBe('pt-BR')
  })

  it('reads the config even when the browser already picked a language', async () => {
    localStorage.setItem('doop-locale', 'en')
    serverSays({ defaultLocale: 'pt-BR', lean: true })
    const { initLocale } = await import('../src/lib/i18n')
    const { isLean } = await import('../src/lib/lean')
    await initLocale()
    expect(isLean()).toBe(true)
  })

  it.each([
    ['a failed answer', () => serverSays({}, false)],
    ['a missing field', () => serverSays({ defaultLocale: 'en' })],
    ['an unreachable server', () => vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))],
  ])('leaves lean off on %s', async (_name, arrange) => {
    arrange()
    const { initLocale } = await import('../src/lib/i18n')
    const { isLean } = await import('../src/lib/lean')
    await initLocale()
    expect(isLean()).toBe(false)
  })

  /* AbortSignal.timeout is stubbed at the boundary (a controller the test aborts), since fake timers do not drive it */
  it('leaves lean off when the config request hangs until its timeout aborts it', async () => {
    const timeout = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: string, init?: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
            }),
        ),
      )
      const { initLocale } = await import('../src/lib/i18n')
      const { isLean } = await import('../src/lib/lean')
      let settled = false
      const init = initLocale().then(() => {
        settled = true
      })
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
      expect(timeoutSpy).toHaveBeenCalledWith(1500)
      await Promise.resolve()
      expect(settled).toBe(false)

      timeout.abort()
      await init
      expect(isLean()).toBe(false)
    } finally {
      timeoutSpy.mockRestore()
    }
  })
})
