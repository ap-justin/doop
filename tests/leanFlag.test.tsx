// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

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
    let fail: (error: Error) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((_resolve, reject) => (fail = reject))),
    )
    const { initLocale } = await import('../src/lib/i18n')
    const { isLean } = await import('../src/lib/lean')
    await initLocale()
    expect(isLean()).toBe(true)

    /* the entry gone before the refresh fails (site data cleared): a failure
       that fell back to the cache would read nothing there and turn lean off */
    localStorage.removeItem('doop-lean')
    fail(new Error('offline'))
    /* a macrotask: runs every microtask the failed refresh queued behind that rejection */
    await new Promise((resolve) => setTimeout(resolve))
    expect(isLean()).toBe(true)
    expect(localStorage.getItem('doop-lean')).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
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
  ])(
    'keeps the cached lean value when no language is picked and the config request gets %s',
    async (_name, arrange) => {
      localStorage.setItem('doop-lean', '1')
      arrange()
      const { initLocale } = await import('../src/lib/i18n')
      const { isLean } = await import('../src/lib/lean')
      await initLocale()
      expect(isLean()).toBe(true)
      expect(localStorage.getItem('doop-lean')).toBe('1')
      /* the cache stands in for the answer: no retry */
      await new Promise((resolve) => setTimeout(resolve))
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

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

  it('leaves lean off on a missing field, without asking again', async () => {
    serverSays({ defaultLocale: 'en' })
    const { initLocale } = await import('../src/lib/i18n')
    const { isLean, setLean } = await import('../src/lib/lean')
    /* module state only, no cache: initLocale has to turn it off itself */
    setLean(true)
    await initLocale()
    expect(isLean()).toBe(false)
    await new Promise((resolve) => setTimeout(resolve))
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  /* each queues the first answer; the retry's answer is queued by the test */
  const noAnswer: Array<[string, (fetchMock: Mock) => void]> = [
    ['a failed answer', (fetchMock) => fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) })],
    ['an unreachable server', (fetchMock) => fetchMock.mockRejectedValueOnce(new Error('offline'))],
  ]

  it.each(noAnswer)('leaves lean off on %s, then turns it on when the one retry says lean', async (_name, first) => {
    const fetchMock = vi.fn()
    first(fetchMock)
    let answer: (value: unknown) => void = () => {}
    fetchMock.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    vi.stubGlobal('fetch', fetchMock)
    const { initLocale } = await import('../src/lib/i18n')
    const { isLean, setLean } = await import('../src/lib/lean')
    /* module state only, no cache: initLocale has to turn it off itself */
    setLean(true)
    await initLocale()
    expect(isLean()).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    answer({ ok: true, json: async () => ({ defaultLocale: 'en', lean: true }) })
    await vi.waitFor(() => expect(isLean()).toBe(true))
    expect(localStorage.getItem('doop-lean')).toBe('1')
    await new Promise((resolve) => setTimeout(resolve))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(noAnswer)('leaves lean off on %s when the one retry fails too', async (_name, first) => {
    const fetchMock = vi.fn()
    first(fetchMock)
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const { initLocale } = await import('../src/lib/i18n')
    const { isLean, setLean } = await import('../src/lib/lean')
    setLean(true)
    await initLocale()
    expect(isLean()).toBe(false)

    /* a macrotask: the failed retry has settled behind it */
    await new Promise((resolve) => setTimeout(resolve))
    expect(isLean()).toBe(false)
    expect(localStorage.getItem('doop-lean')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  /* AbortSignal.timeout is stubbed at the boundary (a controller the test aborts), since fake timers do not drive it */
  it('leaves lean off when the config request hangs until its timeout aborts it, then follows the retry', async () => {
    const timeout = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    try {
      /* a bounded request hangs until aborted; the unbounded retry waits for the test */
      let answer: (value: unknown) => void = () => {}
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: string, init?: { signal?: AbortSignal }) =>
            new Promise((resolve, reject) => {
              const signal = init?.signal
              if (signal) signal.addEventListener('abort', () => reject(signal.reason))
              else answer = resolve
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
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(vi.mocked(fetch).mock.calls[1]?.[1]?.signal).toBeUndefined()

      answer({ ok: true, json: async () => ({ defaultLocale: 'en', lean: true }) })
      await vi.waitFor(() => expect(isLean()).toBe(true))
      await new Promise((resolve) => setTimeout(resolve))
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(timeoutSpy).toHaveBeenCalledTimes(1)
    } finally {
      timeoutSpy.mockRestore()
    }
  })
})
