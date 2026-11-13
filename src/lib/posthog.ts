import type { BeforeSendFn } from 'posthog-js/dist/module.no-external'
import { isLean } from './lean'

/* The app's one door to analytics. The PostHog bundle (posthogClient.ts) is
   loaded on its own chunk once lean mode is settled, and never in lean mode,
   where the server has no relay to send to. Calls made before it arrives wait
   for it; in lean mode, or when the chunk fails to load, they do nothing. */

type Client = typeof import('./posthogClient')
type PostHog = Client['posthog']

let client: Client | null = null
let off = false
let pending: ((client: Client) => void)[] = []

function call(run: (client: Client) => void): void {
  if (client) run(client)
  else if (!off) pending.push(run)
}

/* PostHog's own error handlers start with the client, after the first paint;
   until then errors are caught here and sent once it arrives, so a crash in
   startup or the first render is still recorded. Capped, since a broken
   render loop can throw every frame. */
const MAX_EARLY_ERRORS = 20
let earlyErrors = 0

function queueEarlyError(error: unknown): void {
  if (earlyErrors >= MAX_EARLY_ERRORS) return
  earlyErrors += 1
  call((c) => void c.posthog.captureException(error))
}
const onEarlyError = (event: ErrorEvent) => queueEarlyError(event.error ?? event.message)
const onEarlyRejection = (event: PromiseRejectionEvent) => queueEarlyError(event.reason)

window.addEventListener('error', onEarlyError)
window.addEventListener('unhandledrejection', onEarlyRejection)

function stopCatchingEarlyErrors(): void {
  window.removeEventListener('error', onEarlyError)
  window.removeEventListener('unhandledrejection', onEarlyRejection)
}

/* The address the page loaded at: by the time the client starts, Home and
   Workspace may have stripped its query (?scope, ?checkout). */
const landing = new URL(location.href)
let landingReported = false

/** PostHog's before_send: the first page view reports the address the page
 *  loaded at, unless the person has moved to another page since. */
export const reportLandingUrl: BeforeSendFn = (event) => {
  if (!event || event.event !== '$pageview' || landingReported) return event
  landingReported = true
  if (location.pathname === landing.pathname) event.properties.$current_url = landing.href
  return event
}

function stop(): void {
  off = true
  pending = []
  stopCatchingEarlyErrors()
}

/** Loads and starts analytics, unless the server runs lean. Call once, after
 *  lean mode is settled (initLocale). */
export async function loadAnalytics(): Promise<void> {
  if (isLean()) return stop()
  try {
    client = await import('./posthogClient')
  } catch {
    return stop()
  }
  stopCatchingEarlyErrors()
  const waiting = pending
  pending = []
  for (const run of waiting) run(client)
}

export const posthog = {
  capture: (...args: Parameters<PostHog['capture']>) => call((c) => void c.posthog.capture(...args)),
  identify: (...args: Parameters<PostHog['identify']>) => call((c) => c.posthog.identify(...args)),
  reset: (...args: Parameters<PostHog['reset']>) => call((c) => c.posthog.reset(...args)),
}

export function syncReplayForUser(email: string | null | undefined): void {
  call((c) => c.syncReplayForUser(email))
}

export function suspendAnalyticsWhileImpersonating(): void {
  call((c) => c.suspendAnalyticsWhileImpersonating())
}

export function setSupportWidgetVisible(visible: boolean): void {
  call((c) => c.setSupportWidgetVisible(visible))
}

/** Opens the support chat; false when there is none to open. */
export function openSupportChat(): boolean {
  return client?.openSupportChat() ?? false
}
