// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, ElementComment } from '../shared/types'
import { en } from '../src/lib/i18n/en'

/* A lean server has no resident agent: a comment's @mention is plain text, so
   the comment surfaces drop the agent chips, the "will pick up" hint, the
   retry of a stopped agent request and the "ask the agent" placeholders. */

vi.mock('../src/App', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { setLean } = await import('../src/lib/lean')
const { useStore } = await import('../src/lib/store')
const { CommentComposer, CommentThread } = await import('../src/components/CommentPopovers')
const { CommentsPanel } = await import('../src/components/CommentsPanel')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function mount(node: ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
}

/** React reads a field's value through its native setter. */
async function type(field: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!
  await act(async () => {
    setValue.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const comment = (over: Partial<ElementComment>): ElementComment => ({
  id: 'k1',
  canvasId: 'c1',
  pageId: 'p1',
  x: 10,
  y: 20,
  snippet: '',
  from: 'Alice',
  text: 'Make the hero blue',
  at: 1,
  ...over,
})

beforeEach(() => {
  useStore.setState({
    canvas: {
      id: 'c1',
      name: 'Canvas',
      role: 'edit',
      frames: [],
      pages: [{ id: 'p1', name: 'Page 1' }],
    } as unknown as Canvas,
    activePageId: 'p1',
    comments: [],
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.replaceChildren()
  setLean(false)
})

const agentChips = () =>
  [...container.querySelectorAll('button')].filter((b) => /^@\w+/.test(b.textContent?.trim() ?? ''))

describe('the comment composer', () => {
  const composer = () => <CommentComposer onSubmit={vi.fn()} onCancel={vi.fn()} />

  it('offers an @chip per resident agent, and names the one a mention calls on, with lean off', async () => {
    await mount(composer())
    expect(agentChips().length).toBeGreaterThan(0)
    await type(container.querySelector('textarea')!, '@doop make it blue')
    expect(container.textContent).toContain(en.stage.willPickUp.replace('{name}', 'Doop'))
    expect(agentChips()).toHaveLength(0)
  })

  it('has no chips and calls on no agent in lean mode', async () => {
    setLean(true)
    await mount(composer())
    expect(agentChips()).toHaveLength(0)
    await type(container.querySelector('textarea')!, '@doop make it blue')
    expect(container.textContent).not.toContain(en.stage.willPickUp.replace('{name}', 'Doop'))
  })
})

describe('a comment thread', () => {
  const stopped = [comment({ failedAt: 5, failureReason: 'Out of turns', forAgent: true })]
  const thread = () => (
    <CommentThread thread={stopped} onReply={vi.fn(async () => {})} onResolve={vi.fn()} onRetry={vi.fn()} />
  )
  const retry = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(en.stage.retry))
  const placeholder = () => container.querySelector('textarea, input')?.getAttribute('placeholder')

  it('lets an editor retry a stopped agent request and ask the agent with lean off', async () => {
    await mount(thread())
    expect(retry()).toBeDefined()
    expect(placeholder()).toBe(en.stage.replyAskAgent)
  })

  it('shows the stop reason but no retry, and a plain reply field, in lean mode', async () => {
    setLean(true)
    await mount(thread())
    expect(container.textContent).toContain('Out of turns')
    expect(retry()).toBeUndefined()
    expect(placeholder()).toBe(en.stage.replyEllipsis)
  })
})

describe('the comments panel', () => {
  const placeholder = () => container.querySelector('input[aria-label]')?.getAttribute('placeholder')

  beforeEach(() => useStore.setState({ comments: [comment({})] }))

  it('invites a reply to ask the agent with lean off', async () => {
    await mount(<CommentsPanel />)
    expect(placeholder()).toBe(en.stage.replyPanelPlaceholder)
  })

  it('asks for a plain reply in lean mode', async () => {
    setLean(true)
    await mount(<CommentsPanel />)
    expect(placeholder()).toBe(en.stage.replyEllipsis)
  })
})
