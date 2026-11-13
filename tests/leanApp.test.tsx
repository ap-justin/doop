// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* The router: lean mode lands the pages of what it turned off on Home, address
   bar included, and starts no desktop-Claude poller for an agent it lacks. */

const mocks = vi.hoisted(() => ({ startLocalAgent: vi.fn(() => () => {}) }))

vi.mock('../src/lib/localAgent', () => ({ startLocalAgent: mocks.startLocalAgent }))
vi.mock('../src/lib/auth', () => ({
  authClient: { useSession: () => ({ data: { user: { id: 'alice', name: 'Alice Doe' } }, isPending: false }) },
}))
vi.mock('../src/lib/me', () => ({ useMe: () => ({ impersonating: false }) }))
vi.mock('../src/lib/desktop', () => ({ setTabsUser: vi.fn() }))
vi.mock('../src/components/DesktopTabs', () => ({ DesktopTabs: () => null, ShellDragBar: () => null }))
vi.mock('../src/lib/posthog', () => ({
  posthog: { capture: vi.fn(), identify: vi.fn(), reset: vi.fn() },
  setSupportWidgetVisible: vi.fn(),
  syncReplayForUser: vi.fn(),
  suspendAnalyticsWhileImpersonating: vi.fn(),
}))
vi.mock('../src/pages/Home', () => ({ Home: () => <p>page:home</p> }))
vi.mock('../src/pages/Community', () => ({ Community: () => <p>page:community</p> }))
vi.mock('../src/pages/Integrations', () => ({ Integrations: () => <p>page:integrations</p> }))
vi.mock('../src/pages/Automations', () => ({ Automations: () => <p>page:automations</p> }))
vi.mock('../src/pages/AutomationEditor', () => ({ AutomationEditor: () => <p>page:automation-editor</p> }))
vi.mock('../src/pages/Settings', () => ({ Settings: () => <p>page:settings</p> }))
vi.mock('../src/pages/Workspace', () => ({ Workspace: () => <p>page:workspace</p> }))
vi.mock('../src/pages/CanvasPage', () => ({ CanvasPage: () => <p>page:canvas</p> }))
vi.mock('../src/pages/PrototypePage', () => ({ PrototypePage: () => <p>page:prototype</p> }))
vi.mock('../src/pages/Admin', () => ({ Admin: () => <p>page:admin</p> }))

const { setLean } = await import('../src/lib/lean')
const { App, navigate } = await import('../src/App')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function mountAt(path: string) {
  history.replaceState(null, '', path)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<App />))
}

beforeEach(() => mocks.startLocalAgent.mockClear())
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  history.replaceState(null, '', '/')
  setLean(false)
})

describe('the pages lean mode turns off', () => {
  const pages = [
    ['/community', 'page:community'],
    ['/integrations?linearError=denied', 'page:integrations'],
    ['/automations', 'page:automations'],
    ['/automations/a1', 'page:automation-editor'],
  ] as const

  it.each(pages)('opens %s with lean off', async (path, page) => {
    await mountAt(path)
    expect(container.textContent).toBe(page)
  })

  it.each(pages)('lands %s on Home in lean mode, address bar and all', async (path) => {
    setLean(true)
    await mountAt(path)
    expect(container.textContent).toBe('page:home')
    expect(location.pathname + location.search).toBe('/')
  })

  it('lands a page the person navigates to on Home too', async () => {
    setLean(true)
    await mountAt('/settings')
    expect(container.textContent).toBe('page:settings')
    await act(async () => navigate('/community'))
    expect(container.textContent).toBe('page:home')
    expect(location.pathname).toBe('/')
  })

  it('keeps the pages it leaves on', async () => {
    setLean(true)
    await mountAt('/w/w1?pane=fonts')
    expect(container.textContent).toBe('page:workspace')
  })
})

describe('the desktop Claude poller', () => {
  it('runs for the signed-in account with lean off', async () => {
    await mountAt('/')
    expect(mocks.startLocalAgent).toHaveBeenCalledWith('alice')
  })

  it('never starts in lean mode, which has no in-app agent', async () => {
    setLean(true)
    await mountAt('/')
    expect(mocks.startLocalAgent).not.toHaveBeenCalled()
  })
})
