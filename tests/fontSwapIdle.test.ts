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

function upload(bytes: Buffer, fileName: string, workspace: string) {
  return owner.req(`/api/fonts?workspace=${workspace}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(fileName) },
    body: new Uint8Array(bytes),
  })
}

/** canvases with frame HTML in memory, as /healthz/store reports it */
async function loadedCanvases(): Promise<number> {
  return ((await (await fetch(`${server.base}/healthz/store`)).json()) as { loaded: number }).loaded
}

async function frameHtml(canvasId: string): Promise<string> {
  const canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
  return canvas.frames[0].html
}

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

  await expect.poll(async () => (await frameHtml(using)).includes(next.url), { timeout: 10_000 }).toBe(true)
  const swapped = await frameHtml(using)
  expect(swapped).not.toContain(regular.url)
  expect(await loadedCanvases()).toBe(1)
}, 40_000)
