// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* The flag starts off, follows /api/locale-config, and keeps analytics from
   loading at all in lean mode. Every test takes fresh modules: the flag, the
   language and the analytics facade are module state. */

const loaded = vi.hoisted(() => ({ count: 0, capture: vi.fn() }))
vi.mock('../src/lib/posthogClient', () => {
  loaded.count += 1
  return {
    posthog: { capture: loaded.capture, identify: vi.fn(), reset: vi.fn() },
    syncReplayForUser: vi.fn(),
    suspendAnalyticsWhileImpersonating: vi.fn(),
    setSupportWidgetVisible: vi.fn(),
    openSupportChat: () => true,
  }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function serverSays(body: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => body })),
  )
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  loaded.count = 0
  loaded.capture.mockClear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the lean flag', () => {
  it('starts off, and useLean re-renders when it is settled', async () => {
    const { isLean, setLean, useLean } = await import('../src/lib/lean')
    expect(isLean()).toBe(false)
    const seen: boolean[] = []
    function Probe() {
      seen.push(useLean())
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Probe />))
    await act(async () => setLean(true))
    expect(isLean()).toBe(true)
    expect(seen.at(-1)).toBe(true)
    await act(async () => root.unmount())
  })
})

describe('initLocale', () => {
  it('reads lean from the config it asks for once', async () => {
    serverSays({ defaultLocale: 'pt-BR', lean: true })
    const { initLocale, getLocale } = await import('../src/lib/i18n')
    const { isLean } = await import('../src/lib/lean')
    await initLocale()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('/api/locale-config', expect.anything())
    expect(isLean()).toBe(true)
    expect(getLocale()).toBe('pt-BR')
  })

  it('asks even when the browser picked a language, which still wins', async () => {
    localStorage.setItem('doop-locale', 'en')
    serverSays({ defaultLocale: 'pt-BR', lean: true })
    const { initLocale, getLocale } = await import('../src/lib/i18n')
    const { isLean } = await import('../src/lib/lean')
    await initLocale()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(isLean()).toBe(true)
    expect(getLocale()).toBe('en')
  })

  it('is off when the server says so, leaves it out, refuses or cannot be reached', async () => {
    for (const answer of [
      () => serverSays({ defaultLocale: 'en', lean: false }),
      () => serverSays({ defaultLocale: 'en' }),
      () => serverSays({ lean: true }, false),
      () =>
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => Promise.reject(new Error('offline'))),
        ),
    ]) {
      vi.resetModules()
      answer()
      const { initLocale, getLocale } = await import('../src/lib/i18n')
      const { isLean } = await import('../src/lib/lean')
      await initLocale()
      expect(isLean()).toBe(false)
      expect(getLocale()).toBe('en')
    }
  })
})

describe('analytics', () => {
  it('never loads in lean mode, and calls do nothing', async () => {
    const { setLean } = await import('../src/lib/lean')
    const { loadAnalytics, posthog, openSupportChat } = await import('../src/lib/posthog')
    setLean(true)
    posthog.capture('before')
    await loadAnalytics()
    posthog.capture('after')
    expect(loaded.count).toBe(0)
    expect(openSupportChat()).toBe(false)
  })

  it('loads off lean mode and sends what was captured while it loaded', async () => {
    const { loadAnalytics, posthog, openSupportChat } = await import('../src/lib/posthog')
    posthog.capture('early', { at: 1 })
    expect(loaded.capture).not.toHaveBeenCalled()
    await loadAnalytics()
    expect(loaded.count).toBe(1)
    expect(loaded.capture).toHaveBeenCalledWith('early', { at: 1 })
    posthog.capture('late')
    expect(loaded.capture).toHaveBeenLastCalledWith('late')
    expect(openSupportChat()).toBe(true)
  })
})
