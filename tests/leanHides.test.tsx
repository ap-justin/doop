// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas } from '../shared/types'

/* What lean mode swaps or hides because the in-app Doop Agent is gone. */

vi.mock('../src/lib/api', () => ({
  api: {
    addCard: vi.fn(() => Promise.resolve({})),
    agentAllowance: vi.fn(() => Promise.resolve({ used: 0, limit: 5, byoModel: false })),
    agentRunners: () => Promise.resolve({ runners: [] }),
  },
  ApiError: class ApiError extends Error {},
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'alice' } } }) } }))
vi.mock('../src/lib/frameClipboard', () => ({ uploadImageFrames: () => Promise.resolve([]) }))
vi.mock('../src/components/ChatPanel', () => ({ ChatPanel: () => null }))
vi.mock('../src/components/MemoryPanel', () => ({ MemoryPanel: () => null }))
vi.mock('../src/components/ModelAccount', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ModelAccountPanel: () => null,
}))
vi.mock('../src/components/ImageModelCard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ImageModelCard: () => null,
}))
vi.mock('../src/components/DashShell', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  AccountMenu: () => null,
}))

const { useStore } = await import('../src/lib/store')
const { setLean } = await import('../src/lib/lean')
const { ActivityPanel } = await import('../src/components/ActivityPanel')
const { TooltipProvider } = await import('../src/components/ui/tooltip')
const { GeneralSettings } = await import('../src/components/GeneralSettings')
const { Settings } = await import('../src/pages/Settings')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const canvas = { id: 'c1', name: 'Canvas', frames: [], pages: [] } as unknown as Canvas

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

describe('the Agents tab with no tasks', () => {
  beforeEach(() => {
    useStore.setState({ canvas, tasks: [], panelTab: 'tasks', composerFocusAt: 0, composerDrafts: {} })
  })

  async function renderPanel() {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ActivityPanel canvasId="c1" onClose={() => {}} />
        </TooltipProvider>,
      ),
    )
  }

  it('points at the composer below when lean is off', async () => {
    await renderPanel()
    expect(container.textContent).toContain('Ask the Doop Agent below')
  })

  it('points at connecting an MCP agent when lean is on', async () => {
    setLean(true)
    await renderPanel()
    expect(container.textContent).toContain('No tasks yet. Connect an MCP agent')
    expect(container.textContent).not.toContain('Ask the Doop Agent below')
  })
})

describe('Settings → General', () => {
  const promptBoxSwitch = () => container.querySelector('#show-prompt-box')

  it('offers the Show Prompt Box switch when lean is off', async () => {
    await act(async () => root.render(<GeneralSettings />))
    expect(promptBoxSwitch()).not.toBeNull()
  })

  it('drops the Show Prompt Box card when lean is on', async () => {
    setLean(true)
    await act(async () => root.render(<GeneralSettings />))
    expect(promptBoxSwitch()).toBeNull()
    expect(container.textContent).not.toContain('Show Prompt Box')
  })
})

describe('Settings opened on the Doop Agent pane', () => {
  const heading = () => container.querySelector('h1')?.textContent

  it('falls back to General when lean turns on after it opened', async () => {
    await act(async () => root.render(<Settings />))
    expect(heading()).toBe('Doop Agent')

    await act(async () => setLean(true))
    expect(heading()).toBe('General')
    expect(container.textContent).toContain('Make Doop work the way you like in this browser.')
    expect(container.textContent).not.toContain('Your connections, and the one the agent runs on')
  })
})
