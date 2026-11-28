import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/*
 * The agent API (/api/v1, server/agentApi.ts) against the real server: frames as raw HTML
 * bodies, behind an agent key, with the frame's version as the ETag a write is held against.
 */

let server: Server
let owner: Client
let key = ''
let strangerKey = ''
let canvasId = ''

async function api(path: string, init: RequestInit & { as?: string } = {}) {
  const { as = key, ...rest } = init
  return fetch(`${server.base}/api/v1${path}`, {
    ...rest,
    headers: {
      ...(as ? { Authorization: `Bearer ${as}` } : {}),
      'Doop-Agent': 'Tester',
      ...(rest.body === undefined ? {} : { 'Content-Type': 'text/html' }),
      ...rest.headers,
    },
  })
}

async function keyFor(client: Client): Promise<string> {
  return ((await (await client.post('/api/agent-keys', { name: 'api' })).json()) as { secret: string }).secret
}

interface Written {
  frame: { id: string; name: string; version: string; width: number; updatedBy: string }
  html_changed: boolean
  warnings: string[]
  notes: string[]
  feedback: unknown[]
}

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('agent-api@test.dev', 'Owner')
  key = await keyFor(owner)
  strangerKey = await keyFor(await new Client(server).signUp('agent-api-stranger@test.dev', 'Stranger'))
  canvasId = ((await (await owner.post('/api/canvases', { name: 'Agent API' })).json()) as { id: string }).id
}, 70_000)

afterAll(() => server?.stop())

