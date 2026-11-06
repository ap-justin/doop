import { env, windowsBrowserDirectories } from './env.ts'
import fs from 'node:fs'
import path from 'node:path'
import puppeteer, { type Browser, type BrowserContext, type Page } from 'puppeteer-core'
import type { Frame } from '../shared/types.ts'
import { guardPublicPageRequests } from './publicUrl.ts'

/**
 * Render a frame's HTML in headless Chrome so agents can *see* their work.
 * Uses the system browser via puppeteer-core — no bundled download.
 */

const windowsDirectories = process.platform === 'win32' ? windowsBrowserDirectories() : []

const CHROME_PATHS = [
  env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  ...windowsDirectories.map((dir) => path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe')),
  ...windowsDirectories.map((dir) => path.join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
  ...windowsDirectories.map((dir) => path.join(dir, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')),
].filter((p): p is string => !!p)

/** The first usable local browser executable, or null when there is none. */
export function findBrowserPath(): string | null {
  for (const p of CHROME_PATHS) {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {
      /* keep looking */
    }
  }
  return null
}

function findBrowser(): string {
  const path = findBrowserPath()
  if (!path) throw new Error('No Chrome/Chromium found. Set CHROME_PATH to a browser executable.')
  return path
}

let browserPromise: Promise<Browser> | null = null

/* Chrome is the heaviest thing the server runs (nine or ten processes once a
   page has rendered), so it is closed when nothing has used it for a while and
   relaunched by the next getBrowser(). Every open page holds a lease from
   before the launch until its close, which is what keeps the idle close from
   ever landing under a page or a launch still in flight. */

const DEFAULT_IDLE_CLOSE_MS = 120_000

/** How long the browser may sit unused before it is closed. CHROME_IDLE_CLOSE_MS
 *  overrides the default (a bad value falls back to it); 0 keeps the browser for
 *  the life of the process. Read on use, so a change takes effect on the next
 *  idle period. */
function idleCloseMs(): number {
  // eslint-disable-next-line no-restricted-syntax -- an optional tuning knob, kept out of server/env.ts so that hot file stays untouched
  const raw = process.env.CHROME_IDLE_CLOSE_MS
  if (raw === undefined || raw.trim() === '') return DEFAULT_IDLE_CLOSE_MS
  const ms = Number(raw)
  return Number.isInteger(ms) && ms >= 0 ? ms : DEFAULT_IDLE_CLOSE_MS
}

let openPages = 0
let idleTimer: ReturnType<typeof setTimeout> | null = null

function cancelIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

function scheduleIdleClose(): void {
  cancelIdleClose()
  const ms = idleCloseMs()
  if (ms === 0 || !browserPromise) return
  idleTimer = setTimeout(() => {
    idleTimer = null
    void closeIdleBrowser()
  }, ms)
  idleTimer.unref()
}

async function closeIdleBrowser(): Promise<void> {
  const closing = browserPromise
  if (openPages > 0 || !closing) return
  /* detach first: a request arriving while Chrome shuts down launches a fresh one */
  browserPromise = null
  const browser = await closing.catch(() => null)
  await browser?.close().catch(() => {})
}

/** The shared browser, launched if there is none or it has died. Only call it
 *  holding a lease (openIsolatedPage): the lease's release schedules the idle close. */
async function getBrowser(): Promise<Browser> {
  for (let current = browserPromise; current; current = browserPromise) {
    const browser = await current
    if (browser.connected) return browser
    /* a crashed Chrome seen by several callers at once is relaunched by the
       first; the rest wait on that launch rather than starting their own */
    if (browserPromise === current) {
      browserPromise = null
      break
    }
  }
  const launching = launchBrowser()
  browserPromise = launching
  /* a launch that failed (a slow cold start past puppeteer's timeout) must not
     be handed to every later caller: the next one tries again */
  launching.catch(() => {
    if (browserPromise === launching) browserPromise = null
  })
  return launching
}

/** A fresh headless Chrome with the server's flags. `timeout` bounds the wait
 *  for its DevTools endpoint (puppeteer's default, 30s, unless given). */
export function launchBrowser(timeout?: number): Promise<Browser> {
  return puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    timeout,
    args: [
      '--no-first-run',
      '--disable-extensions',
      '--disable-quic',
      '--disable-webrtc-multiple-routes',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--hide-scrollbars',
      /* containers: no user namespaces for the sandbox, tiny /dev/shm */
      ...(env.CHROME_NO_SANDBOX ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ],
  })
}

export interface IsolatedPage {
  page: Page
  close: () => Promise<void>
}

/** External pages never share cookies, cache or service workers across users
 *  or imports. Closing the wrapper tears down the entire browser context. */
export async function openIsolatedPage(): Promise<IsolatedPage> {
  openPages++
  cancelIdleClose()
  let released = false
  const release = () => {
    if (released) return
    released = true
    if (--openPages === 0) scheduleIdleClose()
  }
  let context: BrowserContext | undefined
  try {
    const browser = await getBrowser()
    context = await browser.createBrowserContext()
    const page = await context.newPage()
    let closed = false
    const owned = context
    return {
      page,
      close: async () => {
        if (closed) return
        closed = true
        await owned.close().catch(() => {})
        release()
      },
    }
  } catch (error) {
    await context?.close().catch(() => {})
    release()
    throw error
  }
}

export async function loadFramePage(frame: Frame): Promise<IsolatedPage> {
  const loaded = await openIsolatedPage()
  const { page } = loaded
  try {
    const assetOrigin = new URL(env.BETTER_AUTH_URL).origin
    await guardPublicPageRequests(page, {
      allowUrl: (url) =>
        (url.origin === assetOrigin && url.pathname.startsWith('/a/')) ||
        /* webfonts referenced by imported frames (imports request the
           source design's families from Google Fonts) */
        url.origin === 'https://fonts.googleapis.com' ||
        url.origin === 'https://fonts.gstatic.com',
    })
    await page.setViewport({
      width: Math.max(1, Math.round(frame.width)),
      /* A viewport does not need to span an entire imported landing page for
         layout/computed-style inspection; full-page content remains in the DOM. */
      height: Math.max(1, Math.min(Math.round(frame.height), 4000)),
      deviceScaleFactor: 1,
    })
    /* setContent leaves the page on about:blank, where the relative /a/...
       asset URLs of imported frames resolve nowhere. In the app an iframe
       inherits the page origin; here a <base> stands in for it — unless the
       frame brought its own (website imports do). */
    let html = frame.html || '<!doctype html><html><body></body></html>'
    if (!/<base\s/i.test(html)) {
      const baseTag = `<base href="${assetOrigin.replace(/"/g, '&quot;')}/">`
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`) : baseTag + html
    }
    try {
      await page.setContent(html, {
        waitUntil: 'load',
        timeout: 8000,
      })
    } catch {
      /* Slow external resources: inspect whatever has rendered. */
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
    return loaded
  } catch (error) {
    await loaded.close()
    throw error
  }
}

export interface FrameInspection {
  document: { title: string; width: number; height: number; htmlChars: number }
  design: {
    colors: string[]
    backgrounds: string[]
    fonts: string[]
    fontSizes: string[]
    radii: string[]
    shadows: string[]
    cssVariables: Record<string, string>
  }
  elements: Array<{
    selector: string
    tag: string
    role?: string
    text?: string
    rect: { x: number; y: number; width: number; height: number }
    style: { color: string; background: string; font: string; fontSize: string; fontWeight: string }
  }>
}

/** A compact, rendered representation for agents. It intentionally relies on
 * visible text, semantics, geometry and computed styles rather than classes. */
export async function inspectFrame(frame: Frame): Promise<FrameInspection> {
  const loaded = await loadFramePage(frame)
  const { page } = loaded
  try {
    /* tsx/esbuild annotates nested functions with __name; page.evaluate
       serializes the callback without that runtime helper. A tiny in-page
       identity shim keeps the evaluated code independent of the loader. */
    await page.evaluate('globalThis.__name = (target) => target')
    const inspection = await page.evaluate(() => {
      const MAX_ELEMENTS = 64
      const MAX_STYLE_SAMPLES = 500
      const semanticTags = new Set([
        'header',
        'nav',
        'main',
        'section',
        'article',
        'aside',
        'footer',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'p',
        'a',
        'button',
        'input',
        'textarea',
        'select',
        'form',
        'img',
        'ul',
        'ol',
        'table',
      ])

      function visible(el: Element): el is HTMLElement {
        if (!(el instanceof HTMLElement)) return false
        const style = getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) > 0 &&
          rect.width > 1 &&
          rect.height > 1
        )
      }

      function selectorFor(el: Element): string {
        const doopId = el.getAttribute('data-doop-id')
        if (doopId) return `[data-doop-id="${doopId}"]`
        if (el.id && el.id.length < 80) return `#${CSS.escape(el.id)}`
        const parts: string[] = []
        let node: Element | null = el
        while (node && node !== document.body && parts.length < 7) {
          const tag = node.tagName.toLowerCase()
          const parent: Element | null = node.parentElement
          if (!parent) {
            parts.unshift(tag)
            break
          }
          const sameTag = Array.from(parent.children).filter((child: Element) => child.tagName === node!.tagName)
          const suffix = sameTag.length > 1 ? `:nth-of-type(${sameTag.indexOf(node) + 1})` : ''
          parts.unshift(tag + suffix)
          node = parent
        }
        return `body > ${parts.join(' > ')}`
      }

      function cleanText(value: string | null | undefined, max = 180): string | undefined {
        const text = (value || '').replace(/\s+/g, ' ').trim()
        if (!text) return undefined
        return text.length > max ? `${text.slice(0, max - 1)}…` : text
      }

      function normalizedColor(value: string): string | undefined {
        if (!value || value === 'rgba(0, 0, 0, 0)' || value === 'transparent') return undefined
        return value
      }

      const counts = {
        colors: new Map<string, number>(),
        backgrounds: new Map<string, number>(),
        fonts: new Map<string, number>(),
        fontSizes: new Map<string, number>(),
        radii: new Map<string, number>(),
        shadows: new Map<string, number>(),
      }
      const bump = (map: Map<string, number>, value?: string) => {
        if (value) map.set(value, (map.get(value) || 0) + 1)
      }

      const all = Array.from(document.body.querySelectorAll('*')).filter(visible)
      for (const el of all.slice(0, MAX_STYLE_SAMPLES)) {
        const style = getComputedStyle(el)
        bump(counts.colors, normalizedColor(style.color))
        bump(counts.backgrounds, normalizedColor(style.backgroundColor))
        bump(counts.fonts, style.fontFamily)
        bump(counts.fontSizes, style.fontSize)
        if (style.borderRadius !== '0px') bump(counts.radii, style.borderRadius)
        if (style.boxShadow !== 'none') bump(counts.shadows, style.boxShadow)
      }

      const semantic = all
        .filter((el) => semanticTags.has(el.tagName.toLowerCase()) || !!el.getAttribute('role'))
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      const candidates: HTMLElement[] = []
      const selected = new Set<HTMLElement>()
      const take = (limit: number, predicate: (el: HTMLElement) => boolean) => {
        for (const el of semantic) {
          if (candidates.length >= MAX_ELEMENTS || limit <= 0) break
          if (selected.has(el) || !predicate(el)) continue
          selected.add(el)
          candidates.push(el)
          limit--
        }
      }
      take(18, (el) =>
        ['header', 'nav', 'main', 'section', 'article', 'aside', 'footer'].includes(el.tagName.toLowerCase()),
      )
      take(16, (el) => /^h[1-6]$/.test(el.tagName.toLowerCase()))
      take(
        16,
        (el) =>
          ['button', 'a', 'input', 'textarea', 'select', 'form'].includes(el.tagName.toLowerCase()) ||
          !!el.getAttribute('role'),
      )
      take(14, (el) => ['p', 'img', 'ul', 'ol', 'table'].includes(el.tagName.toLowerCase()))
      take(MAX_ELEMENTS - candidates.length, () => true)

      const elements = candidates.map((el) => {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        const image = el instanceof HTMLImageElement ? cleanText(el.alt || el.getAttribute('aria-label')) : undefined
        return {
          selector: selectorFor(el),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || undefined,
          text: image || cleanText(el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder')),
          rect: {
            x: Math.round(rect.left + scrollX),
            y: Math.round(rect.top + scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          style: {
            color: style.color,
            background: style.backgroundColor,
            font: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
          },
        }
      })

      const top = (map: Map<string, number>, limit: number) =>
        [...map.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([value]) => value)
      const rootStyle = getComputedStyle(document.documentElement)
      const cssVariables: Record<string, string> = {}
      for (const name of Array.from(rootStyle)) {
        if (!name.startsWith('--') || Object.keys(cssVariables).length >= 40) continue
        const value = rootStyle.getPropertyValue(name).trim()
        if (value && value.length <= 160) cssVariables[name] = value
      }

      return {
        title: document.title,
        design: {
          colors: top(counts.colors, 10),
          backgrounds: top(counts.backgrounds, 10),
          fonts: top(counts.fonts, 8),
          fontSizes: top(counts.fontSizes, 10),
          radii: top(counts.radii, 8),
          shadows: top(counts.shadows, 6),
          cssVariables,
        },
        elements,
      }
    })

    return {
      document: {
        title: inspection.title,
        width: Math.round(frame.width),
        height: Math.round(frame.height),
        htmlChars: frame.html.length,
      },
      design: inspection.design,
      elements: inspection.elements,
    }
  } finally {
    await loaded.close()
  }
}

export async function renderFrame(
  frame: Frame,
  /* output pixel density — fractional values downscale huge frames */
  scale: number = 1,
  opts: { type?: 'png' | 'jpeg'; quality?: number; maxHeight?: number } = {},
): Promise<Buffer> {
  const loaded = await loadFramePage(frame)
  const { page } = loaded
  try {
    await page.setViewport({
      width: Math.max(1, Math.round(frame.width)),
      height: Math.max(1, Math.round(frame.height)),
      deviceScaleFactor: scale,
    })
    const type = opts.type ?? 'png'
    const clip =
      opts.maxHeight && frame.height > opts.maxHeight
        ? { x: 0, y: 0, width: Math.round(frame.width), height: Math.round(opts.maxHeight) }
        : undefined
    const buf = await page.screenshot({
      type,
      ...(type === 'jpeg' ? { quality: opts.quality ?? 90 } : {}),
      ...(clip ? { clip } : {}),
    })
    return Buffer.from(buf)
  } finally {
    await loaded.close()
  }
}
