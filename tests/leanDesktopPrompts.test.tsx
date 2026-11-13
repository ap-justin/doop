// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { en } from '../src/lib/i18n/en'

/* A lean server does not offer the Doop desktop app, so the browser's
   connect steps drop its prompts for the manual setup, and its meter never
   asks for an allowance. A desktop shell keeps its own app. */

const mocks = vi.hoisted(() => ({
  desktop: false,
  agentAllowance: vi.fn(() => Promise.resolve({ used: 0, limit: 5, byoModel: false })),
}))
vi.mock('../src/lib/shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/shell')>()),
  isDesktopShell: () => mocks.desktop,
}))
vi.mock('../src/App', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/store', () => ({
  useStore: (select: (s: { presences: Record<string, never>; allowanceVersion: number }) => unknown) =>
    select({ presences: {}, allowanceVersion: 0 }),
}))
vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return { ...actual, api: { ...actual.api, agentAllowance: mocks.agentAllowance } }
})

const { setLean } = await import('../src/lib/lean')
const { ConnectModal } = await import('../src/components/ConnectModal')
const { CodexInstall } = await import('../src/components/CodexInstall')
const { ClaudeDesktopInstall } = await import('../src/components/ClaudeDesktopInstall')
const { useAllowance } = await import('../src/components/TeamAllowance')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const text = () => document.body.textContent ?? ''

async function mount(node: ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(node))
}

beforeEach(() => {
  mocks.desktop = false
  mocks.agentAllowance.mockClear()
  vi.stubGlobal('location', new URL('http://localhost:4301'))
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  setLean(false)
})

describe('the Codex setup', () => {
  const install = () => <CodexInstall mcpUrl="http://localhost:4301/mcp" canvasId="c1" />

  it('sends a browser to the desktop app with lean off', async () => {
    await mount(install())
    expect(text()).toContain(en.workspace.openDesktop)
    expect(text()).toContain(en.workspace.codexNeedsDesktop)
  })

  it('gives a browser the manual command alone in lean mode', async () => {
    setLean(true)
    await mount(install())
    expect(text()).not.toContain(en.workspace.openDesktop)
    expect(text()).not.toContain(en.workspace.codexNeedsDesktop)
    expect(text()).toContain('codex mcp add doop --url http://localhost:4301/mcp')
  })

  it('still points the desktop shell at its own app update in lean mode', async () => {
    setLean(true)
    mocks.desktop = true
    await mount(install())
    expect(text()).toContain(en.workspace.codexUpdateDesktop)
  })
})

describe('the Claude Desktop setup', () => {
  const install = () => <ClaudeDesktopInstall mcpUrl="http://localhost:4301/mcp" />

  it('asks a browser for the desktop app with lean off', async () => {
    await mount(install())
    expect(text()).toContain(en.workspace.claudeNeedsDesktop)
  })

  it('offers a browser the extension download instead in lean mode', async () => {
    setLean(true)
    await mount(install())
    expect(text()).not.toContain(en.workspace.claudeNeedsDesktop)
    expect(document.querySelector('a[download="doop.mcpb"]')).not.toBeNull()
  })
})

describe('the connect steps', () => {
  const pick = (label: string) =>
    act(async () => {
      ;[...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!.click()
    })

  it('tell Codex and Claude Desktop users about the desktop app only with lean off', async () => {
    await mount(<ConnectModal initialAgent="codex" canvasId="c1" onClose={vi.fn()} />)
    expect(text()).toContain(en.connect.codexLede)
    expect(text()).not.toContain(en.connect.codexLedeLean)
    await act(async () => root.unmount())
    container.remove()

    setLean(true)
    await mount(<ConnectModal initialAgent="codex" canvasId="c1" onClose={vi.fn()} />)
    expect(text()).toContain(en.connect.codexLedeLean)
    expect(text()).not.toContain(en.connect.codexLede)
    await act(async () => root.unmount())
    container.remove()

    await mount(<ConnectModal initialAgent="claude" canvasId="c1" onClose={vi.fn()} />)
    await pick(en.connect.desktopApp)
    expect(text()).toContain(en.connect.claudeDesktopLedeLean)
    expect(text()).not.toContain(en.connect.claudeDesktopLede)
  })

  it('keep the desktop shell on its own app in lean mode', async () => {
    setLean(true)
    mocks.desktop = true
    await mount(<ConnectModal initialAgent="codex" canvasId="c1" onClose={vi.fn()} />)
    expect(text()).toContain(en.connect.codexLede)
    expect(text()).not.toContain(en.connect.codexLedeLean)
  })
})

describe('the allowance meter', () => {
  function Probe() {
    useAllowance()
    return null
  }

  it('asks the server for the allowance with lean off', async () => {
    await mount(<Probe />)
    expect(mocks.agentAllowance).toHaveBeenCalledOnce()
  })

  it('never asks in lean mode, which meters nothing', async () => {
    setLean(true)
    await mount(<Probe />)
    expect(mocks.agentAllowance).not.toHaveBeenCalled()
  })
})
