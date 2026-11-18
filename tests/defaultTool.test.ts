// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas } from '../shared/types'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { useStore, defaultTool } = await import('../src/lib/store')

const canvas = (id: string, role: Canvas['role']): Canvas => ({ id, name: id, frames: [], role }) as unknown as Canvas

beforeEach(() => {
  useStore.getState().setCanvas(null)
  useStore.getState().setTool('select')
})

describe('default tool', () => {
  it('is Comment for anyone who may comment, Select for a viewer', () => {
    expect(defaultTool('edit')).toBe('comment')
    expect(defaultTool('comment')).toBe('comment')
    expect(defaultTool('view')).toBe('select')
  })

  it('a commenter opens a canvas in Comment, a viewer stays on Select', () => {
    useStore.getState().setCanvas(canvas('a', 'edit'))
    expect(useStore.getState().tool).toBe('comment')
    useStore.getState().setCanvas(null)
    useStore.getState().setCanvas(canvas('v', 'view'))
    expect(useStore.getState().tool).toBe('select')
  })

  it('a role that arrives after the canvas switches Select to Comment', () => {
    useStore.getState().setCanvas(canvas('a', 'view'))
    useStore.getState().setRole('comment')
    expect(useStore.getState().tool).toBe('comment')
  })

  it('a deliberate Edit (V) survives a repeated role update', () => {
    useStore.getState().setCanvas(canvas('a', 'edit'))
    useStore.getState().setTool('select')
    useStore.getState().setRole('edit')
    expect(useStore.getState().tool).toBe('select')
  })

  it('leaving and reopening a canvas opens in Comment again', () => {
    useStore.getState().setCanvas(canvas('a', 'edit'))
    useStore.getState().setTool('select')
    useStore.getState().setCanvas(null)
    useStore.getState().setCanvas(canvas('a', 'edit'))
    expect(useStore.getState().tool).toBe('comment')
  })
})
