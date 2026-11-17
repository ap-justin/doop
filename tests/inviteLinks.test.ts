import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { startSmtpSink, type SinkMail } from './smtpSink.ts'

/**
 * Invite links on a closed production instance: sign-up is limited to a
 * domain nobody has and there is no mailer, so an invite is the only way in.
 */

let server: Server
let owner: Client
let workspaceId: string
let canvasId: string

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

function acceptAs(client: Client, link: string, body: unknown) {
  return client.post(`/api/invite-links/${tokenOf(link)}/accept`, body)
}

async function inviteToWorkspace(email: string, role?: string) {
  const res = await owner.post(`/api/workspaces/${workspaceId}/members`, { email, role })
  return { res, body: await res.json() }
}

async function inviteToCanvas(email: string, onCanvas = canvasId) {
  const res = await owner.post(`/api/canvases/${onCanvas}/members`, { email })
  return { res, body: await res.json() }
}

async function newCanvas(name: string): Promise<string> {
  return (await (await owner.post('/api/canvases', { name })).json()).id
}

/** better-auth rate-limits sign-up per client IP, so each account claims its own */
let nextIp = 10
async function signUpFresh(email: string, name: string): Promise<Client> {
  const client = new Client(server)
  const res = await client.req('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { Origin: server.base, 'X-Forwarded-For': `198.18.0.${nextIp++}` },
    body: JSON.stringify({ email, password: 'password12345', name }),
  })
  expect(res.status, await res.clone().text()).toBe(200)
  return client
}

const emailsOf = (list: { email: string }[]) => list.map((i) => i.email)
const infoOf = (link: string) => new Client(server).get(`/api/invite-links/${tokenOf(link)}`)

