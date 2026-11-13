// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* The flag starts off, follows /api/locale-config, and keeps analytics from
   loading at all in lean mode. Every test takes fresh modules: the flag, the
   language and the analytics facade are module state. */

const loaded = vi.hoisted(() => ({ count: 0, capture: vi.fn(), captureException: vi.fn() }))
vi.mock('../src/lib/posthogClient', () => {
  loaded.count += 1
  return {
    posthog: { capture: loaded.capture, captureException: loaded.captureException, identify: vi.fn(), reset: vi.fn() },
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
  loaded.captureException.mockClear()
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
  it('keeps the server default for when the browser drops its pick', async () => {
    localStorage.setItem('doop-locale', 'en')
    serverSays({ defaultLocale: 'pt-BR', lean: false })
    const { initLocale, getLocale } = await import('../src/lib/i18n')
    await initLocale()
    expect(getLocale()).toBe('en')
    localStorage.removeItem('doop-locale')
    window.dispatchEvent(new StorageEvent('storage', { key: 'doop-locale' }))
    expect(getLocale()).toBe('pt-BR')
  })
})

describe('the route', () => {
  afterEach(() => history.replaceState(null, '', '/'))

  it('sends a page lean mode turns off home, address and all', async () => {
    const { setLean } = await import('../src/lib/lean')
    const { currentRoute } = await import('../src/lib/navigate')
    setLean(true)
    for (const off of ['/community', '/integrations?linearError=denied', '/automations/a1']) {
      history.replaceState(null, '', off)
      expect(currentRoute()).toBe('/')
      expect(location.pathname + location.search).toBe('/')
    }
    history.replaceState(null, '', '/w/1?pane=fonts')
    expect(currentRoute()).toBe('/w/1?pane=fonts')
  })

  it('keeps those pages with lean off', async () => {
    const { currentRoute } = await import('../src/lib/navigate')
    history.replaceState(null, '', '/automations/a1')
    expect(currentRoute()).toBe('/automations/a1')
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

  it.each([
    { lean: true, sent: [] },
    { lean: false, sent: [['early', { at: 1 }]] },
  ])('settles what was captured while the server was asked: lean $lean', async ({ lean, sent }) => {
    const { initLocale } = await import('../src/lib/i18n')
    const { loadAnalytics, posthog } = await import('../src/lib/posthog')
    /* main.tsx's order: the page is asked about lean after the first calls queued */
    posthog.capture('early', { at: 1 })
    serverSays({ defaultLocale: 'en', lean })
    await initLocale()
    await loadAnalytics()
    expect(loaded.capture.mock.calls).toEqual(sent)
    if (lean) expect(loaded.count).toBe(0)
  })

  it('sends errors thrown before it loaded, then leaves them to PostHog', async () => {
    const { loadAnalytics } = await import('../src/lib/posthog')
    const boom = new Error('first render')
    window.dispatchEvent(new ErrorEvent('error', { error: boom, message: boom.message }))
    window.dispatchEvent(rejection('chunk failed'))
    expect(loaded.captureException).not.toHaveBeenCalled()
    await loadAnalytics()
    expect(loaded.captureException.mock.calls).toEqual([[boom], ['chunk failed']])
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('later') }))
    expect(loaded.captureException).toHaveBeenCalledTimes(2)
  })

  it('drops early errors in lean mode', async () => {
    const { setLean } = await import('../src/lib/lean')
    const { loadAnalytics } = await import('../src/lib/posthog')
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('before') }))
    setLean(true)
    await loadAnalytics()
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('after') }))
    expect(loaded.count).toBe(0)
    expect(loaded.captureException).not.toHaveBeenCalled()
  })

  it('reports the landing address on the first page view, unless the person moved on', async () => {
    history.replaceState(null, '', '/?scope=ws-1')
    const { reportLandingUrl } = await import('../src/lib/posthog')
    history.replaceState(null, '', '/')
    expect(reportLandingUrl(pageview())?.properties.$current_url).toBe(`${location.origin}/?scope=ws-1`)
    expect(reportLandingUrl(pageview())?.properties.$current_url).toBe(location.href)

    vi.resetModules()
    history.replaceState(null, '', '/w/1?checkout=success')
    const moved = await import('../src/lib/posthog')
    history.replaceState(null, '', '/c/2')
    expect(moved.reportLandingUrl(pageview())?.properties.$current_url).toBe(location.href)
    history.replaceState(null, '', '/')
  })
})

function rejection(reason: unknown): Event {
  return Object.assign(new Event('unhandledrejection'), { reason })
}

function pageview() {
  return { uuid: 'u', event: '$pageview', properties: { $current_url: location.href } }
}
