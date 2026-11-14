import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * DOOP_LEAN=1 end to end, beside the same server with lean off: the disabled
 * features' routes answer as routes that do not exist, everything kept still
 * works, and MCP agents get no Linear tools.
 */

/** No free resident tasks and no model keys: with lean off, the meter refuses an @mention. */
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

/** One request per disabled route family. With lean off each is served by its
 *  own handler, whose status depends on the environment's keys and the
 *  request, so only Express's own "Cannot METHOD path" counts as not served. */
interface DisabledRoute {
  method: string
  path: string
}

function disabledRoutes({ canvasId, workspaceId, commentId }: Booted): DisabledRoute[] {
  const routes: [method: string, path: string][] = [
    ['POST', '/relay/e/'],
    ['GET', '/relay/static/array.js'],
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
    ['PATCH', '/api/model-account/openai'],
    ['DELETE', '/api/model-account/openai'],
    ['POST', '/api/model-account/chatgpt/authorize'],
    ['DELETE', '/api/model-account/chatgpt/device'],
    ['GET', '/api/agent-runners'],
    ['PUT', '/api/agent-runners/default'],
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
    ['POST', '/api/feedback/fb-1/retry'],
    ['POST', `/api/comments/${commentId}/retry`],
    ['POST', `/api/workspaces/${workspaceId}/billing/checkout`],
    ['POST', `/api/workspaces/${workspaceId}/billing/portal`],
    ['POST', `/api/workspaces/${workspaceId}/billing/sync`],
  ]
  return routes.map(([method, path]) => ({ method, path }))
}

function send(b: Booted, { method, path }: DisabledRoute) {
  return b.owner.req(path, { method, body: method === 'GET' ? undefined : '{}' })
}

/** The analytics relay's ingestion and asset requests, in order, so a test owns the upstream hits it asserts. */
async function sendRelay(b: Booted) {
  for (const route of disabledRoutes(b).filter((r) => r.path.startsWith('/relay/'))) await send(b, route)
}

interface McpResult {
  tools?: { name: string; description?: string }[]
  instructions?: string
  content?: { text: string }[]
  isError?: boolean
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

const LINEAR_TOOLS = ['list_linear_issues', 'get_linear_issue']

/** The guide an MCP client is handed at `initialize`. */
async function guide(b: Booted): Promise<string> {
  const init = await mcp(b.server, await agentKey(b), 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'lean-test', version: '1.0.0' },
  })
  return init.result?.instructions ?? ''
}

/** Guide lines about features lean mode turns off: the Linear extension, resident @mentions. */
const LEAN_DROPPED_GUIDE = ['- Linear:', 'A reply that @mentions a resident role']

/** The full playbook `get_guide` serves. */
async function fullGuide(b: Booted): Promise<string> {
  const res = await mcp(b.server, await agentKey(b), 'tools/call', {
    name: 'get_guide',
    arguments: { topic: 'doop-instructions' },
  })
  return res.result?.content?.[0]?.text ?? ''
}

async function toolDescription(b: Booted, name: string): Promise<string> {
  const tools = (await mcp(b.server, await agentKey(b), 'tools/list')).result?.tools ?? []
  return tools.find((t) => t.name === name)?.description ?? ''
}

/** A human reply to a task an MCP agent opened, sent the way the canvas UI sends it. */
async function replyToAgentTask(b: Booted) {
  await mcp(b.server, await agentKey(b), 'tools/call', {
    name: 'set_status',
    arguments: { canvas_id: b.canvasId, status: 'Working', agent_name: 'Lean Bot' },
  })
  const canvases = (await (await b.owner.get('/api/canvases')).json()) as {
    id: string
    activeTasks?: { id: string }[]
  }[]
  const task = canvases.find((c) => c.id === b.canvasId)?.activeTasks?.[0]
  return b.owner.post(`/api/tasks/${task?.id}/feedback`, { text: 'warmer accent' })
}

