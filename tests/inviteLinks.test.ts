import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Invite links on a closed production instance: sign-up is limited to a
 * domain nobody has and there is no mailer, so an invite is the only way in.
 */

let server: Server
let owner: Client
let workspaceId: string
let canvasId: string
let hop = 0

beforeAll(async () => {
  server = await startServer({
    NODE_ENV: 'production',
    BETTER_AUTH_SECRET: 'test-secret-not-for-real-use',
    SIGNUP_EMAIL_DOMAINS: 'signup-closed.invalid',
  })
  owner = new Client(server)
  /* the owner signs up through the allowed domain */
  expect(
    (
      await owner.post('/api/auth/sign-up/email', {
        email: 'boss@signup-closed.invalid',
        password: 'password12345',
        name: 'Boss',
      })
    ).status,
  ).toBe(200)
  workspaceId = (await (await owner.post('/api/workspaces', { name: 'Closed Co' })).json()).id
  canvasId = (await (await owner.post('/api/canvases', { name: 'Shared board' })).json()).id
}, 70_000)

afterAll(() => server?.stop())

const tokenOf = (link: string) => link.slice(link.lastIndexOf('/') + 1)

/** each call comes from its own address, so the accept route's rate limit stays out of the way */
function acceptAs(client: Client, link: string, body: unknown) {
  return client.req(`/api/invite-links/${tokenOf(link)}/accept`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': `10.0.0.${++hop}` },
    body: JSON.stringify(body),
  })
}

async function inviteToWorkspace(email: string, role?: string) {
  const res = await owner.post(`/api/workspaces/${workspaceId}/members`, { email, role })
  return { res, body: await res.json() }
}

async function inviteToCanvas(email: string) {
  const res = await owner.post(`/api/canvases/${canvasId}/members`, { email })
  return { res, body: await res.json() }
}

