import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { COMMENT_SCOPE_TOOLS } from '../server/mcp.ts'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Agent keys limited to chosen workspaces, against the real server: the REST
 * surface that mints them, and every /mcp tool that takes a canvas, frame or
 * comment id answering a canvas outside the limit exactly as it answers an id
 * that does not exist.
 */

/* The server is a child process, so a test cannot stub its fetch. This module
   is preloaded into it (NODE_OPTIONS --import) and answers the search tools'
   upstreams with fixed bodies, so a limited key's answer on another
   workspace's canvas is compared with a made-up id's without the live web.
   Hosts it does not know go through to the real fetch. */
const STUB_UPSTREAMS = `
const realFetch = globalThis.fetch
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const gone = () => new Response('', { status: 404 })
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  switch (url.hostname) {
    case 'api.iconify.design':
      return url.pathname.endsWith('/search') ? json({ icons: ['stub:arrow-right', 'stub:arrow-left'] }) : gone()
    case 'api.pexels.com':
      return json({ photos: [{ src: { large: 'https://images.pexels.com/l.jpg', tiny: 'https://images.pexels.com/t.jpg' }, alt: 'office', photographer: 'Stub', width: 4, height: 3, avg_color: '#000000' }] })
    case 'api.onepagelove.com':
      return json({ results: { items: [{ title: 'Stub Site', slug: 'stub-site', url: 'https://stub.example', screenshot: { hero: 'https://assets.onepagelove.com/h.png' } }] } })
    case 'icons.duckduckgo.com':
    case 'images.pexels.com':
    case 'assets.onepagelove.com':
      return gone()
    default:
      return realFetch(input, init)
  }
}
`
const withStubbedUpstreams = () =>
  `${process.env.NODE_OPTIONS ?? ''} --import=data:text/javascript,${encodeURIComponent(STUB_UPSTREAMS)}`.trim()

let server: Server
let owner: Client
let stranger: Client
let wsA: string
let wsB: string
let wsStranger: string

beforeAll(async () => {
  /* a resident allowance lets the owner leave task feedback; no model keys, so no resident run takes it */
  server = await startServer({
    RESIDENT_TASK_LIMIT: '5',
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    /* keys so search_images and search_inspiration run (upstreams stubbed); room for the searches below.
       No Brandfetch id, so search_logos stays on the stubbed DuckDuckGo and Iconify hosts whatever the shell sets */
    PEXELS_API_KEY: 'stub',
    ONEPAGELOVE_API_KEY: 'stub',
    BRANDFETCH_CLIENT_ID: '',
    MCP_SEARCHES_PER_MIN: '1000',
    NODE_OPTIONS: withStubbedUpstreams(),
  })
  owner = await new Client(server).signUp('limit-owner@test.dev', 'Limit Owner')
  stranger = await new Client(server).signUp('limit-stranger@test.dev', 'Limit Stranger')
  wsA = (await (await owner.post('/api/workspaces', { name: 'Alpha' })).json()).id
  wsB = (await (await owner.post('/api/workspaces', { name: 'Beta' })).json()).id
  wsStranger = (await (await stranger.post('/api/workspaces', { name: 'Elsewhere' })).json()).id
}, 70_000)

afterAll(() => server?.stop())

