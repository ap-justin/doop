import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * DOOP_LEAN=1 end to end, beside the same server with lean off: the disabled
 * features' routes answer as routes that do not exist, everything kept still
 * works, an @mention queues nothing, and MCP agents get no Linear tools.
 */

/** No free resident tasks and no model keys: off, an @mention is refused by the meter. */
const AGENT_OFF = { RESIDENT_TASK_LIMIT: '0', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' }

interface Booted {
  server: Server
  owner: Client
  canvasId: string
  pageId: string
  workspaceId: string
  commentId: string
}

async function boot(env: Record<string, string>, email: string): Promise<Booted> {
  const server = await startServer({ ...AGENT_OFF, ...env })
  const owner = await new Client(server).signUp(email, 'Owner')
  const canvas = await (await owner.post('/api/canvases', { name: 'Lean' })).json()
  const workspace = await (await owner.post('/api/workspaces', { name: 'Team' })).json()
  const comment = await (
    await owner.post(`/api/canvases/${canvas.id}/comments`, { pageId: canvas.pages[0].id, x: 1, y: 2, text: 'Plain' })
  ).json()
  return {
    server,
    owner,
    canvasId: canvas.id,
    pageId: canvas.pages[0].id,
    workspaceId: workspace.id,
    commentId: comment.id,
  }
}

/** One request per disabled route family. */
function disabledRoutes({ canvasId, workspaceId, commentId }: Booted): [method: string, path: string][] {
  return [
    ['POST', '/stripe/webhook'],
    ['POST', '/webhooks/slack'],
    ['POST', '/webhooks/linear'],
    ['POST', '/local-agent/mcp/run-1'],
    ['POST', '/gemini-cloud/mcp/run-1'],
    ['GET', '/api/live-activities/config'],
    ['GET', '/api/community'],
    ['GET', '/api/automations'],
    ['GET', '/api/integrations'],
    ['GET', '/api/integrations/linear/callback'],
    ['GET', '/api/model-account'],
    ['GET', '/api/model-account/models'],
    ['GET', '/api/agent-runners'],
    ['GET', '/api/agent-allowance'],
    ['GET', '/api/local-agent'],
    ['GET', '/api/image-model'],
    ['PUT', '/api/image-model'],
    ['GET', '/api/billing/plans'],
    ['GET', '/api/github/app'],
    ['GET', `/api/canvases/${canvasId}/github`],
    ['POST', `/api/canvases/${canvasId}/cards`],
    ['PUT', `/api/canvases/${canvasId}/publish`],
    ['DELETE', `/api/canvases/${canvasId}/publish`],
    ['POST', '/api/tasks/task-1/feedback'],
    ['POST', '/api/feedback/fb-1/retry'],
    ['POST', `/api/comments/${commentId}/retry`],
    ['POST', `/api/workspaces/${workspaceId}/billing/checkout`],
    ['POST', `/api/workspaces/${workspaceId}/billing/portal`],
    ['POST', `/api/workspaces/${workspaceId}/billing/sync`],
  ]
}

async function mcp(server: Server, secret: string, method: string) {
  const res = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
  })
  return (await res.json()) as { result?: { tools?: { name: string }[] } }
}

async function toolNames(b: Booted): Promise<string[]> {
  const { secret } = (await (await b.owner.post('/api/agent-keys', { name: 'all' })).json()) as { secret: string }
  return ((await mcp(b.server, secret, 'tools/list')).result?.tools ?? []).map((t) => t.name)
}

const LINEAR_TOOLS = ['list_linear_issues', 'get_linear_issue']

