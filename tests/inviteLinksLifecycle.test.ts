import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * What an invite link does over time: the database rows behind it (hash at
 * rest, expiry) and the attempt window. The server runs on a clock this file
 * can push forward (fixtures/clockShift.mjs), and the database is edited
 * between a stop and a reboot of the same data directory, so nothing waits.
 */

const clockDir = mkdtempSync(path.join(tmpdir(), 'doop-clock-'))
const clockFile = path.join(clockDir, 'shift')
const env = {
  NODE_ENV: 'production',
  BETTER_AUTH_SECRET: 'test-secret-not-for-real-use',
  SIGNUP_EMAIL_DOMAINS: 'signup-closed.invalid',
  CLOCK_SHIFT_FILE: clockFile,
  NODE_OPTIONS: `--import ${path.join(process.cwd(), 'tests', 'fixtures', 'clockShift.mjs')}`,
}

let server: Server
let owner: Client
let workspaceId: string
let canvasId: string
let nextIp = 10

const tokenOf = (link: string) => link.slice(link.lastIndexOf('/') + 1)
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const shiftClock = (ms: number) => writeFileSync(clockFile, String(ms))

beforeAll(async () => {
  writeFileSync(clockFile, '0')
  server = await startServer(env)
  owner = new Client(server)
  await owner.signUp('boss@signup-closed.invalid', 'Boss')
  workspaceId = (await (await owner.post('/api/workspaces', { name: 'Clock Co' })).json()).id
  canvasId = (await (await owner.post('/api/canvases', { name: 'Clock board' })).json()).id
}, 70_000)

afterAll(() => {
  server?.stop()
  rmSync(clockDir, { recursive: true, force: true })
})

async function inviteToWorkspace(email: string) {
  return (await (await owner.post(`/api/workspaces/${workspaceId}/members`, { email })).json()) as {
    link: string
    invite: { id: string }
  }
}

async function inviteToCanvas(email: string) {
  return (await (await owner.post(`/api/canvases/${canvasId}/members`, { email })).json()) as {
    link: string
    invite: { id: string }
  }
}

/** Run SQL against the database with the server stopped, then boot it again. */
async function withDatabaseStopped<T>(run: (query: (sql: string) => Promise<Record<string, unknown>[]>) => Promise<T>) {
  server.stop({ keepData: true })
  await server.stopped
  const { PGlite } = await import('@electric-sql/pglite')
  const pg = new PGlite(path.join(server.dataDir, 'data', 'pg'))
  try {
    return await run(async (sql) => (await pg.query(sql)).rows as Record<string, unknown>[])
  } finally {
    await pg.close()
    server = await startServer(env, server.dataDir)
  }
}

function accept(link: string, body: unknown = { name: 'Ann', password: 'password12345' }, client = new Client(server)) {
  return client.post(`/api/invite-links/${tokenOf(link)}/accept`, body)
}

async function signUpFresh(email: string): Promise<Client> {
  const client = new Client(server)
  const res = await client.req('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { Origin: server.base, 'X-Forwarded-For': `198.18.1.${nextIp++}` },
    body: JSON.stringify({ email, password: 'password12345', name: 'Joiner' }),
  })
  expect(res.status, await res.clone().text()).toBe(200)
  return client
}