describe('invite links', () => {
  it('returns a link for an unknown email to a workspace and to a canvas, without a mailer', async () => {
    const ws = await inviteToWorkspace('Nina@Example.com', 'admin')
    expect(ws.res.status, JSON.stringify(ws.body)).toBe(200)
    expect(ws.body.link).toMatch(new RegExp(`^${server.base}/invite/[\\w-]{20,}$`))
    expect(ws.body.invite.email).toBe('nina@example.com')
    expect(ws.body.emailed).toBe(false)

    const cv = await inviteToCanvas('Omar@Example.com')
    expect(cv.res.status, JSON.stringify(cv.body)).toBe(200)
    expect(cv.body.link).toMatch(new RegExp(`^${server.base}/invite/[\\w-]{20,}$`))
    expect(cv.body.invite.email).toBe('omar@example.com')

    const pending = await (await owner.get(`/api/canvases/${canvasId}/invites`)).json()
    expect(pending.map((i: { email: string }) => i.email)).toEqual(['omar@example.com'])
    const detail = await (await owner.get(`/api/workspaces/${workspaceId}`)).json()
    expect(detail.invites.map((i: { email: string }) => i.email)).toContain('nina@example.com')
  })

  it('shows who invited, to what, and the fixed email', async () => {
    const { body } = await inviteToWorkspace('peek@example.com')
    const info = await (await new Client(server).get(`/api/invite-links/${tokenOf(body.link)}`)).json()
    expect(info).toEqual({
      kind: 'workspace',
      email: 'peek@example.com',
      inviterName: 'Boss',
      targetName: 'Closed Co',
      accountExists: false,
    })
  })

  it('creates the account for the invited email once, and lands it in the workspace with the invited role', async () => {
    const { body } = await inviteToWorkspace('admin-to-be@example.com', 'admin')
    const person = new Client(server)
    const res = await acceptAs(person, body.link, { name: 'Ada', password: 'password12345' })
    expect(res.status, await res.clone().text()).toBe(200)
    expect((await res.json()).landing).toBe(`/w/${workspaceId}`)

    const me = await (await person.get('/api/me')).json()
    expect(me.email).toBe('admin-to-be@example.com')
    const detail = await (await person.get(`/api/workspaces/${workspaceId}`)).json()
    expect(detail.role).toBe('admin')

    /* the link is spent */
    const again = await acceptAs(new Client(server), body.link, { name: 'Ada', password: 'password12345' })
    expect(again.status).toBe(404)
    expect(await again.json()).toEqual({ error: 'invalid' })
  })

  it('creates the account from a canvas link and gives it the canvas', async () => {
    const { body } = await inviteToCanvas('canvas-guest@example.com')
    const guest = new Client(server)
    const res = await acceptAs(guest, body.link, { name: 'Gus', password: 'password12345' })
    expect(res.status, await res.clone().text()).toBe(200)
    expect((await res.json()).landing).toBe(`/c/${canvasId}`)
    expect((await guest.get(`/api/canvases/${canvasId}`)).status).toBe(200)
    const pending = await (await owner.get(`/api/canvases/${canvasId}/invites`)).json()
    expect(pending.map((i: { email: string }) => i.email)).not.toContain('canvas-guest@example.com')
  })

  it('refuses unknown, revoked and expired links the same way', async () => {
    const bogus = await acceptAs(new Client(server), `${server.base}/invite/not-a-real-token`, {
      name: 'X',
      password: 'password12345',
    })
    const revokedInvite = await inviteToWorkspace('revoked@example.com')
    await owner.delete(`/api/workspaces/${workspaceId}/invites/${revokedInvite.body.invite.id}`)
    const revoked = await acceptAs(new Client(server), revokedInvite.body.link, {
      name: 'X',
      password: 'password12345',
    })
    const revokedCanvas = await inviteToCanvas('revoked2@example.com')
    await owner.delete(`/api/canvases/${canvasId}/invites/${revokedCanvas.body.invite.id}`)
    const revoked2 = await acceptAs(new Client(server), revokedCanvas.body.link, {
      name: 'X',
      password: 'password12345',
    })
    for (const res of [bogus, revoked, revoked2]) {
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'invalid' })
    }
    for (const link of [revokedInvite.body.link, revokedCanvas.body.link]) {
      expect((await new Client(server).get(`/api/invite-links/${tokenOf(link)}`)).status).toBe(404)
    }
  })

  it('never opens open sign-up, and the token cannot make an account for another address', async () => {
    const plain = await new Client(server).post('/api/auth/sign-up/email', {
      email: 'random@example.com',
      password: 'password12345',
      name: 'Random',
    })
    expect(plain.status).toBe(400)
    expect((await plain.json()).message).toContain('@signup-closed.invalid')

    /* the accept body has no email field: whatever one is sent, the invite's own is used */
    const { body } = await inviteToWorkspace('real@example.com')
    const person = new Client(server)
    const res = await acceptAs(person, body.link, { name: 'R', password: 'password12345', email: 'other@example.com' })
    expect(res.status).toBe(200)
    expect((await (await person.get('/api/me')).json()).email).toBe('real@example.com')
    const exists = await new Client(server).post('/api/account-exists', { email: 'other@example.com' })
    expect(await exists.json()).toEqual({ exists: false })

    /* and the bypass ended with that request */
    const after = await new Client(server).post('/api/auth/sign-up/email', {
      email: 'real2@example.com',
      password: 'password12345',
      name: 'Late',
    })
    expect(after.status).toBe(400)
  })

  it('adds an existing account directly, with no link', async () => {
    const early = new Client(server)
    expect(
      (
        await early.req('/api/auth/sign-up/email', {
          method: 'POST',
          headers: { Origin: server.base, 'X-Forwarded-For': '198.51.100.7' },
          body: JSON.stringify({ email: 'early@signup-closed.invalid', password: 'password12345', name: 'Early' }),
        })
      ).status,
    ).toBe(200)
    const { body } = await inviteToWorkspace('early@signup-closed.invalid')
    /* an existing account is added as before */
    expect(body.member).toBeTruthy()
    expect(body.link).toBeUndefined()
  })

  it('sends an account made after the invite to sign in, and joins it with the link', async () => {
    /* open sign-up, production, no mailer: a plain sign-up never takes an invite by address alone */
    const open = await startServer({ NODE_ENV: 'production', BETTER_AUTH_SECRET: 'test-secret-not-for-real-use' })
    try {
      const boss = new Client(open)
      await boss.signUp('boss@test.dev', 'Boss')
      const ws = (await (await boss.post('/api/workspaces', { name: 'Open Co' })).json()).id
      const invite = await (await boss.post(`/api/workspaces/${ws}/members`, { email: 'late@test.dev' })).json()
      const token = tokenOf(invite.link)

      const late = new Client(open)
      const signUp = await late.req('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { Origin: open.base, 'X-Forwarded-For': '198.51.100.8' },
        body: JSON.stringify({ email: 'late@test.dev', password: 'password12345', name: 'Late' }),
      })
      expect(signUp.status).toBe(200)
      expect((await late.get(`/api/workspaces/${ws}`)).status).toBe(404)

      const info = await (await new Client(open).get(`/api/invite-links/${token}`)).json()
      expect(info.accountExists).toBe(true)
      const blocked = await new Client(open).req(`/api/invite-links/${token}/accept`, {
        method: 'POST',
        headers: { 'X-Forwarded-For': '198.51.100.9' },
        body: JSON.stringify({ name: 'Late', password: 'password12345' }),
      })
      expect(blocked.status).toBe(409)

      /* another account cannot spend it, a signed-out visitor cannot either */
      const other = new Client(open)
      await other.signUp('other@test.dev', 'Other')
      expect((await other.post(`/api/invite-links/${token}/join`)).status).toBe(404)
      expect((await new Client(open).post(`/api/invite-links/${token}/join`)).status).toBe(401)

      const joined = await late.post(`/api/invite-links/${token}/join`)
      expect(joined.status).toBe(200)
      expect((await late.get(`/api/workspaces/${ws}`)).status).toBe(200)
      const again = await late.req(`/api/invite-links/${token}/join`, {
        method: 'POST',
        headers: { 'X-Forwarded-For': '198.51.100.10' },
      })
      expect(again.status).toBe(404)
    } finally {
      open.stop()
    }
  })

  it('rate-limits the accept route', async () => {
    const link = (await inviteToWorkspace('limit@example.com')).body.link
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) {
      const res = await new Client(server).req(`/api/invite-links/${tokenOf(link)}/accept`, {
        method: 'POST',
        headers: { 'X-Forwarded-For': '203.0.113.9' },
        body: JSON.stringify({ name: '', password: '' }),
      })
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 3)).not.toContain(429)
    expect(statuses.slice(3)).toEqual([429, 429])
  })
})