describe('invite links', () => {
  it('returns a link for an unknown email to a workspace and to a canvas, without a mailer', async () => {
    const ws = await inviteToWorkspace('Nina@Example.com', 'admin')
    expect(ws.res.status, JSON.stringify(ws.body)).toBe(200)
    expect(ws.body.link).toMatch(new RegExp(`^${server.base}/invite/[\\w-]{20,}$`))
    expect(ws.body.invite.email).toBe('nina@example.com')
    expect(ws.body.emailed).toBe(false)

    /* its own canvas, so the exact list does not depend on what other tests invited */
    const own = await newCanvas('Pending list')
    const cv = await inviteToCanvas('Omar@Example.com', own)
    expect(cv.res.status, JSON.stringify(cv.body)).toBe(200)
    expect(cv.body.link).toMatch(new RegExp(`^${server.base}/invite/[\\w-]{20,}$`))
    expect(cv.body.invite.email).toBe('omar@example.com')

    const pending = await (await owner.get(`/api/canvases/${own}/invites`)).json()
    expect(emailsOf(pending)).toEqual(['omar@example.com'])
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

  it('leaves an accepted account unverified: the inviter holds the link, so it proves nothing about the address', async () => {
    const { body } = await inviteToWorkspace('unproven@example.com')
    const person = new Client(server)
    const res = await acceptAs(person, body.link, { name: 'Una', password: 'password12345' })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(body.emailed).toBe(false)
    const session = await (await person.get('/api/auth/get-session')).json()
    expect(session.user).toMatchObject({ email: 'unproven@example.com', emailVerified: false })
  })

  it('refuses a canvas invite to an address without an @, making no invite', async () => {
    const own = await newCanvas('No at sign')
    const { res, body } = await inviteToCanvas('bob', own)
    expect(res.status).toBe(400)
    expect(body).toEqual({ error: 'a valid email is required' })
    expect(await (await owner.get(`/api/canvases/${own}/invites`)).json()).toEqual([])
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

  it('honours only the invite behind the accepted link', async () => {
    const ws = await inviteToWorkspace('both@example.com')
    const cv = await inviteToCanvas('both@example.com')
    const person = new Client(server)
    const res = await acceptAs(person, ws.body.link, { name: 'Bo', password: 'password12345' })
    expect(res.status, await res.clone().text()).toBe(200)
    expect((await person.get(`/api/workspaces/${workspaceId}`)).status).toBe(200)

    /* the canvas invite waits for its own link */
    expect((await person.get(`/api/canvases/${canvasId}`)).status).not.toBe(200)
    const pending = await (await owner.get(`/api/canvases/${canvasId}/invites`)).json()
    expect(pending.map((i: { email: string }) => i.email)).toContain('both@example.com')
    expect((await person.post(`/api/invite-links/${tokenOf(cv.body.link)}/join`)).status).toBe(200)
    expect((await person.get(`/api/canvases/${canvasId}`)).status).toBe(200)
  })

  it('answers a second account for the same address as account-exists, honouring nothing for it', async () => {
    const ws = await inviteToWorkspace('twice@example.com')
    const cv = await inviteToCanvas('twice@example.com')
    const [a, b] = await Promise.all([
      acceptAs(new Client(server), ws.body.link, { name: 'One', password: 'password12345' }),
      acceptAs(new Client(server), cv.body.link, { name: 'Two', password: 'password12345' }),
    ])
    const outcomes = [
      { status: a.status, body: await a.json() },
      { status: b.status, body: await b.json() },
    ].sort((x, y) => x.status - y.status)
    expect(outcomes.map((o) => o.status)).toEqual([200, 409])
    expect(outcomes[1]!.body).toEqual({ error: 'account-exists' })
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
    /* an existing account becomes a member at once, with no link */
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
      const blocked = await new Client(open).post(`/api/invite-links/${token}/accept`, {
        name: 'Late',
        password: 'password12345',
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
      /* the account that spent the link may present it again and still land */
      const again = await late.post(`/api/invite-links/${token}/join`)
      expect(again.status).toBe(200)
      expect((await again.json()).landing).toBe(`/w/${ws}`)
    } finally {
      open.stop()
    }
  }, 70_000)

  describe('with a mailer', () => {
    const prod = { NODE_ENV: 'production', BETTER_AUTH_SECRET: 'test-secret-not-for-real-use' }
    const sinkLink = (mails: SinkMail[], to: string) => {
      const mail = mails.find((m) => m.to === to && m.data.includes('/invite/'))
      return /https?:\/\/\S+\/invite\/[\w-]+/.exec(mail?.data ?? '')?.[0]
    }

    /** A server mailing through `smtpPort`, with boss@test.dev signed in. */
    async function mailedServer(smtpPort: number) {
      /* the inviter signs up while no mailer is set, then is marked verified in
         the database, since an unverified account cannot sign in once
         verification is required */
      const before = await startServer(prod)
      await new Client(before).signUp('boss@test.dev', 'Boss')
      before.stop({ keepData: true })
      await before.stopped
      const { PGlite } = await import('@electric-sql/pglite')
      const pg = new PGlite(path.join(before.dataDir, 'data', 'pg'))
      await pg.query(`update "user" set email_verified = true`)
      await pg.close()

      /* ADMIN_EMAILS: the boot reconcile promotes the verified boss, who may then set a default workspace */
      const mailed = await startServer(
        { ...prod, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), ADMIN_EMAILS: 'boss@test.dev' },
        before.dataDir,
      )
      const boss = new Client(mailed)
      const signIn = await boss.post('/api/auth/sign-in/email', { email: 'boss@test.dev', password: 'password12345' })
      if (signIn.status !== 200) mailed.stop()
      expect(signIn.status).toBe(200)
      return { mailed, boss }
    }

    it('mails the link to the address alone, and opening it verifies the address, joins the default workspace and lands', async () => {
      const sink = await startSmtpSink()
      const { mailed, boss } = await mailedServer(sink.port)
      try {
        const defaultWsId = (await (await boss.post('/api/workspaces', { name: 'Everyone' })).json()).id
        const setDefault = await boss.patch('/api/admin/instance-settings', { defaultWorkspaceId: defaultWsId })
        expect(setDefault.status, await setDefault.clone().text()).toBe(200)
        const wsId = (await (await boss.post('/api/workspaces', { name: 'Mail Co' })).json()).id
        const cvId = (await (await boss.post('/api/canvases', { name: 'Mail board' })).json()).id
        const invited = [
          [
            'wsinbox@test.dev',
            await boss.post(`/api/workspaces/${wsId}/members`, { email: 'wsinbox@test.dev' }),
            `/w/${wsId}`,
          ],
          [
            'cvinbox@test.dev',
            await boss.post(`/api/canvases/${cvId}/members`, { email: 'cvinbox@test.dev' }),
            `/c/${cvId}`,
          ],
        ] as const
        for (const [email, res, landing] of invited) {
          const body = await res.json()
          expect(res.status, JSON.stringify(body)).toBe(200)
          /* the inviter is told it was emailed, and never holds the link */
          expect(body.emailed).toBe(true)
          expect(body.link).toBeUndefined()
          expect(JSON.stringify(body)).not.toContain('/invite/')

          await vi.waitFor(() => expect(sinkLink(sink.mails, email)).toBeTruthy(), { timeout: 10_000 })
          const link = sinkLink(sink.mails, email)!
          const person = new Client(mailed)
          const accepted = await person.post(`/api/invite-links/${tokenOf(link)}/accept`, {
            name: 'Ivy',
            password: 'password12345',
          })
          expect(accepted.status, await accepted.clone().text()).toBe(200)
          expect(await accepted.json()).toEqual({ landing })
          const session = await (await person.get('/api/auth/get-session')).json()
          expect(session.user).toMatchObject({ email, emailVerified: true })
          /* the accept route's verification stands in for afterEmailVerification, so it joins the default workspace */
          const everyone = await person.get(`/api/workspaces/${defaultWsId}`)
          expect(everyone.status, await everyone.clone().text()).toBe(200)
          expect((await everyone.json()).role).toBe('member')
        }
        /* no verification mail went to either invitee: the link was the proof */
        expect(
          sink.mails.filter((m) => m.data.includes('Verify your doop email') && m.to.endsWith('inbox@test.dev')),
        ).toEqual([])
      } finally {
        mailed.stop()
        await sink.stop()
      }
    }, 70_000)

    it('answers a failed invite email with an error and drops the invite, never handing out the link', async () => {
      /* a port that was just listening and no longer is: every send is refused */
      const gone = await startSmtpSink()
      await gone.stop()
      const { mailed, boss } = await mailedServer(gone.port)
      try {
        const wsId = (await (await boss.post('/api/workspaces', { name: 'Bounce Co' })).json()).id
        const cvId = (await (await boss.post('/api/canvases', { name: 'Bounce board' })).json()).id
        for (const res of [
          await boss.post(`/api/workspaces/${wsId}/members`, { email: 'wsbounce@test.dev' }),
          await boss.post(`/api/canvases/${cvId}/members`, { email: 'cvbounce@test.dev' }),
        ]) {
          const text = await res.text()
          expect(res.status, text).toBe(502)
          expect(JSON.parse(text).error).toBe('could not send the invite email. Try again.')
          expect(text).not.toContain('/invite/')
        }
        const detail = await (await boss.get(`/api/workspaces/${wsId}`)).json()
        expect(emailsOf(detail.invites)).not.toContain('wsbounce@test.dev')
        const pending = await (await boss.get(`/api/canvases/${cvId}/invites`)).json()
        expect(emailsOf(pending)).not.toContain('cvbounce@test.dev')
      } finally {
        mailed.stop()
      }
    }, 70_000)

    it('keeps an invite already pending when a re-invite to the address cannot be mailed', async () => {
      const sink = await startSmtpSink()
      const { mailed, boss } = await mailedServer(sink.port)
      let sinkUp = true
      try {
        const wsId = (await (await boss.post('/api/workspaces', { name: 'Resend Co' })).json()).id
        const cvId = (await (await boss.post('/api/canvases', { name: 'Resend board' })).json()).id
        const routes = [
          ['wsresend@test.dev', `/api/workspaces/${wsId}/members`, { role: 'admin' }],
          ['cvresend@test.dev', `/api/canvases/${cvId}/members`, {}],
        ] as const
        const delivered = new Map<string, string>()
        for (const [email, route, extra] of routes) {
          const res = await boss.post(route, { email, ...extra })
          expect(res.status, await res.clone().text()).toBe(200)
          await vi.waitFor(() => expect(sinkLink(sink.mails, email)).toBeTruthy(), { timeout: 10_000 })
          delivered.set(email, sinkLink(sink.mails, email)!)
        }

        /* the sink goes away, so every later send is refused */
        await sink.stop()
        sinkUp = false
        for (const [email, route] of routes) {
          const res = await boss.post(route, { email })
          expect(res.status, await res.clone().text()).toBe(502)
        }

        const detail = await (await boss.get(`/api/workspaces/${wsId}`)).json()
        const wsInvite = detail.invites.find((i: { email: string }) => i.email === 'wsresend@test.dev')
        /* the earlier invite as it was, its admin role included */
        expect(wsInvite?.role).toBe('admin')
        const pending = await (await boss.get(`/api/canvases/${cvId}/invites`)).json()
        expect(emailsOf(pending)).toContain('cvresend@test.dev')
        for (const link of delivered.values()) {
          const info = await new Client(mailed).get(`/api/invite-links/${tokenOf(link)}`)
          expect(info.status, link).toBe(200)
        }
      } finally {
        mailed.stop()
        if (sinkUp) await sink.stop()
      }
    }, 70_000)
  })

  it('rate-limits the accept route per invited address, whatever address the request claims', async () => {
    const link = (await inviteToWorkspace('limit@example.com')).body.link
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) {
      const res = await new Client(server).req(`/api/invite-links/${tokenOf(link)}/accept`, {
        method: 'POST',
        headers: { 'X-Forwarded-For': `203.0.113.${i}` },
        body: JSON.stringify({ name: '', password: '' }),
      })
      statuses.push(res.status)
    }
    expect(statuses).toEqual([400, 400, 400, 429, 429])
  })

  it('answers a rejected accept without spending the invite, so the right one still works', async () => {
    const { body } = await inviteToWorkspace('retry@example.com')
    const noName = await acceptAs(new Client(server), body.link, { name: '  ', password: 'password12345' })
    expect(noName.status).toBe(400)
    const weak = await acceptAs(new Client(server), body.link, { name: 'Rita', password: 'short' })
    expect(weak.status).toBe(400)
    expect((await infoOf(body.link)).status).toBe(200)
    expect((await new Client(server).post('/api/account-exists', { email: 'retry@example.com' })).status).toBe(200)

    const person = new Client(server)
    const ok = await acceptAs(person, body.link, { name: 'Rita', password: 'password12345' })
    expect(ok.status, await ok.clone().text()).toBe(200)
    expect((await (await person.get('/api/me')).json()).email).toBe('retry@example.com')
  })

  it('answers overlapping accepts of one link with one account and in-progress for the rest', async () => {
    const { body } = await inviteToWorkspace('overlap@example.com')
    const results = await Promise.all(
      [1, 2, 3].map(async () => {
        const res = await acceptAs(new Client(server), body.link, { name: 'Ova', password: 'password12345' })
        return { status: res.status, body: await res.json() }
      }),
    )
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    const rest = results.filter((r) => r.status !== 200)
    expect(rest).toEqual([
      { status: 409, body: { error: 'in-progress' } },
      { status: 409, body: { error: 'in-progress' } },
    ])
  })

  it('refuses a plain sign-up for another address while an accept is in flight', async () => {
    const { body } = await inviteToWorkspace('inflight@example.com')
    const intruders = [1, 2, 3, 4].map((i) =>
      new Client(server).req('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { Origin: server.base, 'X-Forwarded-For': `192.0.2.${i}` },
        body: JSON.stringify({ email: `intruder${i}@example.com`, password: 'password12345', name: 'Intruder' }),
      }),
    )
    const [accepted, ...refused] = await Promise.all([
      acceptAs(new Client(server), body.link, { name: 'In', password: 'password12345' }),
      ...intruders,
    ])
    expect(accepted!.status).toBe(200)
    expect(refused.map((r) => r.status)).toEqual([400, 400, 400, 400])
    const exists = await new Client(server).post('/api/account-exists', { email: 'intruder1@example.com' })
    expect(await exists.json()).toEqual({ exists: false })
  })

  it('re-issuing an invite for the same address kills the old link, for a workspace and a canvas', async () => {
    const ws1 = await inviteToWorkspace('again@example.com')
    const ws2 = await inviteToWorkspace('again@example.com')
    expect(ws2.body.link).not.toBe(ws1.body.link)
    expect((await infoOf(ws1.body.link)).status).toBe(404)
    expect((await infoOf(ws2.body.link)).status).toBe(200)

    const cv1 = await inviteToCanvas('again@example.com')
    const cv2 = await inviteToCanvas('again@example.com')
    expect(cv2.body.link).not.toBe(cv1.body.link)
    expect((await infoOf(cv1.body.link)).status).toBe(404)
    const stale = await acceptAs(new Client(server), cv1.body.link, { name: 'Old', password: 'password12345' })
    expect(stale.status).toBe(404)
    expect((await infoOf(cv2.body.link)).status).toBe(200)
  })

  it('describes a canvas link, and lets an account made after the invite join it with the link', async () => {
    const { body } = await inviteToCanvas('latecomer@signup-closed.invalid')
    const info = await (await infoOf(body.link)).json()
    expect(info).toEqual({
      kind: 'canvas',
      email: 'latecomer@signup-closed.invalid',
      inviterName: 'Boss',
      targetName: 'Shared board',
      accountExists: false,
    })

    const late = await signUpFresh('latecomer@signup-closed.invalid', 'Late')
    expect((await late.get(`/api/canvases/${canvasId}`)).status).not.toBe(200)
    expect((await (await infoOf(body.link)).json()).accountExists).toBe(true)
    const blocked = await acceptAs(new Client(server), body.link, { name: 'Late', password: 'password12345' })
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toEqual({ error: 'account-exists' })

    /* a different account cannot spend it */
    const other = await signUpFresh('bystander@signup-closed.invalid', 'By')
    expect((await other.post(`/api/invite-links/${tokenOf(body.link)}/join`)).status).toBe(404)

    const joined = await late.post(`/api/invite-links/${tokenOf(body.link)}/join`)
    expect(joined.status).toBe(200)
    expect((await joined.json()).landing).toBe(`/c/${canvasId}`)
    expect((await late.get(`/api/canvases/${canvasId}`)).status).toBe(200)
    expect(emailsOf(await (await owner.get(`/api/canvases/${canvasId}/invites`)).json())).not.toContain(
      'latecomer@signup-closed.invalid',
    )
  })

  it('keeps pending canvas invites to the owner, and a revoke to its own canvas', async () => {
    const member = await signUpFresh('editor@signup-closed.invalid', 'Ed')
    const stranger = await signUpFresh('stranger@signup-closed.invalid', 'Str')
    const shared = await newCanvas('Owner only')
    const added = await owner.post(`/api/canvases/${shared}/members`, { email: 'editor@signup-closed.invalid' })
    expect(added.status).toBe(200)
    const pending = await inviteToCanvas('pending@example.com', shared)

    /* an editor who is not the owner sees and revokes nothing */
    expect((await member.get(`/api/canvases/${shared}/invites`)).status).toBe(403)
    expect((await member.delete(`/api/canvases/${shared}/invites/${pending.body.invite.id}`)).status).toBe(403)
    expect((await stranger.get(`/api/canvases/${shared}/invites`)).status).not.toBe(200)
    expect((await stranger.delete(`/api/canvases/${shared}/invites/${pending.body.invite.id}`)).status).not.toBe(200)
    expect((await infoOf(pending.body.link)).status).toBe(200)

    /* the owner naming another canvas's invite id removes nothing */
    await owner.delete(`/api/canvases/${canvasId}/invites/${pending.body.invite.id}`)
    expect(emailsOf(await (await owner.get(`/api/canvases/${shared}/invites`)).json())).toEqual(['pending@example.com'])
    expect((await infoOf(pending.body.link)).status).toBe(200)

    /* and on its own canvas it does */
    await owner.delete(`/api/canvases/${shared}/invites/${pending.body.invite.id}`)
    expect((await infoOf(pending.body.link)).status).toBe(404)
  })
})
