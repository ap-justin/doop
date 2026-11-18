import type { FaceReplacement, FontScope } from '../shared/fonts.ts'

/**
 * A font library's faces were replaced by an upload. The library module only
 * announces it; whoever owns frame writes listens (server/actions.ts), so the
 * library needs no import of the frame store.
 */
export interface FacesReplaced {
  scope: FontScope
  /** the person whose library it is, for a personal scope */
  userId: string
  replaced: FaceReplacement[]
}

type Listener = (event: FacesReplaced) => void | Promise<void>

const listeners: Listener[] = []

export function onFacesReplaced(listener: Listener): void {
  listeners.push(listener)
}

export async function announceFacesReplaced(event: FacesReplaced): Promise<void> {
  for (const listener of listeners) await listener(event)
}
