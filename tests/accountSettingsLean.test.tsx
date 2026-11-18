// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* The Notifications card of Settings → Your account follows lean mode. */

vi.mock('../src/lib/api', () => ({
  api: { notificationSettings: () => Promise.resolve({ commentEmails: true, emailConfigured: true }) },
  ApiError: class ApiError extends Error {},
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/auth', () => ({
  authClient: { useSession: () => ({ data: { user: { id: 'alice', email: 'a@example.com' } }, refetch: vi.fn() }) },
}))
vi.mock('../src/components/DeleteAccount', () => ({ DeleteAccountCard: () => null }))

const { setLean } = await import('../src/lib/lean')
const { AccountSettings } = await import('../src/components/AccountSettings')

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

const commentEmailsSwitch = () => container.querySelector('input[type="checkbox"]')

describe('Settings → Your account notifications', () => {
  it('shows the comment email switch when lean is off', async () => {
    await act(async () => root.render(<AccountSettings />))
    expect(commentEmailsSwitch()).not.toBeNull()
  })

  it('hides the Notifications block when lean is on', async () => {
    setLean(true)
    await act(async () => root.render(<AccountSettings />))
    expect(commentEmailsSwitch()).toBeNull()
  })
})