describe('the agent API', () => {
  let frameId = ''
  let version = ''

  it('takes an agent key and nothing else', async () => {
    expect(
      (await api(`/canvases/${canvasId}/frames?name=X`, { method: 'POST', body: '<p>x</p>', as: '' })).status,
    ).toBe(401)
    const badKey = await api(`/canvases/${canvasId}/frames?name=X`, {
      method: 'POST',
      body: '<p>x</p>',
      as: 'dpk_nope',
    })
    expect(badKey.status).toBe(401)
    expect(((await badKey.json()) as { error: { code: string } }).error.code).toBe('unauthorized')
    /* a browser session is not a way in: these routes sit ahead of the session gate */
    const withCookie = await owner.req(`/api/v1/canvases/${canvasId}/frames?name=X`, {
      method: 'POST',
      body: '<p>x</p>',
      headers: { 'Content-Type': 'text/html' },
    })
    expect(withCookie.status).toBe(401)
    expect((await api('/nothing/here')).status).toBe(404)
  })

  it('creates a frame from a raw body and reads it back as HTML', async () => {
    const created = await api(`/canvases/${canvasId}/frames?name=Hero&width=800&height=600`, {
      method: 'POST',
      body: '<main><h1>Hello</h1></main>',
    })
    expect(created.status).toBe(201)
    const body = (await created.json()) as Written
    expect(body.frame).toMatchObject({ name: 'Hero', width: 800, updatedBy: 'Tester' })
    expect(body.html_changed).toBe(false)
    frameId = body.frame.id
    version = body.frame.version
    expect(created.headers.get('etag')).toBe(`"${version}"`)

    const read = await api(`/frames/${frameId}/html`)
    expect(read.headers.get('content-type')).toContain('text/html')
    expect(read.headers.get('etag')).toBe(`"${version}"`)
    expect(await read.text()).toBe('<main><h1>Hello</h1></main>')
    const meta = JSON.parse(decodeURIComponent(read.headers.get('doop-frame') ?? '')) as { id: string }
    expect(meta.id).toBe(frameId)
    expect((await api(`/canvases/${canvasId}/frames`, { method: 'POST', body: '<p>x</p>' })).status).toBe(400)
  })

  it('hides a frame from a key whose account cannot open the canvas', async () => {
    expect((await api(`/frames/${frameId}/html`, { as: strangerKey })).status).toBe(404)
    const write = await api(`/frames/${frameId}/html`, { method: 'PUT', body: '<p>theirs</p>', as: strangerKey })
    expect(write.status).toBe(404)
    expect(await (await api(`/frames/${frameId}/html`)).text()).toContain('Hello')
  })

  it('writes only while the frame is at the version the client edited', async () => {
    const first = await api(`/frames/${frameId}/html`, {
      method: 'PUT',
      body: '<main><h1>Second</h1></main>',
      headers: { 'If-Match': `"${version}"` },
    })
    expect(first.status).toBe(200)
    const next = ((await first.json()) as Written).frame.version
    expect(next).not.toBe(version)

    const stale = await api(`/frames/${frameId}/html`, {
      method: 'PUT',
      body: '<main><h1>From the older file</h1></main>',
      headers: { 'If-Match': `"${version}"` },
    })
    expect(stale.status).toBe(409)
    const refusal = (await stale.json()) as {
      error: { code: string; frame: { version: string; updatedBy: string; width: number } }
    }
    expect(refusal.error).toMatchObject({ code: 'conflict', frame: { version: next, updatedBy: 'Tester', width: 800 } })
    expect(await (await api(`/frames/${frameId}/html`)).text()).toContain('Second')

    const garbled = await api(`/frames/${frameId}/html`, {
      method: 'PUT',
      body: '<p>x</p>',
      headers: { 'If-Match': '"yesterday"' },
    })
    expect(garbled.status).toBe(400)
    /* no If-Match writes whatever is there */
    expect((await api(`/frames/${frameId}/html`, { method: 'PUT', body: '<main><h1>Third</h1></main>' })).status).toBe(
      200,
    )
  })

  it('refuses inline data and a body that is not HTML, writing nothing', async () => {
    const inline = await api(`/frames/${frameId}/html`, {
      method: 'PUT',
      body: `<main><img src="data:image/png;base64,${'A'.repeat(4000)}"></main>`,
    })
    expect(inline.status).toBe(422)
    const refused = (await inline.json()) as { error: { code: string; message: string } }
    expect(refused.error.code).toBe('refused')
    expect(refused.error.message).toContain('base64')

    /* a JSON body would otherwise arrive parsed, and blank the frame */
    const json = await api(`/frames/${frameId}/html`, {
      method: 'PUT',
      body: JSON.stringify({ html: '<p>x</p>' }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(json.status).toBe(400)
    expect(await (await api(`/frames/${frameId}/html`)).text()).toContain('Third')

    /* a streamed body has no Content-Length, and is still a body */
    const chunked = await api(`/frames/${frameId}/html`, {
      method: 'PUT',
      body: new Blob([JSON.stringify({ html: '<p>x</p>' })]).stream(),
      headers: { 'Content-Type': 'application/json' },
      duplex: 'half',
    } as RequestInit)
    expect(chunked.status).toBe(400)
    expect(await (await api(`/frames/${frameId}/html`)).text()).toContain('Third')
  })

  it('writes a streamed HTML body, and a streamed empty body is an empty file like a bodiless one', async () => {
    const streamed = await api(`/frames/${frameId}/html`, {
      method: 'PUT',
      body: new Blob(['<main><h1>Streamed</h1></main>']).stream(),
      headers: { 'Content-Type': 'text/html' },
      duplex: 'half',
    } as RequestInit)
    expect(streamed.status).toBe(200)
    expect(await (await api(`/frames/${frameId}/html`)).text()).toBe('<main><h1>Streamed</h1></main>')

    /* the documented rule is that an empty file is an empty frame; chunking must not change which side of it a body lands on */
    const hollow = await api(`/frames/${frameId}/html`, {
      method: 'PUT',
      body: new Blob([]).stream(),
      headers: { 'Content-Type': 'text/html' },
      duplex: 'half',
    } as RequestInit)
    expect(hollow.status).toBe(200)
    expect(await (await api(`/frames/${frameId}/html`)).text()).toBe('')

    await api(`/frames/${frameId}/html`, { method: 'PUT', body: '<main><h1>Again</h1></main>' })
    const bodiless = await api(`/frames/${frameId}/html`, { method: 'PUT', headers: { 'Content-Type': 'text/html' } })
    expect(bodiless.status).toBe(200)
    expect(await (await api(`/frames/${frameId}/html`)).text()).toBe('')
    await api(`/frames/${frameId}/html`, { method: 'PUT', body: '<main><h1>Third</h1></main>' })
  })

  it('says what could not be done with components, and serves the rendered form', async () => {
    const written = await api(`/frames/${frameId}/html`, {
      method: 'PUT',
      body: '<main><h1>Fourth</h1><doop-use component="Nope"></doop-use></main>',
    })
    expect(written.status).toBe(200)
    expect(((await written.json()) as Written).warnings).toEqual([expect.stringContaining('no component “Nope”')])

    const tokens = await owner.post(`/api/canvases/${canvasId}/tokens`, {
      tokens: [{ name: '--color-brand', type: 'color', value: '#0177d3' }],
    })
    expect(tokens.status).toBe(200)
    const source = '<main><h1 style="color: var(--color-brand)">Fifth</h1></main>'
    expect((await api(`/frames/${frameId}/html`, { method: 'PUT', body: source })).status).toBe(200)
    /* the source names the token; the rendered form carries its value */
    expect(await (await api(`/frames/${frameId}/html`)).text()).toBe(source)
    expect(await (await api(`/frames/${frameId}/html?form=rendered`)).text()).toContain('#0177d3')
  })
})

describe('a key held to its scope and workspace limit', () => {
  let commentKey = ''
  let limitedKey = ''
  let limitedCommentKey = ''
  let ids: { inside: string; other: string; personal: string; shared: string }
  let frames: Record<keyof typeof ids, string>

  const mint = async (body: Record<string, unknown>) =>
    ((await (await owner.post('/api/agent-keys', { name: 'scoped', ...body })).json()) as { secret: string }).secret

  beforeAll(async () => {
    const wsInside = ((await (await owner.post('/api/workspaces', { name: 'Inside' })).json()) as { id: string }).id
    const wsOther = ((await (await owner.post('/api/workspaces', { name: 'Other' })).json()) as { id: string }).id
    const host = await new Client(server).signUp('agent-api-host@test.dev', 'Host')
    const make = async (who: Client, name: string, workspaceId?: string) => {
      const canvas = (await (await who.post('/api/canvases', { name, workspaceId })).json()) as { id: string }
      const frame = (await (await who.post(`/api/canvases/${canvas.id}/frames`, { name })).json()) as { id: string }
      return { canvas: canvas.id, frame: frame.id }
    }
    const inside = await make(owner, 'Inside', wsInside)
    const other = await make(owner, 'Other', wsOther)
    const personal = await make(owner, 'Personal')
    const shared = await make(host, 'Shared')
    expect((await host.post(`/api/canvases/${shared.canvas}/members`, { email: 'agent-api@test.dev' })).status).toBe(
      200,
    )
    ids = { inside: inside.canvas, other: other.canvas, personal: personal.canvas, shared: shared.canvas }
    frames = { inside: inside.frame, other: other.frame, personal: personal.frame, shared: shared.frame }
    commentKey = await mint({ scope: 'comment' })
    limitedKey = await mint({ workspaceIds: [wsInside] })
    limitedCommentKey = await mint({ scope: 'comment', workspaceIds: [wsInside] })
  })

  const htmlOf = async (frame: string) => (await api(`/frames/${frame}/html`)).text()

  it('lets a comment key read and refuses it every write', async () => {
    expect((await api(`/frames/${frames.personal}/html`, { as: commentKey })).status).toBe(200)
    const put = await api(`/frames/${frames.personal}/html`, { method: 'PUT', body: '<p>x</p>', as: commentKey })
    expect(put.status).toBe(403)
    expect(((await put.json()) as { error: { code: string } }).error.code).toBe('forbidden')
    const post = await api(`/canvases/${ids.personal}/frames?name=New`, {
      method: 'POST',
      body: '<p>x</p>',
      as: commentKey,
    })
    expect(post.status).toBe(403)
    expect(await (await api(`/frames/${frames.personal}/html`)).text()).not.toContain('<p>x</p>')
  })

  it('answers a canvas outside the key’s workspace as a made-up id, leaving its frame as it was', async () => {
    for (const where of ['other', 'personal', 'shared'] as const) {
      /* the same account reaches it without the limit, so the 404 is the limit's and not a missing membership */
      expect((await api(`/frames/${frames[where]}/html`)).status).toBe(200)
      const before = await htmlOf(frames[where])
      expect((await api(`/frames/${frames[where]}/html`, { as: limitedKey })).status).toBe(404)
      const put = await api(`/frames/${frames[where]}/html`, { method: 'PUT', body: '<p>x</p>', as: limitedKey })
      expect(put.status).toBe(404)
      const post = await api(`/canvases/${ids[where]}/frames?name=New`, {
        method: 'POST',
        body: '<p>x</p>',
        as: limitedKey,
      })
      expect(post.status).toBe(404)
      expect(await htmlOf(frames[where])).toBe(before)
    }
  })

  it('answers a comment key outside its workspace limit as a made-up id, not as a refused write', async () => {
    for (const where of ['other', 'personal', 'shared'] as const) {
      const before = await htmlOf(frames[where])
      expect((await api(`/frames/${frames[where]}/html`, { as: limitedCommentKey })).status).toBe(404)
      const put = await api(`/frames/${frames[where]}/html`, { method: 'PUT', body: '<p>x</p>', as: limitedCommentKey })
      expect(put.status).toBe(404)
      const post = await api(`/canvases/${ids[where]}/frames?name=New`, {
        method: 'POST',
        body: '<p>x</p>',
        as: limitedCommentKey,
      })
      expect(post.status).toBe(404)
      expect(await htmlOf(frames[where])).toBe(before)
    }
    /* inside the limit the same key reads and is refused a write with a 403, so the 404s above are the limit's */
    expect((await api(`/frames/${frames.inside}/html`, { as: limitedCommentKey })).status).toBe(200)
    const inside = await api(`/frames/${frames.inside}/html`, {
      method: 'PUT',
      body: '<p>x</p>',
      as: limitedCommentKey,
    })
    expect(inside.status).toBe(403)
  })

  it('serves a limited key inside its workspace', async () => {
    expect((await api(`/frames/${frames.inside}/html`, { as: limitedKey })).status).toBe(200)
    const post = await api(`/canvases/${ids.inside}/frames?name=New`, {
      method: 'POST',
      body: '<p>x</p>',
      as: limitedKey,
    })
    expect(post.status).toBe(201)
  })
})

describe('the agent API in analytics', () => {
  /* The server is a child process, so PostHog is a local sink it is pointed at. */
  let sink: HttpServer
  const posted: { event?: string; distinct_id?: string; properties?: Record<string, unknown> }[] = []
  let analytics: Server

  beforeAll(async () => {
    sink = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        try {
          posted.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          /* not a capture */
        }
        res.statusCode = 202
        res.end()
      })
    })
    await new Promise((resolve) => sink.listen(0, '127.0.0.1', () => resolve(undefined)))
    const origin = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`
    analytics = await startServer({ POSTHOG_KEY: 'phc_test', POSTHOG_INGEST_HOST: origin })
  }, 70_000)

  afterAll(async () => {
    analytics?.stop()
    sink?.close()
  })

  it('reports the route a key used, never the frame or canvas it named', async () => {
    const person = await new Client(analytics).signUp('agent-api-analytics@test.dev', 'Analyst')
    const secret = ((await (await person.post('/api/agent-keys', { name: 'api' })).json()) as { secret: string }).secret
    const canvas = (await (await person.post('/api/canvases', { name: 'Tracked' })).json()) as { id: string }
    const frame = (await (await person.post(`/api/canvases/${canvas.id}/frames`, { name: 'Tracked' })).json()) as {
      id: string
    }

    const res = await fetch(`${analytics.base}/api/v1/frames/${frame.id}/html`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'text/html', 'Doop-Agent': 'Tester' },
      body: '<p>x</p>',
    })
    expect(res.status).toBe(200)

    await vi.waitFor(() => expect(posted.some((event) => event.event === 'custom_agent_used')).toBe(true))
    const used = posted.filter((event) => event.event === 'custom_agent_used')
    expect(used).toHaveLength(1)
    expect(used[0]?.properties).toMatchObject({ first_tool: 'api frame.write' })
    expect(JSON.stringify(used[0])).not.toContain(frame.id)
    expect(JSON.stringify(used[0])).not.toContain(canvas.id)
  })
})
