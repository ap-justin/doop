// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, WorkspaceSummary } from '../shared/types'
import { en } from '../src/lib/i18n/en'

/* Lean mode hides the entry points to what the server turned off, and leaves
   no empty section behind; off, every surface lists exactly what it did. */

const mocks = vi.hoisted(() => ({
  agentAllowance: vi.fn(() => Promise.resolve({ used: 0, limit: 5, byoModel: false })),
}))

vi.mock('../src/App', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn(), reset: vi.fn() }, openSupportChat: vi.fn() }))
vi.mock('../src/lib/auth', () => ({
  authClient: { useSession: () => ({ data: { user: { id: 'alice', name: 'Alice Doe' } } }), signOut: vi.fn() },
}))
vi.mock('../src/lib/me', () => ({ useMe: () => ({ plan: 'free', email: 'alice@example.com' }) }))
vi.mock('../src/lib/shell', () => ({ isDesktopShell: () => false, desktopPlatform: () => null }))
vi.mock('../src/components/ModelPicker', () => ({ ModelPicker: () => null }))
vi.mock('../src/components/MemoryPanel', () => ({ MemoryPanel: () => null }))
/* the panes' own content is not under test, only which panes are offered */
vi.mock('../src/components/ModelAccount', () => ({ ModelAccountPanel: () => <p>model accounts</p> }))
vi.mock('../src/components/ImageModelCard', () => ({ ImageModelCard: () => null }))
vi.mock('../src/components/AgentKeys', () => ({ AgentKeys: () => <p>agent keys</p> }))
vi.mock('../src/components/Webhooks', () => ({ Webhooks: () => null }))
vi.mock('../src/components/FontLibrary', () => ({ FontLibrary: () => null }))
vi.mock('../src/components/AccountSettings', () => ({ AccountSettings: () => null }))
vi.mock('../src/components/AppearanceSettings', () => ({ AppearanceSettings: () => null }))
vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      agentAllowance: mocks.agentAllowance,
      agentRunners: () => Promise.resolve({ runners: [] }),
      listMembers: () => Promise.resolve([]),
      listWorkspaces: () => Promise.resolve({ workspaces: [] }),
      listCanvases: () => Promise.resolve([]),
    },
  }
})

const { setLean } = await import('../src/lib/lean')
const { useStore } = await import('../src/lib/store')
const { AppRail, workspacePanesFor } = await import('../src/components/AppRail')
const { AccountMenu } = await import('../src/components/DashShell')
const { Settings } = await import('../src/pages/Settings')
const { HomeHero } = await import('../src/components/HomeHero')
const { ShareModal } = await import('../src/components/ShareModal')
const { ActivityPanel } = await import('../src/components/ActivityPanel')
const { importSources } = await import('../src/components/importSourceList')
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

beforeEach(() => {
  mocks.agentAllowance.mockClear()
  localStorage.clear()
  history.replaceState(null, '', '/')
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.replaceChildren()
  setLean(false)
})

const texts = (selector: string, scope: ParentNode = container) =>
  [...scope.querySelectorAll(selector)].map((el) => el.textContent?.trim() ?? '')

/* every section label still heads a group with something in it */
function expectNoEmptySections(scope: ParentNode = container) {
  for (const label of scope.querySelectorAll('[data-slot="dash-section-label"]')) {
    const group = label.nextElementSibling
    expect(group?.querySelector('[data-slot="dash-nav-item"]'), label.textContent ?? '').not.toBeNull()
  }
}

const workspace: WorkspaceSummary = {
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
}