/** A fresh open thread on the canvas, so a test never replies into one another test resolved. */
async function openThread(b: Booted, text: string) {
  return b.owner.post(`/api/canvases/${b.canvasId}/comments`, { pageId: b.pageId, x: 3, y: 4, text })
}

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

  it('leaves the core routes to their own handlers', async () => {
    const core: [method: string, path: string][] = [
      ['GET', '/healthz'],
      ['GET', '/a/missing.png'],
      ['PUT', '/u/no-such-ticket'],
      ['GET', `/api/canvases/${b.canvasId}`],
      ['GET', '/.well-known/oauth-protected-resource'],
    ]
    for (const [method, path] of core) {
      const res = await b.owner.req(path, { method, body: method === 'GET' ? undefined : '{}' })
      expect(await res.text(), `${method} ${path}`).not.toContain(`Cannot ${method} ${path}`)
    }
  })

  it('forwards nothing to PostHog', async () => {
    await sendRelay(b)
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

  /* AGENT_OFF leaves no free task and no key: a metered mention is refused, so a 200 never met the meter */
  it('takes an @Doop comment, reply or agent reply as a plain comment, unmetered and queued for nobody', async () => {
    const comment = await openThread(b, '@Doop tighten the hero')
    expect(comment.status).toBe(200)
    const root = await comment.json()
    expect(root.forAgent).toBeUndefined()

    const reply = await b.owner.post(`/api/comments/${root.id}/replies`, { text: '@Doop and the footer' })
    expect(reply.status).toBe(200)
    expect((await reply.json()).forAgent).toBeUndefined()

    const agentReply = await mcp(b.server, await agentKey(b), 'tools/call', {
      name: 'reply_to_comment',
      arguments: { canvas_id: b.canvasId, comment_id: root.id, text: 'Over to @Doop', agent_name: 'Lean Bot' },
    })
    expect(agentReply.result?.isError).toBeFalsy()
    expect(JSON.parse(agentReply.result?.content?.[0]?.text ?? '{}').forAgent).toBeUndefined()
  })

  it('leaves turned-off features out of the MCP guide, and keeps the comment tools', async () => {
    const text = await guide(b)
    expect(text).toContain('- Comments: call get_comments')
    for (const line of LEAN_DROPPED_GUIDE) expect(text).not.toContain(line)
  })

  it('lists no Linear tools to an unlimited agent key, and keeps the design tools', async () => {
    const names = await toolNames(b)
    for (const tool of LINEAR_TOOLS) expect(names).not.toContain(tool)
    for (const tool of ['create_canvas', 'reply_to_comment', 'resolve_comment', 'generate_image', 'upload_asset'])
      expect(names).toContain(tool)
  })

  it('gives MCP agents the @Doop comments and leaves out the in-app agent, board cards and metering', async () => {
    const text = await fullGuide(b)
    expect(text).toContain('## Who answers comments')
    expect(text).not.toContain('## The Doop Agent')
    expect(text).not.toContain('Humans queue board cards')
    expect(text).not.toContain('Writing is metered')
    expect(text).toContain('Humans reply to your tasks')
    const description = await toolDescription(b, 'reply_to_comment')
    expect(description).toContain('MCP agents like you own those requests')
    expect(description).not.toContain('meter')
  })

  it('carries a human reply to an agent task, unmetered', async () => {
    expect((await replyToAgentTask(b)).status).toBe(200)
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
      const { method, path } = route
      const res = await send(b, route)
      expect(await res.text(), `${method} ${path}`).not.toContain(`Cannot ${method} ${path}`)
    }
  })

  it('forwards the analytics relay to PostHog, ingestion and assets alike', async () => {
    b.upstream.hits.length = 0
    await sendRelay(b)
    expect(b.upstream.hits).toEqual(['POST /e/', 'GET /static/array.js'])
  })

  it('says lean is off in the locale config', async () => {
    const res = await new Client(b.server).get('/api/locale-config')
    expect(await res.json()).toEqual({ defaultLocale: 'en', lean: false })
  })

  it('meters an @Doop comment as a command to the in-app agent, refusing it with no task left', async () => {
    const res = await openThread(b, '@Doop tighten the hero')
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('resident_limit')
  })

  it('describes Linear, task feedback and resident @mentions in the MCP guide', async () => {
    const text = await guide(b)
    for (const line of LEAN_DROPPED_GUIDE) expect(text).toContain(line)
  })

  it('lists the Linear tools to an unlimited agent key', async () => {
    const names = await toolNames(b)
    for (const tool of LINEAR_TOOLS) expect(names).toContain(tool)
  })

  it('describes the in-app agent, board cards and metering in the guide and reply_to_comment', async () => {
    const text = await fullGuide(b)
    expect(text).toContain('## The Doop Agent')
    expect(text).toContain('Writing is metered')
    expect(text).not.toContain('## Who answers comments')
    expect(await toolDescription(b, 'reply_to_comment')).toContain('against the account’s meter')
  })

  it('meters a human reply to an agent task, refusing it with no task left', async () => {
    const res = await replyToAgentTask(b)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('resident_limit')
  })
})
