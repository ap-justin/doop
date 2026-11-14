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

/* the retry waits in src/lib/i18n/locale.ts, summed: past this no retry is left */
const RETRY_WAITS_MS = [2000, 5000, 15000]
const ALL_RETRY_WAITS_MS = RETRY_WAITS_MS.reduce((sum, wait) => sum + wait, 0)

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
})
afterEach(() => {
  vi.useRealTimers()
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
    vi.useFakeTimers()
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
    /* past every retry wait: the failed refresh has settled, and no retry follows it */
    await vi.advanceTimersByTimeAsync(ALL_RETRY_WAITS_MS)
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
      vi.useFakeTimers()
      localStorage.setItem('doop-lean', '1')
      arrange()
      const { initLocale } = await import('../src/lib/i18n')
      const { isLean } = await import('../src/lib/lean')
      await initLocale()
      expect(isLean()).toBe(true)
      expect(localStorage.getItem('doop-lean')).toBe('1')
      /* the cache stands in for the answer: no retry */
      await vi.advanceTimersByTimeAsync(ALL_RETRY_WAITS_MS)
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
    vi.useFakeTimers()
    serverSays({ defaultLocale: 'en' })
    const { initLocale } = await import('../src/lib/i18n')
    const { isLean, setLean } = await import('../src/lib/lean')
    /* module state only, no cache: initLocale has to turn it off itself */
    setLean(true)
    await initLocale()
    expect(isLean()).toBe(false)
    /* an answer without the field is still an answer: no retry */
    await vi.advanceTimersByTimeAsync(ALL_RETRY_WAITS_MS)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not ask again after an answer', async () => {
    vi.useFakeTimers()
    serverSays({ defaultLocale: 'en', lean: false })
    const { initLocale } = await import('../src/lib/i18n')
    const { isLean } = await import('../src/lib/lean')
    await initLocale()
    expect(isLean()).toBe(false)
    await vi.advanceTimersByTimeAsync(ALL_RETRY_WAITS_MS)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  /* each queues the first answer; the retries' answers are queued by the test */
  const noAnswer: Array<[string, (fetchMock: Mock) => void]> = [
    ['a failed answer', (fetchMock) => fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) })],
    ['an unreachable server', (fetchMock) => fetchMock.mockRejectedValueOnce(new Error('offline'))],
  ]
  const [firstWait = 0, secondWait = 0] = RETRY_WAITS_MS

  it.each(noAnswer)(
    'leaves lean off on %s, retries only after each wait, and turns it on when a later retry says lean',
    async (_name, first) => {
      vi.useFakeTimers()
      const fetchMock = vi.fn()
      first(fetchMock)
      /* the first retry fails as fast as the first request did; the second answers */
      fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ defaultLocale: 'en', lean: true }) })
      vi.stubGlobal('fetch', fetchMock)
      const { initLocale } = await import('../src/lib/i18n')
      const { isLean, setLean } = await import('../src/lib/lean')
      /* module state only, no cache: initLocale has to turn it off itself */
      setLean(true)
      await initLocale()
      expect(isLean()).toBe(false)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(firstWait - 1)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(isLean()).toBe(false)

      await vi.advanceTimersByTimeAsync(secondWait - 1)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(isLean()).toBe(true)
      expect(localStorage.getItem('doop-lean')).toBe('1')

      /* answered: the last wait schedules nothing */
      await vi.advanceTimersByTimeAsync(ALL_RETRY_WAITS_MS)
      expect(fetchMock).toHaveBeenCalledTimes(3)
    },
  )

  it.each(noAnswer)('leaves lean off on %s when every retry fails too', async (_name, first) => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
    first(fetchMock)
    fetchMock.mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const { initLocale } = await import('../src/lib/i18n')
    const { isLean, setLean } = await import('../src/lib/lean')
    setLean(true)
    await initLocale()
    expect(isLean()).toBe(false)

    await vi.advanceTimersByTimeAsync(ALL_RETRY_WAITS_MS)
    expect(fetchMock).toHaveBeenCalledTimes(1 + RETRY_WAITS_MS.length)
    expect(isLean()).toBe(false)
    expect(localStorage.getItem('doop-lean')).toBeNull()

    /* the retries are spent: nothing more is asked */
    await vi.advanceTimersByTimeAsync(ALL_RETRY_WAITS_MS)
    expect(fetchMock).toHaveBeenCalledTimes(1 + RETRY_WAITS_MS.length)
  })

  /* AbortSignal.timeout is stubbed at the boundary (a controller the test aborts), since fake timers do not drive it */
  it('leaves lean off when the config request hangs until its timeout aborts it, then follows the retry', async () => {
    vi.useFakeTimers()
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
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(timeoutSpy).toHaveBeenCalledWith(1500)
      await Promise.resolve()
      expect(settled).toBe(false)

      timeout.abort()
      await init
      expect(isLean()).toBe(false)
      expect(fetch).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(firstWait)
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(vi.mocked(fetch).mock.calls[1]?.[1]?.signal).toBeUndefined()

      /* the retry hangs: no further retry starts behind it */
      await vi.advanceTimersByTimeAsync(ALL_RETRY_WAITS_MS)
      expect(fetch).toHaveBeenCalledTimes(2)

      answer({ ok: true, json: async () => ({ defaultLocale: 'en', lean: true }) })
      await vi.advanceTimersByTimeAsync(0)
      expect(isLean()).toBe(true)
      await vi.advanceTimersByTimeAsync(ALL_RETRY_WAITS_MS)
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(timeoutSpy).toHaveBeenCalledTimes(1)
    } finally {
      timeoutSpy.mockRestore()
    }
  })
})
