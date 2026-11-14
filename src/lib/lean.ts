import { useSyncExternalStore } from 'react'

/* Whether the server runs in lean mode (server/lean.ts): settled from
   GET /api/locale-config before the first render (initLocale), and off until
   then. When that request fails, the value the server last reported to this
   browser stands; with none cached, a server that cannot say keeps the full
   interface.
   Lean hides the entry points to what the server turned off. */
let lean = false
const listeners = new Set<() => void>()

export function isLean(): boolean {
  return lean
}

export function setLean(next: boolean): void {
  if (next === lean) return
  lean = next
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether lean mode is on; re-renders if it is settled after mount. */
export function useLean(): boolean {
  return useSyncExternalStore(subscribe, isLean)
}
