// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* What lean mode changes in the comment boxes: no @doop role chips or hints. */

vi.mock('../src/components/TeamAllowance', () => ({ isResidentLimit: () => false }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { setLean } = await import('../src/lib/lean')
const { useStore } = await import('../src/lib/store')
const { CommentComposer, CommentThread } = await import('../src/components/CommentPopovers')
const { CommentsPanel } = await import('../src/components/CommentsPanel')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  setLean(false)
})

describe('the comment composer', () => {
  const render = () =>
    act(async () =>
      root.render(
        <TooltipProvider>
          <CommentComposer onSubmit={() => {}} onCancel={() => {}} />
        </TooltipProvider>,
      ),
    )

  it('offers the @doop role chips when lean is off', async () => {
    await render()
    expect(container.textContent).toContain('@doop')
  })

  it('offers no role chips when lean is on', async () => {
    setLean(true)
    await render()
    expect(container.textContent).not.toContain('@doop')
  })

  it('says the agent will pick a typed @doop mention up only when lean is off', async () => {
    const type = async () => {
      const field = container.querySelector('textarea')!
      await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
        set.call(field, '@doop make it bolder')
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await render()
    await type()
    expect(container.textContent).toContain('will pick this up')
    setLean(true)
    await act(async () => {})
    await type()
    expect(container.textContent).not.toContain('will pick this up')
  })
})

describe('a comment thread', () => {
  const thread = [
    { id: 'k1', canvasId: 'c1', from: 'Alice', text: 'Hi', at: 1, frameId: 'f1' },
  ] as unknown as Parameters<typeof CommentThread>[0]['thread']

  const render = async () => {
    useStore.setState({ canvas: { id: 'c1', role: 'edit' } as never })
    await act(async () =>
      root.render(
        <TooltipProvider>
          <CommentThread thread={thread} onReply={() => Promise.resolve()} onResolve={() => {}} onRetry={() => {}} />
        </TooltipProvider>,
      ),
    )
  }

  it('invites an @doop reply when lean is off, and a plain one when it is on', async () => {
    await render()
    expect(container.querySelector('textarea')?.getAttribute('placeholder') ?? '').toContain('@doop')
    setLean(true)
    await act(async () => {})
    expect(container.querySelector('textarea')?.getAttribute('placeholder')).toBe('Reply…')
  })
})

describe('the comments panel reply field', () => {
  const render = async () => {
    useStore.setState({
      canvas: {
        id: 'c',
        role: 'edit',
        pages: [{ id: 'p', name: 'Page' }],
        frames: [{ id: 'f', pageId: 'p', name: 'Hero' }],
      } as never,
      activePageId: 'p',
      comments: [{ id: 'r', canvasId: 'c', from: 'Ada', text: 'Review', at: 1, snippet: '', frameId: 'f' }],
    })
    await act(async () => root.render(<CommentsPanel />))
  }
  const placeholder = () => container.querySelector('input[aria-label^="Reply to"]')?.getAttribute('placeholder')

  it('hints at @doop when lean is off', async () => {
    await render()
    expect(placeholder()).toContain('@doop')
  })

  it('asks for a plain reply when lean is on', async () => {
    setLean(true)
    await render()
    expect(placeholder()).toBe('Reply…')
  })
})
