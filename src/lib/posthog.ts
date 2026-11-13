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

function stop(): void {
  off = true
  pending = []
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
