import { useSyncExternalStore } from 'react'
import { FALLBACK_LOCALE, isLocale, type Locale, type LocaleConfig } from '../../../shared/locales'
import { setLean } from '../lean'

export { LOCALES, LOCALE_NAMES, isLocale, type Locale } from '../../../shared/locales'

/* Per browser, not per account, like the theme: it is how this device reads. */
export const LOCALE_STORAGE_KEY = 'doop-locale'
const LEAN_STORAGE_KEY = 'doop-lean'

/* A slow or unreachable server must not hold the first paint for long. */
const CONFIG_TIMEOUT_MS = 1500

/* The language picked in this browser, if any, and the one the server shows
   to everyone else (its DEFAULT_LOCALE). A pick wins over the server. */
let picked: Locale | null | undefined
let serverDefault: Locale = FALLBACK_LOCALE
const listeners = new Set<() => void>()

function readStored(): Locale | null {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY)
    return isLocale(stored) ? stored : null
  } catch {
    return null
  }
}

function getPicked(): Locale | null {
  if (picked === undefined) picked = readStored()
  return picked
}

export function getLocale(): Locale {
  return getPicked() ?? serverDefault
}

/* lang tells the browser (hyphenation, screen readers, its own translator)
   what the page is written in */
function mark(): void {
  document.documentElement.lang = getLocale()
}

type LocaleState = { locale: Locale; picked: boolean }

/* useSyncExternalStore wants the same object back until something changed,
   so the snapshot is cached and dropped on every notification */
let snapshot: LocaleState | null = null

function getSnapshot(): LocaleState {
  if (!snapshot) snapshot = { locale: getLocale(), picked: getPicked() !== null }
  return snapshot
}

function notify(): void {
  snapshot = null
  mark()
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setLocale(locale: Locale): void {
  picked = locale
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    /* nowhere to keep it — the choice still holds until the tab closes */
  }
  notify()
}

type ServerConfig = { defaultLocale: Locale | null; lean: boolean }

/** The server's answer, or null when it gave none in time. Never rejects. */
async function fetchConfig(): Promise<ServerConfig | null> {
  try {
    const res = await fetch('/api/locale-config', { signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS) })
    if (!res.ok) return null
    const config = (await res.json()) as Partial<LocaleConfig>
    return { defaultLocale: isLocale(config.defaultLocale) ? config.defaultLocale : null, lean: config.lean === true }
  } catch {
    return null
  }
}

/** The last lean value the server reported to this origin, kept so a return
 *  visit can render at once. */
function cachedLean(): boolean | null {
  try {
    const value = localStorage.getItem(LEAN_STORAGE_KEY)
    return value === '1' ? true : value === '0' ? false : null
  } catch {
    return null
  }
}

function applyConfig(config: ServerConfig | null): void {
  setLean(config?.lean ?? false)
  /* kept even under a pick, so a pick cleared later falls back to it */
  serverDefault = config?.defaultLocale ?? FALLBACK_LOCALE
  try {
    if (config) localStorage.setItem(LEAN_STORAGE_KEY, config.lean ? '1' : '0')
  } catch {
    /* nowhere to keep it: the next visit asks again */
  }
  snapshot = null
  mark()
}

/** Settles the language and lean mode before React mounts. A browser with a
 *  picked language and a cached lean value renders at once and refreshes both
 *  from the server's answer; any other waits for that one short request (the
 *  server's default language, otherwise English; lean only when it says so).
 *  Then follows picks made in other tabs. */
export async function initLocale(): Promise<void> {
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== LOCALE_STORAGE_KEY) return
    picked = undefined
    notify()
  })
  const lean = cachedLean()
  if (getPicked() && lean !== null) {
    setLean(lean)
    snapshot = null
    mark()
    void fetchConfig().then((config) => {
      if (config) applyConfig(config)
    })
    return
  }
  applyConfig(await fetchConfig())
}

/** The active language, whether this browser picked it (rather than taking
 *  the server's default), and the setter. Re-renders when it changes here or
 *  in another tab. */
export function useLocale(): LocaleState & { setLocale: (locale: Locale) => void } {
  const state = useSyncExternalStore(subscribe, getSnapshot)
  return { ...state, setLocale }
}