describe('minting a limited key', () => {
  it('lists the workspaces a key is limited to, and null for an unlimited one', async () => {
    const limited = await owner.post('/api/agent-keys', { name: 'only-a', workspaceIds: [wsA, wsA] })
    expect(limited.status).toBe(200)
    expect((await limited.json()).workspaces).toEqual([{ id: wsA, name: 'Alpha' }])
    await owner.post('/api/agent-keys', { name: 'everywhere' })
    const listed = (await (await owner.get('/api/agent-keys')).json()) as { name: string; workspaces: unknown }[]
    expect(listed.find((k) => k.name === 'only-a')?.workspaces).toEqual([{ id: wsA, name: 'Alpha' }])
    expect(listed.find((k) => k.name === 'everywhere')?.workspaces).toBeNull()
  })

  it.each([
    ['an empty list', () => []],
    ['an unknown workspace', () => ['no-such-workspace']],
    ['a workspace the caller is not a member of', () => [wsStranger]],
    ['something that is not a list of ids', () => 'everything'],
  ])('refuses %s', async (_label, workspaceIds) => {
    const res = await owner.post('/api/agent-keys', { name: 'bad', workspaceIds: workspaceIds() })
    expect(res.status).toBe(400)
    const listed = (await (await owner.get('/api/agent-keys')).json()) as { name: string }[]
    expect(listed.some((k) => k.name === 'bad')).toBe(false)
  })

  it('refuses a field it does not know, so a misspelled limit never mints an unlimited key', async () => {
    const res = await owner.post('/api/agent-keys', { name: 'typo', workspace_ids: [wsA] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('workspace_ids')
    const listed = (await (await owner.get('/api/agent-keys')).json()) as { name: string }[]
    expect(listed.some((k) => k.name === 'typo')).toBe(false)
  })

  it('answers an unknown workspace and a stranger’s workspace the same way', async () => {
    const unknown = await (await owner.post('/api/agent-keys', { name: 'bad', workspaceIds: ['ws-x'] })).json()
    const foreign = await (await owner.post('/api/agent-keys', { name: 'bad', workspaceIds: [wsStranger] })).json()
    expect(foreign.error.replace(wsStranger, '<id>')).toBe(unknown.error.replace('ws-x', '<id>'))
  })
})

/** One stateless `tools/call` with an agent key, parsed to the tool result. */
async function callTool(secret: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  const body = (await res.json()) as { result?: { isError?: boolean; content: { text?: string }[] } }
  const text = (body.result?.content ?? []).map((c) => c.text ?? '').join('\n')
  return { isError: body.result?.isError ?? false, text }
}

const mint = async (body: Record<string, unknown>) =>
  ((await (await owner.post('/api/agent-keys', body)).json()) as { secret: string }).secret

/** A canvas with one frame and one canvas comment, made by `who`. */
async function seedCanvas(who: Client, name: string, workspaceId?: string) {
  const canvas = await (await who.post('/api/canvases', { name, workspaceId })).json()
  const frame = await (await who.post(`/api/canvases/${canvas.id}/frames`, { name: `${name} frame` })).json()
  const pageId = canvas.pages?.[0]?.id ?? `${canvas.id}:page1`
  const comment = await (
    await who.post(`/api/canvases/${canvas.id}/comments`, { pageId, x: 10, y: 10, text: `${name} note` })
  ).json()
  return { canvasId: canvas.id as string, frameId: frame.id as string, commentId: comment.id as string }
}

type Target = {
  canvasId: string
  frameId: string
  commentId: string
  /** an earlier version of the frame, for restore_frame_version */
  versionId: string
  /** a pinned style reference, for get_reference */
  referenceId: string
  /** the canvas's pages as get_canvas lists them, for set_canvas_pages */
  pages: { id: string; name: string }[]
}

/** Gives a seeded canvas what the id-taking tools need to succeed on it: a
 *  frame with a history, a pinned reference, a guide and its page list. `secret` is a
 *  key that reaches the canvas. */
async function withToolInputs(who: Client, secret: string, seeded: Awaited<ReturnType<typeof seedCanvas>>) {
  const bot = { agent_name: 'Seeder' }
  await callTool(secret, 'set_guidelines', { canvas_id: seeded.canvasId, name: 'brand', markdown: '# Seed', ...bot })
  await callTool(secret, 'set_frame_html', { frame_id: seeded.frameId, html: '<p>first</p>', ...bot })
  await callTool(secret, 'set_frame_html', { frame_id: seeded.frameId, html: '<p>second</p>', ...bot })
  const versions = JSON.parse((await callTool(secret, 'list_frame_versions', { frame_id: seeded.frameId })).text) as {
    versions: { id: string }[]
  }
  const reference = await (
    await who.post(`/api/canvases/${seeded.canvasId}/references`, { frameId: seeded.frameId })
  ).json()
  const canvas = await (await who.get(`/api/canvases/${seeded.canvasId}`)).json()
  const target: Target = {
    ...seeded,
    versionId: versions.versions[0]!.id,
    referenceId: reference.id,
    pages: canvas.pages.map((p: { id: string; name: string }) => ({ id: p.id, name: p.name })),
  }
  return target
}

describe('a key limited to one workspace over /mcp', () => {
  let a: Target
  let b: Target
  let personal: Target
  let linked: Target
  let limitedFull: string
  let limitedComment: string
  let unlimited: string

  beforeAll(async () => {
    limitedFull = await mint({ name: 'a-full', workspaceIds: [wsA] })
    limitedComment = await mint({ name: 'a-comment', scope: 'comment', workspaceIds: [wsA] })
    unlimited = await mint({ name: 'all' })
    a = await withToolInputs(owner, unlimited, await seedCanvas(owner, 'In A', wsA))
    b = await withToolInputs(owner, unlimited, await seedCanvas(owner, 'In B', wsB))
    personal = await withToolInputs(owner, unlimited, await seedCanvas(owner, 'Personal'))
    const byLink = await seedCanvas(stranger, 'By link')
    await stranger.patch(`/api/canvases/${byLink.canvasId}`, { linkAccess: 'edit' })
    linked = await withToolInputs(owner, unlimited, byLink)
    /* open human feedback on B, addressed to any agent: a call that reached
       B would claim it or announce it */
    await callTool(unlimited, 'set_status', { canvas_id: b.canvasId, status: 'Seeded B', agent_name: 'Seeder' })
    const task = await activeTask(b.canvasId, 'Seeder')
    expect((await owner.post(`/api/tasks/${task?.id}/feedback`, { text: 'warmer accent' })).status).toBe(200)
  })

  const activeTask = async (canvasId: string, agentName: string) => {
    const canvases = (await (await owner.get('/api/canvases')).json()) as {
      id: string
      activeTasks: { id: string; agentName: string; status: string }[]
    }[]
    return canvases.find((c) => c.id === canvasId)?.activeTasks.find((t) => t.agentName === agentName)
  }

  const listed = async (secret: string) =>
    (JSON.parse((await callTool(secret, 'list_canvases', {})).text) as { id: string; name: string }[]).map(
      (c) => c.name,
    )

  it('lists only the canvases in its workspaces', async () => {
    const outside = ['In B', 'Personal', "Limit's first canvas", 'By link']
    for (const key of [limitedFull, limitedComment]) {
      const names = await listed(key)
      expect(names).toContain('In A')
      for (const name of outside) expect(names).not.toContain(name)
    }
    const all = await listed(unlimited)
    expect(all).toEqual(expect.arrayContaining(['In A', 'In B', 'Personal', "Limit's first canvas"]))
    /* listing covers own, shared and workspace canvases; one open only by link is never listed, limit or not */
    expect(all).not.toContain('By link')
  })

  const bot = { agent_name: 'Limit Bot' }
  /* every tool that takes a canvas, frame or comment id, with arguments that
     succeed on a canvas the key may reach (the positive control below runs
     them there), so a refusal on another workspace's canvas is the gate's */
  const toolCalls: [string, (t: Target) => Record<string, unknown>][] = [
    ['get_canvas', (t) => ({ canvas_id: t.canvasId, ...bot })],
    ['list_guidelines', (t) => ({ canvas_id: t.canvasId })],
    ['get_guidelines', (t) => ({ canvas_id: t.canvasId, name: 'brand' })],
    ['set_guidelines', (t) => ({ canvas_id: t.canvasId, name: 'brand', markdown: '# Brand', ...bot })],
    ['get_tokens', (t) => ({ canvas_id: t.canvasId })],
    [
      'create_tokens',
      (t) => ({ canvas_id: t.canvasId, tokens: [{ name: '--x', type: 'color', value: '#000' }], ...bot }),
    ],
    ['set_tokens', (t) => ({ canvas_id: t.canvasId, tokens: [{ name: '--x', value: '#fff' }], ...bot })],
    ['set_token_themes', (t) => ({ canvas_id: t.canvasId, themes: ['dark'], ...bot })],
    ['get_reference', (t) => ({ canvas_id: t.canvasId, reference_id: t.referenceId })],
    ['save_decision', (t) => ({ canvas_id: t.canvasId, decision: 'rounder corners', ...bot })],
    ['set_status', (t) => ({ canvas_id: t.canvasId, status: 'Working', ...bot })],
    ['get_comments', (t) => ({ canvas_id: t.canvasId })],
    ['reply_to_comment', (t) => ({ canvas_id: t.canvasId, comment_id: t.commentId, text: 'On it', ...bot })],
    ['resolve_comment', (t) => ({ canvas_id: t.canvasId, comment_id: t.commentId, ...bot })],
    ['get_feedback', (t) => ({ canvas_id: t.canvasId, ...bot })],
    ['report_issue', (t) => ({ category: 'bug', message: 'x', canvas_id: t.canvasId, ...bot })],
    ['share_feedback', (t) => ({ category: 'idea', message: 'x', canvas_id: t.canvasId, ...bot })],
    [
      'set_canvas_pages',
      (t) => ({
        canvas_id: t.canvasId,
        expectedPages: t.pages,
        pages: t.pages.map((p) => ({ ...p, name: 'Renamed' })),
        ...bot,
      }),
    ],
    ['create_canvas_page', (t) => ({ canvas_id: t.canvasId, name: 'Second', ...bot })],
    ['set_page_background', (t) => ({ canvas_id: t.canvasId, color: '#111111', ...bot })],
    ['get_prototype', (t) => ({ canvas_id: t.canvasId, ...bot })],
    ['set_prototype_start', (t) => ({ canvas_id: t.canvasId, frame_id: t.frameId, ...bot })],
    ['create_frame', (t) => ({ canvas_id: t.canvasId, name: 'New', html: '<p>x</p>', ...bot })],
    ['upload_asset', (t) => ({ canvas_id: t.canvasId, local_file: true, ...bot })],
    ['generate_image', (t) => ({ canvas_id: t.canvasId, prompt: 'a cat', ...bot })],
    ['import_webpage', (t) => ({ canvas_id: t.canvasId, url: 'example.com', ...bot })],
    ['get_frame', (t) => ({ frame_id: t.frameId, ...bot })],
    ['set_frame_html', (t) => ({ frame_id: t.frameId, html: '<p>x</p>', ...bot })],
    ['append_frame_html', (t) => ({ frame_id: t.frameId, html_chunk: '<p>x</p>', start: true, ...bot })],
    ['edit_frame_html', (t) => ({ frame_id: t.frameId, old_str: 'second', new_str: 'edited', ...bot })],
    ['update_frame', (t) => ({ frame_id: t.frameId, name: 'Renamed', ...bot })],
    ['export_frame', (t) => ({ frame_id: t.frameId })],
    ['export_frame', (t) => ({ frame_id: t.frameId, format: 'pdf' })],
    ['get_frame_screenshot', (t) => ({ frame_id: t.frameId, ...bot })],
    ['list_frame_versions', (t) => ({ frame_id: t.frameId, ...bot })],
    ['restore_frame_version', (t) => ({ frame_id: t.frameId, version_id: t.versionId, ...bot })],
    ['delete_frame', (t) => ({ frame_id: t.frameId, ...bot })],
  ]
  const madeUp: Target = {
    canvasId: 'zz-no-canvas',
    frameId: 'zz-no-frame',
    commentId: 'zz-no-comment',
    versionId: 'zz-no-version',
    referenceId: 'zz-no-reference',
    pages: [{ id: 'zz-no-page', name: 'No page' }],
  }
  const masked = (text: string, t: Target) =>
    t.pages
      .reduce((out, p) => out.replaceAll(p.id, '<page>'), text)
      .replaceAll(t.canvasId, '<canvas>')
      .replaceAll(t.frameId, '<frame>')
      .replaceAll(t.commentId, '<comment>')
      .replaceAll(t.versionId, '<version>')
      .replaceAll(t.referenceId, '<reference>')

  /* tools whose canvas_id is optional and only lets human feedback reach the agent */
  const optionalCanvasCalls: [string, Record<string, unknown>][] = [
    ['search_inspiration', { query: 'saas landing page' }],
    ['search_images', { query: 'office' }],
    ['list_backgrounds', { count: 1 }],
    ['search_icons', { query: 'arrow right', limit: 1 }],
    ['search_logos', { query: 'example.com', count: 1 }],
  ]

  /* a comment key refuses a tool outside COMMENT_SCOPE_TOOLS before its handler
     runs, the same for every id, so only the tools it may call say anything
     about the limit */
  const rowsFor = (scope: string) =>
    toolCalls
      .map(([tool, args], i) => [`${tool} #${i}`, tool, args] as const)
      .filter(([, tool]) => scope === 'full' || COMMENT_SCOPE_TOOLS.has(tool))

  describe.each([
    ['full', () => limitedFull],
    ['comment', () => limitedComment],
  ])('with %s scope', (scope, key) => {
    it.each(rowsFor(scope))(
      '%s answers a canvas in another workspace as it answers a made-up id',
      async (_label, tool, args) => {
        const outside = await callTool(key(), tool, args(b))
        const missing = await callTool(key(), tool, args(madeUp))
        expect(outside.isError).toBe(true)
        expect(masked(outside.text, b)).toBe(masked(missing.text, madeUp))
      },
    )

    it.each([
      ['personal', () => personal],
      ['shared by link', () => linked],
    ])('answers a %s canvas as it answers a made-up id', async (_label, target) => {
      for (const [tool, args] of toolCalls.filter(([tool]) => tool === 'get_canvas' || tool === 'get_frame')) {
        const outside = await callTool(key(), tool, args(target()))
        const missing = await callTool(key(), tool, args(madeUp))
        expect(masked(outside.text, target())).toBe(masked(missing.text, madeUp))
      }
    })

    /* none of these is a comment-scope tool: that key's refusal of them is
       asserted below, and says nothing about the limit */
    if (scope === 'full')
      it.each(optionalCanvasCalls)(
        '%s with a canvas in another workspace answers as with a made-up id',
        async (tool, args) => {
          const outside = await callTool(key(), tool, { ...args, canvas_id: b.canvasId, ...bot })
          const missing = await callTool(key(), tool, { ...args, canvas_id: madeUp.canvasId, ...bot })
          expect(outside.isError).toBe(false)
          expect(outside.text).not.toContain('HUMAN FEEDBACK')
          expect(masked(outside.text, b)).toBe(masked(missing.text, madeUp))
        },
      )
  })

  it('has comment-scope rows to run, and a comment key refuses every other tool as outside its scope', async () => {
    expect(rowsFor('comment').length).toBeGreaterThan(0)
    expect(rowsFor('comment').length).toBeLessThan(rowsFor('full').length)
    const others = [
      ...toolCalls.filter(([tool]) => !COMMENT_SCOPE_TOOLS.has(tool)).map(([tool, args]) => [tool, args(a)] as const),
      ...optionalCanvasCalls.map(([tool, args]) => [tool, { ...args, canvas_id: a.canvasId, ...bot }] as const),
    ]
    expect(others.length).toBeGreaterThan(0)
    for (const [tool, args] of others) {
      const res = await callTool(limitedComment, tool, args)
      expect(res.isError, tool).toBe(true)
      expect(res.text, tool).toContain('limited to reading and comments')
    }
  }, 30_000)

  /* calls that cannot finish inside the test rig (no image model, no network,
     no Chrome): on a canvas the key reaches they still answer something other
     than a missing canvas, which is as far as the control can go */
  const needsOutsideWorld = (tool: string, args: Record<string, unknown>) =>
    ['generate_image', 'import_webpage', 'get_frame_screenshot'].includes(tool) || args.format === 'pdf'

  it.each(toolCalls.map(([tool, args], i) => [`${tool} #${i}`, tool, args] as const))(
    'positive control: %s with valid arguments works on a canvas in its workspace',
    async (_label, tool, args) => {
      /* a canvas of its own, since several tools change the pages, frames and versions the others read */
      const own = await withToolInputs(owner, unlimited, await seedCanvas(owner, `Control ${tool}`, wsA))
      const call = args(own)
      const inside = await callTool(limitedFull, tool, call)
      const missing = await callTool(limitedFull, tool, args(madeUp))
      expect(masked(inside.text, own)).not.toBe(masked(missing.text, madeUp))
      if (!needsOutsideWorld(tool, call)) expect(inside, inside.text).toMatchObject({ isError: false })
    },
    /* seeds a canvas (about ten requests) and some rows drive Chromium or the network */
    30_000,
  )

  /* a value only STUB_UPSTREAMS produces, so a preload that failed to load (the
     tools then answer from the live web) fails here; list_backgrounds is local
     and carries none */
  const stubMarkers: Record<string, string | null> = {
    search_inspiration: 'Stub Site',
    search_images: 'images.pexels.com/l.jpg',
    list_backgrounds: null,
    search_icons: 'stub:arrow-right',
    search_logos: 'stub:arrow-right',
  }

  it.each(optionalCanvasCalls)(
    'announces feedback on a canvas it may reach, so the %s probe can tell',
    async (tool, args) => {
      const res = await callTool(unlimited, tool, { ...args, canvas_id: b.canvasId, ...bot })
      expect(res.isError, res.text).toBe(false)
      expect(res.text).toContain('HUMAN FEEDBACK')
      const marker = stubMarkers[tool]
      if (marker) expect(res.text, `${tool} should answer from the stubbed upstream`).toContain(marker)
    },
  )

  it('has a stub marker entry for every optional-canvas tool', () => {
    expect(Object.keys(stubMarkers).sort()).toEqual(optionalCanvasCalls.map(([tool]) => tool).sort())
  })

  /* a canvas the key may reach, carrying an id that belongs to B */
  const crossIdCalls: [string, (t: Target) => Record<string, unknown>][] = [
    ['reply_to_comment', toolCalls.find(([t]) => t === 'reply_to_comment')![1]],
    ['resolve_comment', toolCalls.find(([t]) => t === 'resolve_comment')![1]],
    ['get_comments', (t) => ({ canvas_id: t.canvasId, frame_id: t.frameId })],
    ['set_prototype_start', (t) => ({ canvas_id: t.canvasId, frame_id: t.frameId, ...bot })],
    ['export_frame', (t) => ({ frame_id: a.frameId, frame_ids: [t.frameId], format: 'pdf' })],
  ]
  it.each([
    ['full', () => limitedFull],
    ['comment', () => limitedComment],
  ])(
    'answers a comment or frame from another workspace on its own canvas as a made-up id (%s scope)',
    async (scope, key) => {
      const onA = (t: Target) => ({ ...t, canvasId: a.canvasId })
      for (const [tool, args] of crossIdCalls.filter(([tool]) => scope === 'full' || COMMENT_SCOPE_TOOLS.has(tool))) {
        const outside = await callTool(key(), tool, args(onA(b)))
        const missing = await callTool(key(), tool, args(onA(madeUp)))
        expect(outside.isError).toBe(true)
        expect(masked(outside.text, b)).toBe(masked(missing.text, madeUp))
      }
    },
    30_000,
  )

  it('leaves no trace on a canvas outside its limit', async () => {
    /* try every tool on B first, so the check holds whatever ran before it */
    for (const key of [limitedFull, limitedComment]) {
      for (const [tool, args] of toolCalls) await callTool(key, tool, args(b))
      for (const [tool, args] of optionalCanvasCalls) {
        await callTool(key, tool, { ...args, canvas_id: b.canvasId, ...bot })
      }
    }
    const canvas = (await (await owner.get(`/api/canvases/${b.canvasId}`)).json()) as {
      frames: { id: string; name: string }[]
    }
    expect(canvas.frames.map((f) => [f.id, f.name])).toEqual([[b.frameId, 'In B frame']])
    expect((await activeTask(b.canvasId, 'Seeder'))?.status).toBe('Seeded B')
    expect(await activeTask(b.canvasId, bot.agent_name)).toBeUndefined()
    const comments = await callTool(unlimited, 'get_comments', { canvas_id: b.canvasId })
    expect(comments.text).toContain('In B note')
    expect(comments.text).not.toContain('On it')
    expect(comments.text).not.toContain('resolvedBy')
    /* still unclaimed: the first agent that may act on B gets it */
    const feedback = await callTool(unlimited, 'get_feedback', { canvas_id: b.canvasId, agent_name: 'Seeder' })
    expect(feedback.text).toContain('warmer accent')
  }, 60_000)

  it('still reads and comments on a canvas in its workspace', async () => {
    for (const key of [limitedFull, limitedComment]) {
      expect((await callTool(key, 'get_canvas', { canvas_id: a.canvasId, ...bot })).text).toContain('In A frame')
      expect((await callTool(key, 'get_frame', { frame_id: a.frameId, ...bot })).isError).toBe(false)
      const comments = await callTool(key, 'get_comments', { canvas_id: a.canvasId })
      expect(comments.text).toContain('In A note')
    }
    const reply = await callTool(limitedComment, 'reply_to_comment', {
      canvas_id: a.canvasId,
      comment_id: a.commentId,
      text: 'Seen',
      ...bot,
    })
    expect(reply.isError).toBe(false)
  })

  it('keeps the comment-scope refusals for a limited comment key', async () => {
    const res = await callTool(limitedComment, 'create_frame', {
      canvas_id: a.canvasId,
      name: 'x',
      html: '<p>x</p>',
      ...bot,
    })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('limited to reading and comments')
  })

  it('covers every tool that takes a canvas or frame id', async () => {
    const res = await fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${unlimited}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    const { result } = (await res.json()) as {
      result: { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] }
    }
    const takesId = result.tools
      .filter(({ inputSchema }) => ['canvas_id', 'frame_id'].some((id) => id in (inputSchema.properties ?? {})))
      .map((t) => t.name)
      .sort()
    const covered = new Set([...toolCalls, ...optionalCanvasCalls].map(([tool]) => tool))
    expect(takesId).toEqual([...covered].sort())
  })

  it('leaves an unlimited key reaching every canvas it could before', async () => {
    for (const target of [a, b, personal, linked]) {
      const res = await callTool(unlimited, 'get_canvas', { canvas_id: target.canvasId, ...bot })
      expect(res.isError).toBe(false)
    }
  })
})

describe('create_canvas with a limited key', () => {
  const created = async (secret: string, args: Record<string, unknown>) => {
    const res = await callTool(secret, 'create_canvas', { name: 'Made by agent', ...args })
    if (res.isError) return res
    const { id } = JSON.parse(res.text) as { id: string }
    const canvas = await (await owner.get(`/api/canvases/${id}`)).json()
    return { ...res, workspaceId: canvas.workspaceId as string | undefined }
  }

  it('lands in the one workspace of a single-workspace key', async () => {
    const key = await mint({ name: 'create-a', workspaceIds: [wsA] })
    expect(await created(key, {})).toMatchObject({ isError: false, workspaceId: wsA })
    expect(await created(key, { workspace_id: wsA })).toMatchObject({ isError: false, workspaceId: wsA })
  })

  it('refuses a workspace outside the limit with the unknown-workspace answer', async () => {
    const key = await mint({ name: 'create-a-only', workspaceIds: [wsA] })
    const outside = await created(key, { workspace_id: wsB })
    const unknown = await created(key, { workspace_id: 'zz-no-workspace' })
    expect(outside.isError).toBe(true)
    expect(outside.text.replace(wsB, '<id>')).toBe(unknown.text.replace('zz-no-workspace', '<id>'))
  })

  it('needs workspace_id when the key spans several workspaces, and never makes a personal canvas', async () => {
    const key = await mint({ name: 'create-ab', workspaceIds: [wsA, wsB] })
    const res = await created(key, {})
    expect(res.isError).toBe(true)
    expect(res.text).toContain('workspace_id')
    expect(await created(key, { workspace_id: wsB })).toMatchObject({ isError: false, workspaceId: wsB })
  })

  describe('after the owner leaves one of its workspaces', () => {
    let wsShared: string
    let ownerId: string
    const keyNamed = async (name: string) =>
      ((await (await owner.get('/api/agent-keys')).json()) as { name: string; workspaces: unknown }[]).find(
        (k) => k.name === name,
      )

    beforeAll(async () => {
      ownerId = (await (await owner.get('/api/me')).json()).id
      wsShared = (await (await stranger.post('/api/workspaces', { name: 'Shared' })).json()).id
      const added = await stranger.post(`/api/workspaces/${wsShared}/members`, { email: 'limit-owner@test.dev' })
      expect(added.status).toBe(200)
    })

    it('lists and defaults to the one workspace it can still reach', async () => {
      const key = await mint({ name: 'a-and-shared', workspaceIds: [wsA, wsShared] })
      const onlyShared = await mint({ name: 'only-shared', workspaceIds: [wsShared] })
      expect((await stranger.delete(`/api/workspaces/${wsShared}/members/${ownerId}`)).status).toBe(200)

      expect((await keyNamed('a-and-shared'))?.workspaces).toEqual([{ id: wsA, name: 'Alpha' }])
      expect(await created(key, {})).toMatchObject({ isError: false, workspaceId: wsA })

      expect((await keyNamed('only-shared'))?.workspaces).toEqual([])
      const none = await created(onlyShared, {})
      expect(none.isError).toBe(true)
      expect(none.text).toMatch(/no longer available/)
      expect(none.text).not.toMatch(/:\s*$/)
    })
  })

  it('still makes a personal canvas for an unlimited key', async () => {
    const key = await mint({ name: 'create-anywhere' })
    expect(await created(key, {})).toMatchObject({ isError: false, workspaceId: undefined })
  })
})

describe('a limited key whose owner leaves a listed workspace', () => {
  /* the owner also holds an invite on the other workspace's canvas, so the
     canvas stays reachable to them: only the key's limit can keep it out */
  let wsShared: string
  let ownerId: string
  let inA: Awaited<ReturnType<typeof seedCanvas>>
  let inShared: Awaited<ReturnType<typeof seedCanvas>>
  let limited: string
  let unlimited: string

  const listed = async (secret: string) =>
    (JSON.parse((await callTool(secret, 'list_canvases', {})).text) as { name: string }[]).map((c) => c.name)

  beforeAll(async () => {
    ownerId = (await (await owner.get('/api/me')).json()).id
    wsShared = (await (await stranger.post('/api/workspaces', { name: 'Left later' })).json()).id
    expect((await stranger.post(`/api/workspaces/${wsShared}/members`, { email: 'limit-owner@test.dev' })).status).toBe(
      200,
    )
    inA = await seedCanvas(owner, 'Still in A', wsA)
    inShared = await seedCanvas(stranger, 'Left behind', wsShared)
    expect(
      (await stranger.post(`/api/canvases/${inShared.canvasId}/members`, { email: 'limit-owner@test.dev' })).status,
    ).toBe(200)
    limited = await mint({ name: 'a-and-left-later', workspaceIds: [wsA, wsShared] })
    unlimited = await mint({ name: 'all-left-later' })
  })

  it('loses that workspace’s canvases, and keeps the ones in a workspace it still belongs to', async () => {
    expect(await listed(limited)).toEqual(expect.arrayContaining(['Still in A', 'Left behind']))
    expect((await callTool(limited, 'get_canvas', { canvas_id: inShared.canvasId, agent_name: 'Bot' })).isError).toBe(
      false,
    )

    expect((await stranger.delete(`/api/workspaces/${wsShared}/members/${ownerId}`)).status).toBe(200)

    const names = await listed(limited)
    expect(names).toContain('Still in A')
    expect(names).not.toContain('Left behind')
    const gone = await callTool(limited, 'get_canvas', { canvas_id: inShared.canvasId, agent_name: 'Bot' })
    const missing = await callTool(limited, 'get_canvas', { canvas_id: 'zz-no-canvas', agent_name: 'Bot' })
    expect(gone.isError).toBe(true)
    expect(gone.text.replace(inShared.canvasId, '<id>')).toBe(missing.text.replace('zz-no-canvas', '<id>'))
    const frame = await callTool(limited, 'get_frame', { frame_id: inShared.frameId, agent_name: 'Bot' })
    expect(frame.isError).toBe(true)
    expect((await callTool(limited, 'get_canvas', { canvas_id: inA.canvasId, agent_name: 'Bot' })).isError).toBe(false)

    /* the owner still reaches it through the invite: the limit alone held it back */
    expect(await listed(unlimited)).toContain('Left behind')
    expect((await callTool(unlimited, 'get_canvas', { canvas_id: inShared.canvasId, agent_name: 'Bot' })).isError).toBe(
      false,
    )
  })
})

describe('extension tools under a workspace limit', () => {
  const linearTools = ['list_linear_issues', 'get_linear_issue']

  const rpc = async (secret: string, method: string, params?: Record<string, unknown>) => {
    const res = await fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    return (await res.json()) as { result?: { tools?: { name: string }[] } }
  }
  const toolNames = async (secret: string) => ((await rpc(secret, 'tools/list')).result?.tools ?? []).map((t) => t.name)

  it('leaves them out of tools/list for a limited key of either scope', async () => {
    for (const body of [{ workspaceIds: [wsA] }, { scope: 'comment', workspaceIds: [wsA] }]) {
      const names = await toolNames(await mint({ name: 'limited', ...body }))
      expect(names).toContain('list_canvases')
      for (const tool of linearTools) expect(names).not.toContain(tool)
    }
  })

  it('answers a call to one exactly as it answers a tool that does not exist', async () => {
    const limited = await mint({ name: 'limited', workspaceIds: [wsA] })
    const missing = await callTool(limited, 'no_such_tool', { id: 'ENG-1' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('not found')
    for (const tool of linearTools) {
      const call = await callTool(limited, tool, { id: 'ENG-1' })
      expect(call.isError).toBe(true)
      expect(call.text.replace(tool, '<tool>')).toBe(missing.text.replace('no_such_tool', '<tool>'))
    }
  })

  it('keeps them for an unlimited key', async () => {
    const names = await toolNames(await mint({ name: 'all' }))
    for (const tool of linearTools) expect(names).toContain(tool)
  })
})
