import { expect, it, vi } from 'vitest'
import { announceFacesReplaced, onFacesReplaced, type FacesReplaced } from '../server/fontReplaced.ts'

/* The announcement follows an upload that is already stored: a listener that throws
   is logged, the others still hear it, and the caller is never told it failed. */

it('isolates a failing listener', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const heard: FacesReplaced[] = []
  onFacesReplaced(() => {
    throw new Error('canvas would not load')
  })
  onFacesReplaced((event) => void heard.push(event))
  const event: FacesReplaced = { scope: { personal: true }, userId: 'u1', replaced: [] }
  expect(() => announceFacesReplaced(event)).not.toThrow()
  expect(heard).toEqual([event])
  expect(error).toHaveBeenCalledOnce()
  error.mockRestore()
})
