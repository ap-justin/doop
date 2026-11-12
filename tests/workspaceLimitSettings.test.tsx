// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentKeyInfo, WebhookListing, WorkspacesResponse } from '../src/lib/api'
import type { WorkspaceSummary } from '../shared/types'

/* Agent keys and webhooks reach every canvas by default; Settings can limit a
   new one to some of the person's workspaces, and each list names the limit. */

const mocks = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  listAgentKeys: vi.fn(),
  createAgentKey: vi.fn(),
  listWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  updateWebhook: vi.fn(),
}))

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return { ...actual, api: { ...actual.api, ...mocks } }
})

import { AgentKeys } from '../src/components/AgentKeys'
import { Webhooks } from '../src/components/Webhooks'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

const workspace = (id: string, name: string) => ({ id, name }) as WorkspaceSummary
const workspaces = (list: WorkspaceSummary[]): WorkspacesResponse => ({ workspaces: list }) as WorkspacesResponse
const key = (id: string, name: string, limit: AgentKeyInfo['workspaces']): AgentKeyInfo => ({
  id,
  name,
  start: 'dpk_abc',
  scope: 'full',
  workspaces: limit,
  createdAt: 0,
  lastUsedAt: null,
})
const hook = (id: string, url: string, limit: WebhookListing['workspaces']): WebhookListing => ({
  id,
  url,
  events: ['comment.created'],
  enabled: true,
  createdAt: 0,
  lastStatus: null,
  lastAt: null,
  lastError: null,
  failures: 0,
  workspaces: limit,
})

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
  if (!found) throw new Error(`no button "${label}"`)
  return found
}
function checkbox(label: string): HTMLInputElement {
  const found = Array.from(container.querySelectorAll('label')).find((l) => l.textContent?.trim() === label)
  const input = found?.querySelector('input')
  if (!input) throw new Error(`no checkbox "${label}"`)
  return input
}
function hasButton(label: string): boolean {
  return Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.trim() === label)
}
/* a row's limit editor, named for its hook's host: the All/Some switch, which
   Radix's single toggle group renders as a radiogroup */
function rowPicker(host: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="Change canvases for ${host}"]`)
  if (!found) throw new Error(`no limit picker for ${host}`)
  return found
}
function editButton(host: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="Change canvases for ${host}"]`)
  if (!found) throw new Error(`no "Change canvases" button for ${host}`)
  return found
}
async function click(el: HTMLElement) {
  await act(async () => el.click())
}
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function mount(node: ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(node))
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset()
  mocks.listWorkspaces.mockResolvedValue(workspaces([workspace('w1', 'Acme'), workspace('w2', 'Studio')]))
  mocks.listAgentKeys.mockResolvedValue([])
  mocks.listWebhooks.mockResolvedValue([])
})

afterEach(() => {
  vi.restoreAllMocks()
  act(() => root.unmount())
  container.remove()
})

it('creates an agent key for every canvas by default, sending no workspaces', async () => {
  mocks.createAgentKey.mockResolvedValue({ ...key('k1', 'ci', null), secret: 'dpk_secret' })
  await mount(<AgentKeys />)

  await click(button('Create key'))
  expect(mocks.createAgentKey).toHaveBeenCalledWith('', 'full', undefined)
  expect(container.textContent).toContain('All canvases')
})

it('limits a new agent key to the workspaces checked, and lists it by name', async () => {
  mocks.createAgentKey.mockResolvedValue({ ...key('k1', 'ci', [{ id: 'w2', name: 'Studio' }]), secret: 'dpk_secret' })
  await mount(<AgentKeys />)

  await click(button('Only some workspaces'))
  /* nothing checked yet is no limit at all, so the key cannot be made */
  expect(button('Create key').disabled).toBe(true)
  expect(container.textContent).toContain('Pick at least one workspace.')

  await click(checkbox('Studio'))
  expect(button('Create key').disabled).toBe(false)
  await click(button('Create key'))
  expect(mocks.createAgentKey).toHaveBeenCalledWith('', 'full', ['w2'])
  expect(container.textContent).toContain('Only in Studio')
})

