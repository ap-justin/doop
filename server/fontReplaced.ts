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

type Listener = (event: FacesReplaced) => void

const listeners: Listener[] = []

export function onFacesReplaced(listener: Listener): void {
  listeners.push(listener)
}

/** Never throws: the upload it follows is already stored, so a listener's failure is
 *  logged rather than turned into a failed upload. */
export function announceFacesReplaced(event: FacesReplaced): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (err) {
      console.error('[fonts] refreshing what used a replaced face failed:', err)
    }
  }
}
