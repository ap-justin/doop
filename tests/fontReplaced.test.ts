import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FacesReplaced } from '../server/fontReplaced.ts'

/* The announcement follows an upload that is already stored: a listener that throws
   is logged, the others still hear it, and the caller is never told it failed.
   The listener registry is module-global, so each test loads its own copy of the module. */

const event: FacesReplaced = { scope: { personal: true }, userId: 'u1', replaced: [] }

let replaced: typeof import('../server/fontReplaced.ts')

beforeEach(async () => {
  vi.resetModules()
  replaced = await import('../server/fontReplaced.ts')
})

afterEach(() => vi.restoreAllMocks())

it('isolates a failing listener', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const heard: FacesReplaced[] = []
  replaced.onFacesReplaced(() => {
    throw new Error('canvas would not load')
  })
  replaced.onFacesReplaced((e) => void heard.push(e))
  expect(() => replaced.announceFacesReplaced(event)).not.toThrow()
  expect(heard).toEqual([event])
  expect(error).toHaveBeenCalledOnce()
})

it('does not carry listeners over from another test', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const heard: FacesReplaced[] = []
  replaced.onFacesReplaced((e) => void heard.push(e))
  replaced.announceFacesReplaced(event)
  expect(heard).toEqual([event])
  expect(error).not.toHaveBeenCalled()
})