it('offers no workspace choice to someone without workspaces', async () => {
  mocks.listWorkspaces.mockResolvedValue(workspaces([]))
  await mount(<AgentKeys />)

  expect(container.textContent).toContain('All canvases')
  expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Only some workspaces')).toBe(
    false,
  )
})

it('shows each listed key its limit next to its scope', async () => {
  mocks.listAgentKeys.mockResolvedValue([
    key('k1', 'ci', null),
    key('k2', 'mastra', [
      { id: 'w1', name: 'Acme' },
      { id: 'w2', name: 'Studio' },
    ]),
  ])
  await mount(<AgentKeys />)

  expect(container.textContent).toContain('Full accessAll canvases')
  expect(container.textContent).toContain('Full accessOnly in Acme, Studio')
})

it('limits a new webhook to the checked workspaces and lists each hook its limit', async () => {
  mocks.listWebhooks.mockResolvedValue([hook('h1', 'https://hooks.example.com/doop', null)])
  mocks.createWebhook.mockResolvedValue({
    ...hook('h2', 'https://n8n.example.org/webhook', [{ id: 'w1', name: 'Acme' }]),
    secret: 'whsec_new',
  })
  await mount(<Webhooks />)
  expect(container.textContent).toContain('All canvases')

  type(container.querySelector<HTMLInputElement>('input[aria-label="Webhook URL"]')!, 'https://n8n.example.org/webhook')
  await click(button('Only some workspaces'))
  await click(checkbox('Acme'))
  await click(button('Add webhook'))

  expect(mocks.createWebhook).toHaveBeenCalledWith(expect.objectContaining({ workspaceIds: ['w1'] }))
  expect(container.textContent).toContain('Only in Acme')
})

it('creates a webhook for every canvas by default, sending no workspaces', async () => {
  mocks.createWebhook.mockResolvedValue({ ...hook('h1', 'https://hooks.example.com/doop', null), secret: 'whsec' })
  await mount(<Webhooks />)

  type(container.querySelector<HTMLInputElement>('input[aria-label="Webhook URL"]')!, 'https://hooks.example.com/doop')
  await click(button('Add webhook'))
  expect(mocks.createWebhook.mock.calls[0]?.[0]).toMatchObject({ workspaceIds: undefined })
})

it('keeps Create off while the workspaces load, so the choice is offered before a key is made', async () => {
  let resolve!: (value: WorkspacesResponse) => void
  mocks.listWorkspaces.mockReturnValue(new Promise<WorkspacesResponse>((r) => (resolve = r)))
  await mount(<AgentKeys />)

  expect(container.textContent).toContain('Loading…')
  expect(container.textContent).not.toContain('All canvases')
  expect(button('Create key').disabled).toBe(true)

  await act(async () => resolve(workspaces([workspace('w1', 'Acme')])))
  expect(button('Create key').disabled).toBe(false)
  expect(hasButton('Only some workspaces')).toBe(true)
})

