// @vitest-environment happy-dom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InviteAccept } from '../src/pages/InviteAccept'
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
  const name = container.querySelector<HTMLInputElement>('#invite-name')!
  const password = container.querySelector<HTMLInputElement>('#invite-password')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(name, 'New Person')
    name.dispatchEvent(new Event('input', { bubbles: true }))
    setValue.call(password, 'correct horse battery')
    password.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  expect(posts(fetch)).toHaveLength(1)
})
