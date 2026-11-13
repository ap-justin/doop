import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * DOOP_LEAN=1 end to end, beside the same server with lean off: the disabled
 * features' routes answer as routes that do not exist, everything kept still
 * works, an @mention queues nothing, and MCP agents get no Linear tools.
 */

/** No free resident tasks and no model keys: off, an @mention is refused by the meter. */
const AGENT_OFF = { RESIDENT_TASK_LIMIT: '0', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' }

/** Stands in for PostHog: answers 202 and remembers what the relay forwarded. */
interface Upstream {
  origin: string
  hits: string[]
  close(): void
}

async function startUpstream(): Promise<Upstream> {
  const hits: string[] = []
  const http: HttpServer = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`)
    res.statusCode = 202
    res.end('relayed')
  })
  await new Promise((resolve) => http.listen(0, '127.0.0.1', () => resolve(undefined)))
  return {
    origin: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    hits,
    close: () => http.close(),
  }
}

interface Booted {
  server: Server
  upstream: Upstream
  owner: Client
  canvasId: string
  pageId: string
  workspaceId: string
  commentId: string
}

async function boot(env: Record<string, string>, email: string): Promise<Booted> {
  const upstream = await startUpstream()
  const server = await startServer({
    ...AGENT_OFF,
    POSTHOG_INGEST_HOST: upstream.origin,
    POSTHOG_ASSETS_HOST: upstream.origin,
    ...env,
  })
  const owner = await new Client(server).signUp(email, 'Owner')
  const canvas = await (await owner.post('/api/canvases', { name: 'Lean' })).json()
  const workspace = await (await owner.post('/api/workspaces', { name: 'Team' })).json()
  const comment = await (
    await owner.post(`/api/canvases/${canvas.id}/comments`, { pageId: canvas.pages[0].id, x: 1, y: 2, text: 'Plain' })
  ).json()
  return {
    server,
    upstream,
    owner,
    canvasId: canvas.id,
    pageId: canvas.pages[0].id,
    workspaceId: workspace.id,
    commentId: comment.id,
  }
}

/** One request per disabled route family, and the status the live handler
 *  answers it with when lean is off: a 404 there would be a route that is
 *  gone, not one that is served. */
interface DisabledRoute {
  method: string
  path: string
  served: number
}

function disabledRoutes({ canvasId, workspaceId, commentId }: Booted): DisabledRoute[] {
  const routes: [method: string, path: string, served: number][] = [
    ['POST', '/relay/e/', 202],
    ['GET', '/relay/static/array.js', 202],
    ['POST', '/stripe/webhook', 501],
    ['POST', '/webhooks/slack', 503],
    ['POST', '/webhooks/linear', 503],
    ['POST', '/local-agent/mcp/run-1', 403],
    ['POST', '/gemini-cloud/mcp/run-1', 403],
    ['GET', '/api/live-activities/config', 200],
    ['GET', '/api/community', 200],
    ['GET', '/api/automations', 200],
    ['GET', '/api/integrations', 200],
    ['GET', '/api/integrations/linear/callback', 302],
    ['GET', '/api/model-account', 200],
    ['GET', '/api/model-account/models', 400],
    ['PATCH', '/api/model-account/openai', 400],
    ['DELETE', '/api/model-account/openai', 400],
    ['POST', '/api/model-account/chatgpt/authorize', 200],
    ['DELETE', '/api/model-account/chatgpt/device', 200],
    ['GET', '/api/agent-runners', 200],
    ['PUT', '/api/agent-runners/default', 400],
    ['GET', '/api/agent-allowance', 200],
    ['GET', '/api/local-agent', 200],
    ['GET', '/api/image-model', 200],
    ['PUT', '/api/image-model', 400],
    ['GET', '/api/billing/plans', 200],
    ['GET', '/api/github/app', 200],
    ['GET', `/api/canvases/${canvasId}/github`, 200],
    ['POST', `/api/canvases/${canvasId}/cards`, 400],
    ['PUT', `/api/canvases/${canvasId}/publish`, 400],
    ['DELETE', `/api/canvases/${canvasId}/publish`, 200],
    ['POST', '/api/tasks/task-1/feedback', 404],
    ['POST', '/api/feedback/fb-1/retry', 404],
    ['POST', `/api/comments/${commentId}/retry`, 403],
    ['POST', `/api/workspaces/${workspaceId}/billing/checkout`, 400],
    ['POST', `/api/workspaces/${workspaceId}/billing/portal`, 400],
    ['POST', `/api/workspaces/${workspaceId}/billing/sync`, 200],
  ]
  return routes.map(([method, path, served]) => ({ method, path, served }))
}

function send(b: Booted, { method, path }: DisabledRoute) {
  return b.owner.req(path, { method, body: method === 'GET' ? undefined : '{}' })
}

interface McpResult {
  tools?: { name: string; description?: string }[]
  instructions?: string
  content?: { text: string }[]
}

async function mcp(server: Server, secret: string, method: string, params?: Record<string, unknown>) {
  const res = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return (await res.json()) as { result?: McpResult }
}

async function agentKey(b: Booted): Promise<string> {
  const { secret } = (await (await b.owner.post('/api/agent-keys', { name: 'all' })).json()) as { secret: string }
  return secret
}

async function toolNames(b: Booted): Promise<string[]> {
  return ((await mcp(b.server, await agentKey(b), 'tools/list')).result?.tools ?? []).map((t) => t.name)
}

/** Every text an MCP agent reads about comment replies: the initialize
 *  instructions, the get_guide playbook and reply_to_comment's description. */
async function commentReplyTexts(b: Booted): Promise<string[]> {
  const secret = await agentKey(b)
  const init = await mcp(b.server, secret, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'lean-test', version: '1' },
  })
  const guide = await mcp(b.server, secret, 'tools/call', {
    name: 'get_guide',
    arguments: { topic: 'doop-instructions' },
  })
  const tools = (await mcp(b.server, secret, 'tools/list')).result?.tools ?? []
  return [
    init.result?.instructions ?? '',
    guide.result?.content?.[0]?.text ?? '',
    tools.find((t) => t.name === 'reply_to_comment')?.description ?? '',
  ]
}

/** "meter" as a word, not inside "parameter". */
const METER = /\bmeter/i

const LINEAR_TOOLS = ['list_linear_issues', 'get_linear_issue']

describe('lean mode on', () => {
  let b: Booted

  beforeAll(async () => {
    b = await boot({ DOOP_LEAN: '1' }, 'lean-owner@test.dev')
  }, 70_000)

  afterAll(() => {
    b?.server.stop()
    b?.upstream.close()
  })

  it('answers every disabled route family as a route that does not exist', async () => {
    for (const route of disabledRoutes(b)) {
      const { method, path } = route
      const res = await send(b, route)
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 })
      expect(await res.text()).toContain(`Cannot ${method} ${path}`)
    }
  })

  it('forwards nothing to PostHog', () => {
    expect(b.upstream.hits).toEqual([])
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
    expect(await (await fresh.get('/api/canvases')).json()).toEqual([])
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

  it('never tells an MCP agent that an @mention reply is metered', async () => {
    const texts = await commentReplyTexts(b)
    for (const text of texts) expect(text).not.toHaveLength(0)
    for (const text of texts) expect(text).not.toMatch(METER)
  })
})

describe('lean mode off', () => {
  let b: Booted

  beforeAll(async () => {
    b = await boot({ DOOP_LEAN: '' }, 'full-owner@test.dev')
  }, 70_000)

  afterAll(() => {
    b?.server.stop()
    b?.upstream.close()
  })

  it('serves every route family lean mode disables, each with its own handler', async () => {
    for (const route of disabledRoutes(b)) {
      const { method, path, served } = route
      const res = await send(b, route)
      expect(await res.text(), `${method} ${path}`).not.toContain(`Cannot ${method}`)
      expect({ method, path, status: res.status }).toEqual({ method, path, status: served })
    }
  })

  it('forwards the analytics relay to PostHog, ingestion and assets alike', () => {
    expect(b.upstream.hits).toEqual(['POST /e/', 'GET /static/array.js'])
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

  it('creates the first canvas at sign-up and lands the new account on it', async () => {
    const fresh = await new Client(b.server).signUp('full-fresh@test.dev', 'Fresh')
    const canvases = (await (await fresh.get('/api/canvases')).json()) as { id: string; name: string }[]
    expect(canvases.map((c) => c.name)).toEqual(["Fresh's first canvas"])
    const landing = await fresh.get('/api/welcome')
    expect(landing.status).toBe(302)
    expect(landing.headers.get('location')).toBe(`/c/${canvases[0]!.id}`)
  })

  it('lists the Linear tools to an unlimited agent key', async () => {
    const names = await toolNames(b)
    for (const tool of LINEAR_TOOLS) expect(names).toContain(tool)
  })

  it('tells MCP agents that an @mention reply is metered', async () => {
    for (const text of await commentReplyTexts(b)) expect(text).toMatch(METER)
  })
})