it('says a failed workspace load out loud, keeps Create off and retries on request', async () => {
  mocks.listWorkspaces.mockRejectedValueOnce(new Error('500'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await mount(<AgentKeys />)

  expect(container.textContent).toContain('Your workspaces could not be loaded')
  expect(container.textContent).not.toContain('All canvases')
  expect(button('Create key').disabled).toBe(true)

  await click(button('Try again'))
  expect(mocks.listWorkspaces).toHaveBeenCalledTimes(2)
  expect(container.textContent).not.toContain('Your workspaces could not be loaded')
  expect(button('Create key').disabled).toBe(false)
  expect(hasButton('Only some workspaces')).toBe(true)
})

it('keeps the webhook form closed while its workspaces fail to load', async () => {
  mocks.listWorkspaces.mockRejectedValueOnce(new Error('500'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await mount(<Webhooks />)

  type(container.querySelector<HTMLInputElement>('input[aria-label="Webhook URL"]')!, 'https://hooks.example.com/doop')
  expect(container.textContent).toContain('Your workspaces could not be loaded')
  expect(button('Add webhook').disabled).toBe(true)
})

it('names a limit whose workspaces are all out of reach instead of a cut-off sentence', async () => {
  mocks.listAgentKeys.mockResolvedValue([key('k1', 'ci', [])])
  mocks.listWebhooks.mockResolvedValue([hook('h1', 'https://hooks.example.com/doop', [])])
  await mount(
    <>
      <AgentKeys />
      <Webhooks />
    </>,
  )

  expect(container.textContent).toContain('Full accessNo workspace available')
  expect(container.textContent?.match(/No workspace available/g)).toHaveLength(2)
  expect(container.textContent).not.toMatch(/Only in (?![A-Z])/)
})

it('starts the next key at every canvas after one was made with a limit', async () => {
  mocks.createAgentKey.mockResolvedValue({ ...key('k1', 'ci', [{ id: 'w2', name: 'Studio' }]), secret: 'dpk_secret' })
  await mount(<AgentKeys />)

  await click(button('Only some workspaces'))
  await click(checkbox('Studio'))
  await click(button('Create key'))
  await click(button('Create key'))
  expect(mocks.createAgentKey).toHaveBeenLastCalledWith('', 'full', undefined)
})

it('lifts a webhook limit from its row, sending null for every canvas', async () => {
  const limited = hook('h1', 'https://hooks.example.com/doop', [{ id: 'w1', name: 'Acme' }])
  mocks.listWebhooks.mockResolvedValue([limited])
  mocks.updateWebhook.mockResolvedValue({ ...limited, workspaces: null })
  await mount(<Webhooks />)

  const edit = container.querySelector<HTMLButtonElement>('button[aria-label="Change canvases for hooks.example.com"]')!
  await click(edit)
  /* the editor opens on the hook's own limit */
  expect(checkbox('Acme').checked).toBe(true)
  /* and the button that opened it is off until the editor closes */
  expect(edit.disabled).toBe(true)

  const all = Array.from(rowPicker('hooks.example.com').querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'All canvases',
  )!
  await click(all)
  await click(button('Save'))

  expect(mocks.updateWebhook).toHaveBeenCalledWith('h1', { workspaceIds: null })
  expect(hasButton('Save')).toBe(false)
  expect(container.textContent).not.toContain('Only in Acme')
})

it('changes a webhook limit to other workspaces and never sends an empty list', async () => {
  const limited = hook('h1', 'https://hooks.example.com/doop', [{ id: 'w1', name: 'Acme' }])
  mocks.listWebhooks.mockResolvedValue([limited])
  mocks.updateWebhook.mockResolvedValue({ ...limited, workspaces: [{ id: 'w2', name: 'Studio' }] })
  await mount(<Webhooks />)

  await click(container.querySelector<HTMLButtonElement>('button[aria-label="Change canvases for hooks.example.com"]')!)
  await click(checkbox('Acme'))
  expect(button('Save').disabled).toBe(true)
  await click(checkbox('Studio'))
  await click(button('Save'))

  expect(mocks.updateWebhook).toHaveBeenCalledWith('h1', { workspaceIds: ['w2'] })
  expect(container.textContent).toContain('Only in Studio')
})

it('lifts a stranded webhook limit for someone with no workspaces left', async () => {
  mocks.listWorkspaces.mockResolvedValue(workspaces([]))
  const stranded = hook('h1', 'https://hooks.example.com/doop', [])
  mocks.listWebhooks.mockResolvedValue([stranded])
  mocks.updateWebhook.mockResolvedValue({ ...stranded, workspaces: null })
  await mount(<Webhooks />)

  await click(editButton('hooks.example.com'))
  /* every canvas is the one answer left, and Save says so */
  expect(button('Save').disabled).toBe(false)
  await click(button('Save'))

  expect(mocks.updateWebhook).toHaveBeenCalledWith('h1', { workspaceIds: null })
  expect(container.textContent).not.toContain('No workspace available')
})

it('clears a failed limit save from the row once a retry succeeds', async () => {
  const limited = hook('h1', 'https://hooks.example.com/doop', [{ id: 'w1', name: 'Acme' }])
  mocks.listWebhooks.mockResolvedValue([limited])
  mocks.updateWebhook
    .mockRejectedValueOnce(new Error('500'))
    .mockResolvedValueOnce({ ...limited, workspaces: [{ id: 'w2', name: 'Studio' }] })
  await mount(<Webhooks />)

  await click(editButton('hooks.example.com'))
  await click(checkbox('Studio'))
  await click(button('Save'))
  expect(container.textContent).toContain('The canvases could not be changed')

  await click(button('Save'))
  expect(container.textContent).not.toContain('The canvases could not be changed')
  expect(container.textContent).toContain('no deliveries yet')
})

it('clears a failed limit save from the row on Cancel', async () => {
  const limited = hook('h1', 'https://hooks.example.com/doop', [{ id: 'w1', name: 'Acme' }])
  mocks.listWebhooks.mockResolvedValue([limited])
  mocks.updateWebhook.mockRejectedValueOnce(new Error('500'))
  await mount(<Webhooks />)

  await click(editButton('hooks.example.com'))
  await click(checkbox('Studio'))
  await click(button('Save'))
  expect(container.textContent).toContain('The canvases could not be changed')

  await click(button('Cancel'))
  expect(container.textContent).not.toContain('The canvases could not be changed')
  expect(container.textContent).toContain('no deliveries yet')
})

it('keeps the editor another hook opened when an earlier save lands late', async () => {
  const first = hook('h1', 'https://hooks.example.com/doop', [{ id: 'w1', name: 'Acme' }])
  const second = hook('h2', 'https://n8n.example.org/webhook', [{ id: 'w2', name: 'Studio' }])
  mocks.listWebhooks.mockResolvedValue([first, second])
  let land!: (value: WebhookListing) => void
  mocks.updateWebhook.mockReturnValueOnce(new Promise<WebhookListing>((r) => (land = r)))
  await mount(<Webhooks />)

  await click(editButton('hooks.example.com'))
  await click(checkbox('Studio'))
  await click(button('Save'))
  await click(button('Cancel'))
  await click(editButton('n8n.example.org'))

  await act(async () => land({ ...first, workspaces: [{ id: 'w2', name: 'Studio' }] }))
  /* the second hook's editor is still open on its own limit */
  expect(rowPicker('n8n.example.org')).toBeTruthy()
  expect(checkbox('Studio').checked).toBe(true)
  expect(hasButton('Save')).toBe(true)
})

it('moves focus into the limit editor when it opens and back to its button when it closes', async () => {
  mocks.listWebhooks.mockResolvedValue([hook('h1', 'https://hooks.example.com/doop', [{ id: 'w1', name: 'Acme' }])])
  mocks.updateWebhook.mockResolvedValue(hook('h1', 'https://hooks.example.com/doop', null))
  await mount(<Webhooks />)

  const edit = editButton('hooks.example.com')
  edit.focus()
  await click(edit)
  expect(rowPicker('hooks.example.com').contains(document.activeElement)).toBe(true)

  const cancel = button('Cancel')
  cancel.focus()
  await click(cancel)
  expect(document.activeElement).toBe(editButton('hooks.example.com'))

  await click(editButton('hooks.example.com'))
  const save = button('Save')
  save.focus()
  await click(save)
  expect(document.activeElement).toBe(editButton('hooks.example.com'))
})
