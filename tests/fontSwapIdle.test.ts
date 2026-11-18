import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { ttf, woff2 } from './fontFiles.ts'
import type { CustomFont } from '../shared/fonts.ts'

/* A replacing upload on a workspace whose canvases have gone idle (CANVAS_IDLE_MS
   is short, so the sweep drops their frame HTML): the upload answers at once, only
   the canvas whose frames load the replaced file is read back and swapped, and a
   canvas that never named the family stays out of memory. */

let server: Server
let owner: Client

beforeAll(async () => {
  server = await startServer({ CANVAS_IDLE_MS: '1500' })
  owner = await new Client(server).signUp('swap-idle@test.dev', 'Owner')
}, 70_000)

afterAll(() => server?.stop())

function upload(bytes: Buffer, fileName: string, workspace: string | null, who: Client = owner) {
  return who.req(workspace ? `/api/fonts?workspace=${workspace}` : '/api/fonts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(fileName) },
    body: new Uint8Array(bytes),
  })
}

/** canvases with frame HTML in memory, as /healthz/store reports it */
async function loadedCanvases(): Promise<number> {
  return ((await (await fetch(`${server.base}/healthz/store`)).json()) as { loaded: number }).loaded
}

async function frameHtml(canvasId: string, who: Client = owner): Promise<string> {
  const canvas = await (await who.get(`/api/canvases/${canvasId}`)).json()
  return canvas.frames[0].html
}

/** upload_font over MCP, the one upload that takes a weight override */
async function uploadFontOverMcp(secret: string, args: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'upload_font', arguments: { agent_name: 'Claude', ...args } },
    }),
  })
  const reply = ((await res.json()) as { result: { isError?: boolean; content?: { text: string }[] } }).result
  const text = reply.content?.map((c) => c.text).join('') ?? ''
  if (reply.isError) throw new Error(`upload_font was refused: ${text}`)
}

const page = (body: string, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`

it('swaps idle canvases after the upload, reading only those that use the face', async () => {
  const workspaceId = (await (await owner.post('/api/workspaces', { name: 'Idle Co' })).json()).id
  const regular: CustomFont = await (await upload(woff2({ family: 'Idle Sans' }), 'i.woff2', workspaceId)).json()
  const using = (await (await owner.post('/api/canvases', { name: 'Using', workspaceId })).json()).id
  const plain = (await (await owner.post('/api/canvases', { name: 'Plain', workspaceId })).json()).id
  const html = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`
  await owner.post(`/api/canvases/${using}/frames`, {
    name: 'F',
    html: html(`<p style="font-family:'Idle Sans'">Hi</p>`),
  })
  await owner.post(`/api/canvases/${plain}/frames`, { name: 'F', html: html('<p>Plain</p>') })
  expect(await frameHtml(using)).toContain(regular.url)
  await expect.poll(loadedCanvases, { timeout: 10_000, interval: 250 }).toBe(0)

  const res = await upload(ttf({ family: 'Idle Sans' }), 'i2.ttf', workspaceId)
  expect(res.status).toBe(200)
  const next: CustomFont = await res.json()

  /* each poll's own read keeps `using` loaded, so a count above one means the swap read
     `plain` as well; the peak over the polls does not depend on when the sweep next runs */
  const loadedSamples: number[] = []
  await expect
    .poll(
      async () => {
        const html = await frameHtml(using)
        loadedSamples.push(await loadedCanvases())
        return html.includes(next.url)
      },
      { timeout: 10_000, interval: 100 },
    )
    .toBe(true)
  const swapped = await frameHtml(using)
  expect(swapped).not.toContain(regular.url)
  expect(Math.max(...loadedSamples)).toBeLessThanOrEqual(1)
}, 40_000)

it('keeps a swap of two replaced faces to the library’s own canvases', async () => {
  const workspaceId = (await (await owner.post('/api/workspaces', { name: 'Pair Co' })).json()).id
  const regularFile = ttf({ family: 'Pair Sans', weight: 400 })
  const regular: CustomFont = await (await upload(regularFile, 'p4.ttf', workspaceId)).json()
  const bold: CustomFont = await (await upload(ttf({ family: 'Pair Sans', weight: 700 }), 'p7.ttf', workspaceId)).json()
  const target = (await (await owner.post('/api/canvases', { name: 'Target', workspaceId })).json()).id
  const holder = (await (await owner.post('/api/canvases', { name: 'Holder', workspaceId })).json()).id
  await owner.post(`/api/canvases/${holder}/frames`, {
    name: 'F',
    html: page(`<p style="font-family:'Pair Sans'">Hi</p>`),
  })
  expect(await frameHtml(holder)).toContain(regular.url)

  /* someone else's personal canvas, outside the workspace library, whose stored frame loads
     the 400 face's file; their own library is not empty, so a swap there would rewrite it */
  const other = await new Client(server).signUp('swap-idle-other@test.dev', 'Other')
  expect((await upload(ttf({ family: 'Elsewhere' }), 'e.ttf', null, other)).status).toBe(200)
  const outside = (await (await other.post('/api/canvases', { name: 'Outside' })).json()).id
  const rule = `@font-face{font-family:'Pair Sans';src:url(${regular.url});font-weight:400;font-style:normal}`
  await other.post(`/api/canvases/${outside}/frames`, {
    name: 'F',
    html: page(`<p style="font-family:'Pair Sans'">Theirs</p>`, `<style data-doop-fonts>${rule}</style>`),
  })
  const outsideBefore = await frameHtml(outside, other)
  expect(outsideBefore).toContain(regular.url)
  await expect.poll(loadedCanvases, { timeout: 10_000, interval: 250 }).toBe(0)

  /* the 400 file again as 700 replaces both rows: the 700 by face, the 400 by bytes, so
     the lookup of idle canvases names two URLs, the 400 one second */
  const secret = ((await (await owner.post('/api/agent-keys', { name: 'fonts' })).json()) as { secret: string }).secret
  await uploadFontOverMcp(secret, {
    canvas_id: target,
    data: regularFile.toString('base64'),
    file_name: 'p4.ttf',
    weight: 700,
  })
  const library = (await (await owner.get(`/api/fonts?workspace=${workspaceId}`)).json()) as CustomFont[]
  const pair = library.filter((f) => f.family === 'Pair Sans')
  expect(pair.map((f) => f.weight)).toEqual(['700'])
  const next = pair[0]!

  await expect.poll(async () => (await frameHtml(holder)).includes(next.url), { timeout: 10_000 }).toBe(true)
  const swapped = await frameHtml(holder)
  expect(swapped).not.toContain(regular.url)
  expect(swapped).not.toContain(bold.url)
  /* the swap pass holds each canvas it reads; once every canvas has gone idle again it is over */
  await expect.poll(loadedCanvases, { timeout: 15_000, interval: 250 }).toBe(0)
  expect(await frameHtml(outside, other)).toBe(outsideBefore)
}, 60_000)