describe('lean mode on', () => {
  let b: Booted

  beforeAll(async () => {
    b = await boot({ DOOP_LEAN: '1' }, 'lean-owner@test.dev')
  }, 70_000)

  afterAll(() => b?.server.stop())

  it('answers every disabled route family as a route that does not exist', async () => {
    for (const [method, path] of disabledRoutes(b)) {
      const res = await b.owner.req(path, { method, body: method === 'GET' ? undefined : '{}' })
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 })
      expect(await res.text()).toContain(`Cannot ${method} ${path}`)
    }
  })

  it('refuses them before the session gate too', async () => {
    const res = await new Client(b.server).get('/api/billing/plans')
    expect(res.status).toBe(404)
    expect((await new Client(b.server).get('/api/workspaces')).status).toBe(401)
  })

  it('says so in the locale config', async () => {
    const res = await new Client(b.server).get('/api/locale-config')
    expect(await res.json()).toEqual({ defaultLocale: 'en', lean: true })
  })

  it('keeps workspaces, agent keys, account webhooks and comments', async () => {
    const list = await b.owner.get('/api/workspaces')
    expect(list.status).toBe(200)
    expect((await list.json()).billing).toEqual({ enabled: false })
    expect((await b.owner.get('/api/agent-keys')).status).toBe(200)
    expect((await b.owner.get('/api/webhooks')).status).toBe(200)
    const reply = await b.owner.post(`/api/comments/${b.commentId}/replies`, { text: 'Thanks' })
    expect(reply.status).toBe(200)
    expect((await b.owner.post(`/api/comments/${b.commentId}/resolve`)).status).toBe(200)
  })

  it('stores an @mention as a plain comment: no task, no meter, no refusal', async () => {
    const res = await b.owner.post(`/api/canvases/${b.canvasId}/comments`, {
      pageId: b.pageId,
      x: 5,
      y: 5,
      text: '@Doop make the hero blue',
    })
    expect(res.status).toBe(200)
    const comment = await res.json()
    expect(comment.text).toBe('@Doop make the hero blue')
    expect(comment.forAgent).toBeUndefined()
    expect(comment.targetAgent).toBeUndefined()
    const reply = await b.owner.post(`/api/comments/${comment.id}/replies`, { text: '@Doop and the footer' })
    expect(reply.status).toBe(200)
    expect((await reply.json()).forAgent).toBeUndefined()
  })

  it('creates no first canvas at sign-up and lands the new account on home', async () => {
    const fresh = await new Client(b.server).signUp('lean-fresh@test.dev', 'Fresh')
    const canvases = await (await fresh.get('/api/canvases')).text()
    expect(canvases).not.toContain('first canvas')
    const landing = await fresh.get('/api/welcome')
    expect(landing.status).toBe(302)
    expect(landing.headers.get('location')).toBe('/')
  })

  it('lists no Linear tools to an unlimited agent key, and keeps the design tools', async () => {
    const names = await toolNames(b)
    for (const tool of LINEAR_TOOLS) expect(names).not.toContain(tool)
    for (const tool of ['create_canvas', 'reply_to_comment', 'resolve_comment', 'generate_image', 'upload_asset'])
      expect(names).toContain(tool)
  })
})

describe('lean mode off', () => {
  let b: Booted

  beforeAll(async () => {
    b = await boot({ DOOP_LEAN: '' }, 'full-owner@test.dev')
  }, 70_000)

  afterAll(() => b?.server.stop())

  it('serves every route family lean mode disables', async () => {
    for (const [method, path] of disabledRoutes(b)) {
      const res = await b.owner.req(path, { method, body: method === 'GET' ? undefined : '{}' })
      expect(await res.text(), `${method} ${path}`).not.toContain(`Cannot ${method}`)
    }
  })

  it('says lean is off in the locale config', async () => {
    const res = await new Client(b.server).get('/api/locale-config')
    expect(await res.json()).toEqual({ defaultLocale: 'en', lean: false })
  })

  it('meters an @mention as a task for the resident agent', async () => {
    const res = await b.owner.post(`/api/canvases/${b.canvasId}/comments`, {
      pageId: b.pageId,
      x: 5,
      y: 5,
      text: '@Doop make the hero blue',
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('resident_limit')
  })

  it('creates the first canvas at sign-up', async () => {
    const canvases = await (await b.owner.get('/api/canvases')).text()
    expect(canvases).toContain('first canvas')
  })

  it('lists the Linear tools to an unlimited agent key', async () => {
    const names = await toolNames(b)
    for (const tool of LINEAR_TOOLS) expect(names).toContain(tool)
  })
})
