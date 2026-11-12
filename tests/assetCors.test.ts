import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { ttf, woff, woff2 } from './fontFiles.ts'

/* /a/ serves uploads to anyone with the URL, but only fonts carry a
   cross-origin header: @font-face needs it from a sandboxed frame, while
   images load without it and must not be readable by a frame's fetch(). */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>')

let server: Server
let owner: Client
let canvasId: string

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('asset-cors@test.dev', 'Asset Cors')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Assets' })).json()).id
}, 60_000)

afterAll(() => server?.stop())

async function servedHeaders(url: string): Promise<Headers> {
  const res = await fetch(url.replace(/^https?:\/\/[^/]+/, server.base))
  expect(res.status).toBe(200)
  return res.headers
}

describe('GET /a/:id.:ext cross-origin header', () => {
  it.each([
    ['ttf', ttf],
    ['woff', woff],
    ['woff2', woff2],
  ])('is sent for a %s font', async (ext, build) => {
    const res = await owner.req('/api/fonts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(`AssetCors-Regular.${ext}`),
      },
      body: new Uint8Array(build({ family: `Asset Cors ${ext}` })),
    })
    expect(res.status).toBe(200)
    const headers = await servedHeaders((await res.json()).url)
    expect(headers.get('content-type')).toMatch(/^font\//)
    expect(headers.get('access-control-allow-origin')).toBe('*')
  })

  it.each([
    ['png', PNG, 'image/png'],
    ['svg', SVG, 'image/svg+xml'],
  ])('is not sent for a %s', async (_name, bytes, mime) => {
    const res = await owner.req(`/api/canvases/${canvasId}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    })
    expect(res.status).toBe(200)
    const headers = await servedHeaders((await res.json()).url)
    expect(headers.get('content-type')).toBe(mime)
    expect(headers.get('access-control-allow-origin')).toBeNull()
  })
})
