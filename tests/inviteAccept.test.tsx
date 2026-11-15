// @vitest-environment happy-dom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InviteAccept } from '../src/pages/InviteAccept'
import { InviteLinkNotice } from '../src/components/InviteLinkNotice'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const INFO = {
  kind: 'workspace',
  targetName: 'Acme',
  inviterName: 'Ada',
  email: 'new@example.com',
  accountExists: false,
}

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** Answers the invite lookup with `info` and every POST with `post`. */
function stubFetch(info: object, post: () => Promise<Response>) {
  const fetch = vi.fn((url: string, init?: RequestInit) =>
    init?.method === 'POST' ? post() : Promise.resolve(Response.json(info)),
  )
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const posts = (fetch: ReturnType<typeof stubFetch>) => fetch.mock.calls.filter(([, init]) => init?.method === 'POST')

/** Stands in for the page's navigation, so a landing can be asserted rather than followed. */
function stubLocation() {
  const location = { replace: vi.fn(), assign: vi.fn() }
  vi.stubGlobal('location', location)
  return location
}

async function fillAccountForm() {
  const name = container.querySelector<HTMLInputElement>('#invite-name')!
  const password = container.querySelector<HTMLInputElement>('#invite-password')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(name, 'New Person')
    name.dispatchEvent(new Event('input', { bubbles: true }))
    setValue.call(password, 'correct horse battery')
    password.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const submit = (form: HTMLFormElement) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

it('joins once under StrictMode, and a rate limit stays retryable', async () => {
  const fetch = stubFetch({ ...INFO, accountExists: true }, () =>
    Promise.resolve(Response.json({ error: 'too many attempts — try again shortly' }, { status: 429 })),
  )
  await act(async () =>
    root.render(
      <StrictMode>
        <InviteAccept token="tok" signedInAs="new@example.com" />
      </StrictMode>,
    ),
  )
  expect(posts(fetch)).toHaveLength(1)
  expect(container.textContent).not.toContain('isn’t valid')
  expect(container.textContent).toContain('Too many attempts')
  expect(container.textContent).toContain('Try again')
})

it('offers no account form to someone signed in as another address', async () => {
  stubFetch(INFO, () => Promise.reject(new Error('no post expected')))
  await act(async () => root.render(<InviteAccept token="tok" signedInAs="inviter@example.com" />))
  expect(container.querySelector('form')).toBeNull()
  expect(container.textContent).toContain('signed in as inviter@example.com')
  expect(container.textContent).toContain('Sign out')
})

it('sends one accept for a double submit', async () => {
  const fetch = stubFetch(INFO, () => new Promise<Response>(() => {}))
  await act(async () => root.render(<InviteAccept token="tok" />))
  const form = container.querySelector('form')!
  await fillAccountForm()
  await act(async () => {
    submit(form)
    submit(form)
  })
  expect(posts(fetch)).toHaveLength(1)
})

it('replaces the invite page with the landing once the account is made', async () => {
  const location = stubLocation()
  stubFetch(INFO, () => Promise.resolve(Response.json({ landing: '/w/acme' })))
  await act(async () => root.render(<InviteAccept token="tok" />))
  await fillAccountForm()
  await act(async () => void submit(container.querySelector('form')!))
  expect(location.replace).toHaveBeenCalledWith('/w/acme')
  expect(location.assign).not.toHaveBeenCalled()
})

it('shows the inviter the link and a Copy button, or, once a mailer sent it, only that it was sent', async () => {
  const link = 'http://localhost/invite/tok123'
  await act(async () => root.render(<InviteLinkNotice email="new@example.com" link={link} />))
  expect(container.querySelector<HTMLInputElement>('input')?.value).toBe(link)
  expect(container.textContent).toContain('Copy link')

  await act(async () => root.render(<InviteLinkNotice email="new@example.com" />))
  expect(container.textContent).toContain('Invite sent to new@example.com')
  expect(container.querySelector('input')).toBeNull()
  expect(container.querySelector('button')).toBeNull()
})

it('offers a retry, not the dead-link card, when the invite fails to load', async () => {
  const edgeDown = () => Response.json({ error: 'Application failed to respond' }, { status: 502 })
  let lookups = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(lookups++ === 0 ? edgeDown() : Response.json(INFO))),
  )
  await act(async () => root.render(<InviteAccept token="tok" />))
  expect(container.textContent).toContain('Could not load this invite')
  expect(container.textContent).not.toContain('isn’t valid')
  const retry = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Try again'))!
  await act(async () => void retry.click())
  expect(container.querySelector('#invite-name')).not.toBeNull()
})

it('lands the signed-in account that already spent the link', async () => {
  const location = stubLocation()
  const spent = () => Response.json({ error: 'invalid' }, { status: 404 })
  const fetch = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(init?.method === 'POST' ? Response.json({ landing: '/w/acme' }) : spent()),
  )
  vi.stubGlobal('fetch', fetch)
  await act(async () =>
    root.render(
      <StrictMode>
        <InviteAccept token="tok" signedInAs="new@example.com" />
      </StrictMode>,
    ),
  )
  const joins = fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
  expect(joins).toHaveLength(1)
  expect(joins[0]?.[0]).toBe('/api/invite-links/tok/join')
  expect(location.replace).toHaveBeenCalledWith('/w/acme')
  expect(container.textContent).not.toContain('isn’t valid')
})

it('shows the dead-link card for an unknown link when nobody is signed in', async () => {
  const fetch = vi.fn(() => Promise.resolve(Response.json({ error: 'invalid' }, { status: 404 })))
  vi.stubGlobal('fetch', fetch)
  await act(async () => root.render(<InviteAccept token="tok" />))
  expect(container.textContent).toContain('isn’t valid')
  expect(fetch).toHaveBeenCalledTimes(1)
})
