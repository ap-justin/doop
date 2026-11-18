import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { ttf, woff2 } from './fontFiles.ts'
import type { CustomFont } from '../shared/fonts.ts'

/**
 * upload_font's weight and style overrides against the REAL server: the
 * one-time /u/ upload URL keeps them, and a re-upload that corrects a face
 * replaces it instead of leaving a duplicate.
 */

let server: Server
let owner: Client
let secret: string
let canvasId: string

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('font-override@test.dev', 'Owner')
  secret = ((await (await owner.post('/api/agent-keys', { name: 'fonts' })).json()) as { secret: string }).secret
  canvasId = (await (await owner.post('/api/canvases', { name: 'Fonts' })).json()).id
}, 70_000)

afterAll(() => server?.stop())

interface ToolReply {
  isError?: boolean
  content?: { text: string }[]
}

async function uploadFont(args: Record<string, unknown>) {
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
      params: { name: 'upload_font', arguments: { canvas_id: canvasId, agent_name: 'Claude', ...args } },
    }),
  })
  const reply = ((await res.json()) as { result: ToolReply }).result
  const text = reply.content?.map((c) => c.text).join('') ?? ''
  return { isError: !!reply.isError, text, body: reply.isError ? {} : JSON.parse(text) }
}

const base64 = (file: Buffer) => file.toString('base64')

async function library(): Promise<CustomFont[]> {
  return (await (await owner.get('/api/fonts')).json()) as CustomFont[]
}

async function faces(family: string): Promise<string[]> {
  return (await library())
    .filter((f) => f.family === family)
    .map((f) => `${f.weight} ${f.style}`)
    .sort()
}

describe('the local_file upload URL', () => {
  it('stores the override its ticket carries and says it was overridden', async () => {
    const ticket = await uploadFont({ local_file: true, weight: 500, style: 'italic' })
    const url: string = ticket.body.upload_url
    const put = await fetch(`${url}Ticketed-Light.ttf`, {
      method: 'PUT',
      body: new Uint8Array(ttf({ family: 'Ticketed', weight: 300 })),
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toMatchObject({
      family: 'Ticketed',
      weight: '500',
      weight_from: 'override',
      style: 'italic',
      style_from: 'override',
    })
    expect(await faces('Ticketed')).toEqual(['500 italic'])
  })

  it('stores what the file says when the ticket carries no override', async () => {
    const ticket = await uploadFont({ local_file: true })
    const put = await fetch(`${ticket.body.upload_url}Plain.ttf`, {
      method: 'PUT',
      body: new Uint8Array(ttf({ family: 'Plain', weight: 300 })),
    })
    expect(await put.json()).toMatchObject({ weight: '300', weight_from: 'file', style: 'normal' })
  })
})

describe('replacing a face', () => {
  it('leaves only the corrected face when the same bytes are uploaded again with another weight and style', async () => {
    const file = base64(ttf({ family: 'Misread', weight: 565 }))
    expect((await uploadFont({ data: file, file_name: 'Misread.ttf' })).body).toMatchObject({ weight: '565' })
    expect(await faces('Misread')).toEqual(['565 normal'])
    const fixed = await uploadFont({ data: file, file_name: 'Misread.ttf', weight: 500, style: 'italic' })
    expect(fixed.body).toMatchObject({ weight: '500', weight_from: 'override' })
    expect(await faces('Misread')).toEqual(['500 italic'])
  })

  it('keeps another file of the same family at a different weight or style', async () => {
    await uploadFont({ data: base64(ttf({ family: 'Family', weight: 400 })), file_name: 'Family-Regular.ttf' })
    await uploadFont({ data: base64(ttf({ family: 'Family', weight: 700 })), file_name: 'Family-Bold.ttf' })
    const other = ttf({ family: 'Family', weight: 400, subfamily: 'Regular' })
    // a different file (another size) claiming italic must not displace the regular face
    await uploadFont({ data: base64(Buffer.concat([other, Buffer.alloc(8)])), file_name: 'F.ttf', style: 'italic' })
    expect(await faces('Family')).toEqual(['400 italic', '400 normal', '700 normal'])
  })

  it('stores a variable font with a weight override as that one weight', async () => {
    const flex = base64(woff2({ family: 'Flex', wght: [100, 900] }))
    expect((await uploadFont({ data: flex, file_name: 'Flex.woff2' })).body).toMatchObject({ weight: '100 900' })
    const pinned = await uploadFont({ data: flex, file_name: 'Flex.woff2', weight: 450 })
    expect(pinned.body).toMatchObject({ weight: '450', weight_from: 'override' })
    expect(await faces('Flex')).toEqual(['450 normal'])
  })
})