describe('the app rail', () => {
  const rail = () => <AppRail active="ws:w1" canvases={[]} workspaces={[workspace]} />
  const hidden = [en.rail.explore, en.rail.community, en.rail.resources, en.rail.automations, en.rail.integrations]

  it('lists explore, resources and the billing pane with lean off', async () => {
    await mount(rail())
    const items = texts('[data-slot="dash-nav-item"]')
    expect(items).toEqual(expect.arrayContaining([en.rail.community, en.rail.automations, en.rail.integrations]))
    expect(items).toContain(en.rail.workspaceBilling)
    expect(texts('[data-slot="dash-section-label"]')).toEqual([
      en.rail.workspaces,
      en.rail.explore,
      en.rail.resources,
      en.rail.agents,
    ])
  })

  it('drops them in lean mode and leaves no empty section', async () => {
    setLean(true)
    await mount(rail())
    const all = [...texts('[data-slot="dash-nav-item"]'), ...texts('[data-slot="dash-section-label"]')]
    for (const label of [...hidden, en.rail.workspaceBilling]) expect(all).not.toContain(label)
    expect(texts('[data-slot="dash-section-label"]')).toEqual([en.rail.workspaces, en.rail.agents])
    expect(texts('[data-slot="dash-nav-item"]')).toContain(en.rail.workspaceFonts)
    expectNoEmptySections()
  })

  it('drops them from the narrow rail too, without a doubled rule', async () => {
    localStorage.setItem('doop-rail', 'narrow')
    const labels = () => [...container.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
    await mount(rail())
    expect(labels()).toEqual(expect.arrayContaining([en.rail.community, en.rail.automations, en.rail.integrations]))
    expect(labels()).toContain(`Acme: ${en.rail.workspaceBilling}`)
    await act(async () => root.unmount())
    container.remove()

    setLean(true)
    await mount(rail())
    for (const label of [en.rail.community, en.rail.automations, en.rail.integrations])
      expect(labels()).not.toContain(label)
    expect(labels()).not.toContain(`Acme: ${en.rail.workspaceBilling}`)
    const rules = [...container.querySelectorAll('div.bg-line')]
    for (const rule of rules) expect(rule.nextElementSibling?.classList.contains('bg-line')).toBe(false)
  })

  it('offers the billing pane only off lean, to owners and admins', () => {
    expect(workspacePanesFor('owner', false)).toEqual(['members', 'fonts', 'billing', 'general'])
    expect(workspacePanesFor('owner', true)).toEqual(['members', 'fonts', 'general'])
    expect(workspacePanesFor('member', false)).toEqual(['members', 'fonts'])
    expect(workspacePanesFor('member', true)).toEqual(['members', 'fonts'])
  })
})

describe('settings', () => {
  const allPanes = [
    en.settings.generalTitle,
    en.settings.agentTitle,
    en.settings.fontsTitle,
    en.settings.keysTitle,
    en.settings.webhooksTitle,
    en.settings.accountTitle,
    en.settings.appearanceTitle,
  ]
  const allTabs = allPanes.map((pane) => (pane === en.settings.accountTitle ? en.settings.accountTab : pane))
  const sidebar = () => texts('aside [data-slot="dash-nav-item"]').slice(1)

  it('lists every pane and opens on the agent with lean off', async () => {
    await mount(<Settings />)
    expect(sidebar()).toEqual(allPanes)
    expect(texts('[role="tab"]')).toEqual(allTabs)
    expect(container.textContent).toContain('model accounts')
    expect(mocks.agentAllowance).toHaveBeenCalled()
  })

  it('shows the prompt box switch on General with lean off', async () => {
    history.replaceState(null, '', '/settings?pane=general')
    await mount(<Settings />)
    expect(container.querySelector('#show-prompt-box')).not.toBeNull()
  })

  it('drops the agent pane in lean mode, opening on General', async () => {
    setLean(true)
    await mount(<Settings />)
    expect(sidebar()).toEqual(allPanes.filter((pane) => pane !== en.settings.agentTitle))
    expect(texts('[role="tab"]')).toEqual(allTabs.filter((tab) => tab !== en.settings.agentTitle))
    expect(container.querySelector('h1, [data-slot="dash-title"]')?.textContent).toBe(en.settings.generalTitle)
    expect(container.textContent).not.toContain('model accounts')
    /* no home prompt box to show or hide */
    expect(container.querySelector('#show-prompt-box')).toBeNull()
    expect(mocks.agentAllowance).not.toHaveBeenCalled()
    expectNoEmptySections()
  })

  it('sends an agent deep link to General in lean mode, and keeps other deep links', async () => {
    setLean(true)
    history.replaceState(null, '', '/settings?pane=agent')
    await mount(<Settings />)
    expect(container.textContent).not.toContain('model accounts')
    await act(async () => root.unmount())
    container.remove()

    history.replaceState(null, '', '/settings?pane=keys')
    await mount(<Settings />)
    expect(container.textContent).toContain('agent keys')
  })
})

describe('the home hero', () => {
  const actions = {
    onPrompt: vi.fn(),
    onImport: vi.fn(),
    onConnectAgents: vi.fn(),
    onAutomations: vi.fn(),
    onIntegrations: vi.fn(),
  }
  const hero = () => <HomeHero busy={false} actions={actions} focusAt={0} />

  it('shows the composer and its chips with lean off', async () => {
    await mount(hero())
    expect(container.querySelector('[data-slot="home-hero"]')).not.toBeNull()
    expect(container.querySelector(`textarea[aria-label="${en.home.composerAria}"]`)).not.toBeNull()
    expect(container.textContent).toContain(en.home.chipAutomation)
  })

  it('steps aside entirely in lean mode', async () => {
    setLean(true)
    await mount(hero())
    expect(container.querySelector('[data-slot="home-hero"]')).toBeNull()
    expect(container.textContent).toBe('')
  })
})

describe('the share dialog', () => {
  const canvas = {
    id: 'c1',
    name: 'Canvas',
    ownerId: 'alice',
    linkAccess: 'view',
    memberIds: [],
  } as unknown as Canvas
  const dialog = () => <ShareModal canvas={canvas} onChange={() => {}} onClose={() => {}} onCopied={() => {}} />

  it('offers the community listing to the owner with lean off', async () => {
    await mount(dialog())
    expect(document.body.textContent).toContain(en.panels.shareGallery)
    expect(document.body.textContent).toContain(en.panels.shareCopyLink)
  })

  it('leaves it out in lean mode and keeps the rest', async () => {
    setLean(true)
    await mount(dialog())
    expect(document.body.textContent).not.toContain(en.panels.shareGallery)
    expect(document.body.textContent).toContain(en.panels.shareCopyLink)
  })
})

describe('the account menu', () => {
  async function openMenu() {
    await mount(<AccountMenu />)
    const trigger = container.querySelector('button')!
    await act(async () => {
      trigger.focus()
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    return document.querySelector('[role="menu"]')!.textContent ?? ''
  }

  it('names the plan and offers the desktop app with lean off', async () => {
    const menu = await openMenu()
    expect(menu).toContain(en.shell.personalPlan)
    expect(menu).toContain(en.shell.desktopApp)
  })

  it('has neither in lean mode', async () => {
    setLean(true)
    const menu = await openMenu()
    expect(menu).not.toContain(en.shell.personalPlan)
    expect(menu).not.toContain(en.shell.teamPlan)
    expect(menu).not.toContain(en.shell.desktopApp)
    expect(menu).toContain(en.shell.settings)
  })
})

describe('the agents panel', () => {
  beforeEach(() => {
    useStore.setState({
      canvas: { id: 'c1', name: 'Canvas', frames: [], pages: [] } as unknown as Canvas,
      panelTab: 'tasks',
      tasks: [],
    })
  })
  const panel = () => <ActivityPanel canvasId="c1" onClose={() => {}} />
  const composer = () => container.querySelector(`textarea[aria-label="${en.panels.promptAria}"]`)

  it('docks the Doop Agent composer under the tasks with lean off', async () => {
    await mount(panel())
    expect(composer()).not.toBeNull()
    expect(container.textContent).toContain(en.panels.activityNoTasks)
  })

  it('keeps the tabs and the tasks but drops the composer and its meter in lean mode', async () => {
    setLean(true)
    await mount(panel())
    expect(composer()).toBeNull()
    expect(texts('[role="tab"]')).toEqual([
      en.panels.activityAgents,
      en.panels.activityComments,
      en.panels.activityActivity,
      en.panels.activityMemory,
    ])
    expect(container.textContent).toContain(en.panels.activityNoTasksLean)
    expect(container.textContent).not.toContain('Doop Agent')
    expect(mocks.agentAllowance).not.toHaveBeenCalled()
  })
})

describe('the import picker', () => {
  it('offers the website and the live app in lean mode, and every source off it', () => {
    expect(importSources(undefined, true).map((s) => s.id)).toEqual(['website', 'liveapp'])
    const ids = importSources(undefined, false).map((s) => s.id)
    expect(ids[0]).toBe('website')
    expect(ids).toEqual(expect.arrayContaining(['liveapp', 'github']))
  })
})