describe('invite links over time', () => {
  it('keeps only the sha256 of the token, and a stored hash is no way in', async () => {
    const ws = await inviteToWorkspace('rest-ws@example.com')
    const cv = await inviteToCanvas('rest-cv@example.com')
    const rows = await withDatabaseStopped(async (query) => ({
      ws: await query(`select * from workspace_invites where email = 'rest-ws@example.com'`),
      cv: await query(`select * from canvas_invites where email = 'rest-cv@example.com'`),
    }))
    for (const [row, link] of [
      [rows.ws[0]!, ws.link],
      [rows.cv[0]!, cv.link],
    ] as const) {
      expect(row.token_hash).toBe(sha256(tokenOf(link)))
      expect(JSON.stringify(row)).not.toContain(tokenOf(link))
    }
    for (const hash of [rows.ws[0]!.token_hash, rows.cv[0]!.token_hash] as string[]) {
      expect((await new Client(server).get(`/api/invite-links/${hash}`)).status).toBe(404)
      expect((await accept(`${server.base}/invite/${hash}`)).status).toBe(404)
    }
  }, 70_000)

  it('treats an expired workspace or canvas invite as invalid on info, accept and join, and drops it from the lists', async () => {
    const cases = {
      infoWs: await inviteToWorkspace('exp-info-ws@example.com'),
      infoCv: await inviteToCanvas('exp-info-cv@example.com'),
      acceptWs: await inviteToWorkspace('exp-accept-ws@example.com'),
      acceptCv: await inviteToCanvas('exp-accept-cv@example.com'),
      listWs: await inviteToWorkspace('exp-list-ws@example.com'),
      listCv: await inviteToCanvas('exp-list-cv@example.com'),
      joinWs: await inviteToWorkspace('exp-join@signup-closed.invalid'),
      joinCv: await inviteToCanvas('exp-join@signup-closed.invalid'),
      liveWs: await inviteToWorkspace('exp-live-ws@example.com'),
      liveCv: await inviteToCanvas('exp-live-cv@example.com'),
    }
    const joiner = await signUpFresh('exp-join@signup-closed.invalid')
    await withDatabaseStopped(async (query) => {
      await query(
        `update workspace_invites set expires_at = 1000 where email like 'exp-%' and email not like 'exp-live%'`,
      )
      await query(`update canvas_invites set expires_at = 1000 where email like 'exp-%' and email not like 'exp-live%'`)
    })

    const anon = () => new Client(server)
    const invalid = { error: 'invalid' }
    for (const link of [cases.infoWs.link, cases.infoCv.link]) {
      const res = await anon().get(`/api/invite-links/${tokenOf(link)}`)
      expect([res.status, await res.json()]).toEqual([404, invalid])
    }
    for (const link of [cases.acceptWs.link, cases.acceptCv.link]) {
      const res = await accept(link)
      expect([res.status, await res.json()]).toEqual([404, invalid])
    }
    for (const link of [cases.joinWs.link, cases.joinCv.link]) {
      const res = await joiner.post(`/api/invite-links/${tokenOf(link)}/join`)
      expect([res.status, await res.json()]).toEqual([404, invalid])
    }
    expect((await joiner.get(`/api/workspaces/${workspaceId}`)).status).toBe(404)
    expect((await joiner.get(`/api/canvases/${canvasId}`)).status).not.toBe(200)

    const canvasList = (await (await owner.get(`/api/canvases/${canvasId}/invites`)).json()) as { email: string }[]
    const wsInvites = ((await (await owner.get(`/api/workspaces/${workspaceId}`)).json()).invites ?? []) as {
      email: string
    }[]
    for (const list of [canvasList, wsInvites]) {
      const emails = list.map((i) => i.email)
      expect(emails.filter((e) => e.startsWith('exp-'))).toEqual(
        expect.arrayContaining([expect.stringMatching(/^exp-live/)]),
      )
      expect(emails.filter((e) => e.startsWith('exp-') && !e.startsWith('exp-live'))).toEqual([])
    }
    /* a live invite beside them still resolves, so the above is expiry and not a broken read */
    for (const link of [cases.liveWs.link, cases.liveCv.link]) {
      expect((await anon().get(`/api/invite-links/${tokenOf(link)}`)).status).toBe(200)
    }
  })

  it('shares one budget between accept and join, and a new window gives it back', async () => {
    const { link } = await inviteToWorkspace('budget@example.com')
    const person = new Client(server)
    expect((await accept(link, {}, person)).status).toBe(400) // 1: no name
    expect((await accept(link, { name: 'Bud', password: 'password12345' }, person)).status).toBe(200) // 2
    const join = () => person.post(`/api/invite-links/${tokenOf(link)}/join`)
    expect((await join()).status).toBe(200) // 3: a spent link, presented again by its account
    expect((await join()).status).toBe(429)
    expect((await accept(link, {}, new Client(server))).status).toBe(404)

    shiftClock(11_000)
    expect((await join()).status).toBe(200)
  })

  it('starts the accept window over after ten seconds', async () => {
    const { link } = await inviteToWorkspace('window@example.com')
    const bad = async () => (await accept(link, { name: '', password: '' })).status
    expect([await bad(), await bad(), await bad(), await bad()]).toEqual([400, 400, 400, 429])
    shiftClock(25_000)
    expect(await bad()).toBe(400)
  })
})
