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

  it('waits for the config when a language is picked but no lean value is cached', async () => {
    localStorage.setItem('doop-locale', 'en')
    serverSays({ defaultLocale: 'pt-BR', lean: true })
    const { initLocale } = await import('../src/lib/i18n')
    const { isLean } = await import('../src/lib/lean')
    await initLocale()
    expect(isLean()).toBe(true)
    expect(localStorage.getItem('doop-lean')).toBe('1')
  })

  it('renders at once from the cached value when a language is picked, then refreshes it', async () => {
    localStorage.setItem('doop-locale', 'en')
    localStorage.setItem('doop-lean', '1')
    let answer: (value: unknown) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((resolve) => (answer = resolve))),
    )
    const { initLocale } = await import('../src/lib/i18n')
    const { isLean } = await import('../src/lib/lean')
    await initLocale()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(isLean()).toBe(true)

    answer({ ok: true, json: async () => ({ defaultLocale: 'en', lean: false }) })
    await vi.waitFor(() => expect(isLean()).toBe(false))
    expect(localStorage.getItem('doop-lean')).toBe('0')
  })

  it('keeps the cached value when the refresh fails', async () => {
    localStorage.setItem('doop-locale', 'en')
    localStorage.setItem('doop-lean', '1')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const { initLocale } = await import('../src/lib/i18n')
    const { isLean } = await import('../src/lib/lean')
    await initLocale()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(isLean()).toBe(true)
    expect(localStorage.getItem('doop-lean')).toBe('1')
  })

  it('waits for the config when a lean value is cached but no language is picked', async () => {
    localStorage.setItem('doop-lean', '1')
    serverSays({ defaultLocale: 'pt-BR', lean: false })
    const { initLocale } = await import('../src/lib/i18n')
    const { isLean } = await import('../src/lib/lean')
    await initLocale()
    expect(isLean()).toBe(false)
  })

  it.each([
    ['a failed answer', () => serverSays({}, false)],
    ['an unreachable server', () => vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))],
  ])('keeps the cached lean value when no language is picked and the config request gets %s', async (_name, arrange) => {
    localStorage.setItem('doop-lean', '1')
    arrange()
    const { initLocale } = await import('../src/lib/i18n')
    const { isLean } = await import('../src/lib/lean')
    await initLocale()
    expect(isLean()).toBe(true)
    expect(localStorage.getItem('doop-lean')).toBe('1')
  })

  it('keeps the cached lean value when no language is picked and the config request times out', async () => {
    localStorage.setItem('doop-lean', '1')
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
      const init = initLocale()
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
      timeout.abort()
      await init
      expect(isLean()).toBe(true)
    } finally {
      timeoutSpy.mockRestore()
    }
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
