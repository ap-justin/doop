// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDetail } from '../shared/types'
import { en } from '../src/lib/i18n/en'

/* The pages a lean server keeps still hide what it turned off: Home has no
   ⌘/ composer and names no plan, a workspace has no plan or checkout. */

const workspace: WorkspaceDetail = {
  id: 'w1',
  name: 'Acme',
  ownerId: 'alice',
  role: 'owner',
  status: 'active',
  active: true,
  plan: 'team',
  interval: 'month',
  seats: 2,
  memberCount: 2,
  canvasCount: 1,
  cancelAtPeriodEnd: false,
  createdAt: 0,
  updatedAt: 0,
  members: [],
  invites: [],
  billing: { enabled: false, portal: false },
}

const mocks = vi.hoisted(() => ({
  syncWorkspaceBilling: vi.fn(() => Promise.resolve({ active: false })),
}))

vi.mock('../src/App', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn(), reset: vi.fn() }, openSupportChat: vi.fn() }))
vi.mock('../src/lib/auth', () => ({
  authClient: { useSession: () => ({ data: { user: { id: 'alice', name: 'Alice Doe' } } }), signOut: vi.fn() },
}))
vi.mock('../src/lib/me', () => ({ useMe: () => ({ plan: 'free', email: 'alice@example.com' }) }))
vi.mock('../src/lib/shell', () => ({ isDesktopShell: () => false, desktopPlatform: () => null }))
vi.mock('../src/hooks/use-user-events', () => ({ useUserEvents: () => {} }))
vi.mock('../src/components/ModelPicker', () => ({ ModelPicker: () => null }))
vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      agentAllowance: () => Promise.resolve({ used: 0, limit: 5, byoModel: false }),
      agentRunners: () => Promise.resolve({ runners: [] }),
      listCanvases: () => Promise.resolve([]),
      listWorkspaces: () => Promise.resolve({ workspaces: [workspace] }),
      getWorkspace: () => Promise.resolve(workspace),
      syncWorkspaceBilling: mocks.syncWorkspaceBilling,
    },
  }
})

const { setLean } = await import('../src/lib/lean')
const { Home } = await import('../src/pages/Home')
const { Workspace } = await import('../src/pages/Workspace')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function mount(node: ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
  /* the page's own fetches settle */
  await act(async () => {})
}

beforeEach(() => {
  mocks.syncWorkspaceBilling.mockClear()
  localStorage.clear()
  history.replaceState(null, '', '/')
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.replaceChildren()
  setLean(false)
})

describe('Home', () => {
  /** What a ⌘/ keypress does to the page: cancelled when something took it. */
  function pressSlash() {
    const press = new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(press)
    return press.defaultPrevented
  }

  it('takes ⌘/ for the composer with lean off', async () => {
    await mount(<Home />)
    expect(pressSlash()).toBe(true)
  })

  it('leaves ⌘/ alone in lean mode, which has no composer', async () => {
    setLean(true)
    await mount(<Home />)
    expect(pressSlash()).toBe(false)
  })

  describe('in a workspace', () => {
    beforeEach(() => history.replaceState(null, '', '/?scope=ws:w1'))
    const header = () => container.querySelector('h2')?.textContent ?? ''

    it('names the workspace plan with lean off', async () => {
      await mount(<Home />)
      expect(header()).toContain(en.home.teamPlan)
    })

    it('names no plan in lean mode, which bills nothing', async () => {
      setLean(true)
      await mount(<Home />)
      expect(header()).toContain('Acme')
      expect(header()).not.toContain(en.home.teamPlan)
    })
  })
})

describe('a workspace page', () => {
  const subtitle = () => container.querySelector('[data-slot="dash-subtitle"]')?.textContent ?? ''

  it('says what the workspace costs, and comes back from checkout on the billing pane, with lean off', async () => {
    history.replaceState(null, '', '/w/w1?checkout=success&session_id=s1')
    await mount(<Workspace workspaceId="w1" />)
    expect(subtitle()).toBe(`2 people · 1 canvas · ${en.workspace.selfHostedIncluded}`)
    expect(mocks.syncWorkspaceBilling).toHaveBeenCalledWith('w1', 's1')
  })

  it('names no plan and syncs no checkout in lean mode', async () => {
    setLean(true)
    history.replaceState(null, '', '/w/w1?checkout=success&session_id=s1')
    await mount(<Workspace workspaceId="w1" />)
    expect(subtitle()).toBe('2 people · 1 canvas')
    expect(mocks.syncWorkspaceBilling).not.toHaveBeenCalled()
  })
})
