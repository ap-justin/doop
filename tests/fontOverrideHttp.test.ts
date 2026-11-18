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
let owner: Account
let other: Account

/** One signed-in person with an agent key and a personal canvas, and so a font library of their own. */
interface Account {
  client: Client
  secret: string
  canvasId: string
}

async function account(email: string): Promise<Account> {
  const client = await new Client(server).signUp(email, 'Owner')
  const secret = ((await (await client.post('/api/agent-keys', { name: 'fonts' })).json()) as { secret: string }).secret
  const canvasId = (await (await client.post('/api/canvases', { name: 'Fonts' })).json()).id
  return { client, secret, canvasId }
}

beforeAll(async () => {
  /* the cases upload over MCP on two accounts: the default 15 a minute would end in a rate-limit error */
  server = await startServer({ MCP_UPLOADS_PER_MIN: '1000' })
  owner = await account('font-override@test.dev')
  other = await account('font-override-other@test.dev')
}, 70_000)

afterAll(() => server?.stop())

interface ToolReply {
  isError?: boolean
  content?: { text: string }[]
}

/** Calls upload_font as `who`; a refusal throws with its text, so a case never reads an error as an empty reply. */
async function uploadFont(args: Record<string, unknown>, who: Account = owner) {
  const res = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${who.secret}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'upload_font', arguments: { canvas_id: who.canvasId, agent_name: 'Claude', ...args } },
    }),
  })
  const reply = ((await res.json()) as { result: ToolReply }).result
  const text = reply.content?.map((c) => c.text).join('') ?? ''
  if (reply.isError) throw new Error(`upload_font was refused: ${text}`)
  return { text, body: JSON.parse(text) }
}

const base64 = (file: Buffer) => file.toString('base64')

async function library(who: Account): Promise<CustomFont[]> {
  return (await (await who.client.get('/api/fonts')).json()) as CustomFont[]
}

async function faces(family: string, who: Account = owner): Promise<string[]> {
  return (await library(who))
    .filter((f) => f.family === family)
    .map((f) => `${f.weight} ${f.style}`)
    .sort()
}

/** The same face as `ttf` writes for `family` at 400, with one more (unused) name record, so it is a different file. */
const regularVariant = (family: string) => ttf({ family, weight: 400, typographicSubfamily: 'Regular' })

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

describe('what a face is read from', () => {
  it('reads italic from the file name over data, so an italic file does not replace the regular one', async () => {
    await uploadFont({ data: base64(ttf({ family: 'Redhat' })), file_name: 'Redhat-Regular.ttf' })
    const italic = await uploadFont({ data: base64(regularVariant('Redhat')), file_name: 'Redhat-Italic.ttf' })
    expect(italic.body).toMatchObject({ weight: '400', style: 'italic', style_from: 'name' })
    expect(await faces('Redhat')).toEqual(['400 italic', '400 normal'])
  })

  it('reads italic from the file name the one-time upload URL is given', async () => {
    await uploadFont({ data: base64(ttf({ family: 'Ticketred' })), file_name: 'Ticketred-Regular.ttf' })
    const ticket = await uploadFont({ local_file: true })
    const put = await fetch(`${ticket.body.upload_url}Ticketred-Italic.ttf`, {
      method: 'PUT',
      body: new Uint8Array(regularVariant('Ticketred')),
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toMatchObject({ style: 'italic', style_from: 'name' })
    expect(await faces('Ticketred')).toEqual(['400 italic', '400 normal'])
  })

  it('reads the weight the subfamily names when the weight class is odd', async () => {
    const medium = await uploadFont({
      data: base64(ttf({ family: 'Mediumish', subfamily: 'Medium', weight: 565 })),
      file_name: 'Mediumish-Medium.ttf',
    })
    expect(medium.body).toMatchObject({ weight: '500', weight_from: 'name' })
    expect(await faces('Mediumish')).toEqual(['500 normal'])
  })

  it.each([1, 1000])('stores the boundary weight %i an override names', async (weight) => {
    const family = `Bound${weight}`
    const stored = await uploadFont({ data: base64(ttf({ family })), file_name: `${family}.ttf`, weight })
    expect(stored.body).toMatchObject({ weight: String(weight), weight_from: 'override' })
    expect(await faces(family)).toEqual([`${weight} normal`])
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

  it('replaces only the face holding the same bytes, not another of equal size', async () => {
    const regular = ttf({ family: 'Eqsize', weight: 400 })
    const bold = ttf({ family: 'Eqsize', weight: 700 })
    expect(bold.length).toBe(regular.length)
    expect(bold.equals(regular)).toBe(false)
    await uploadFont({ data: base64(regular), file_name: 'Eqsize-Regular.ttf' })
    await uploadFont({ data: base64(bold), file_name: 'Eqsize-Bold.ttf' })
    await uploadFont({ data: base64(regular), file_name: 'Eqsize-Regular.ttf', weight: 500 })
    expect(await faces('Eqsize')).toEqual(['500 normal', '700 normal'])
  })

  it('leaves another library’s face alone when the same bytes are uploaded there', async () => {
    const file = base64(ttf({ family: 'Shared', weight: 300 }))
    await uploadFont({ data: file, file_name: 'Shared-Light.ttf' })
    await uploadFont({ data: file, file_name: 'Shared-Light.ttf', weight: 500 }, other)
    expect(await faces('Shared')).toEqual(['300 normal'])
    expect(await faces('Shared', other)).toEqual(['500 normal'])
  })

  it('stores a variable font with a weight override as that one weight', async () => {
    const flex = base64(woff2({ family: 'Flex', wght: [100, 900] }))
    expect((await uploadFont({ data: flex, file_name: 'Flex.woff2' })).body).toMatchObject({ weight: '100 900' })
    const pinned = await uploadFont({ data: flex, file_name: 'Flex.woff2', weight: 450 })
    expect(pinned.body).toMatchObject({ weight: '450', weight_from: 'override' })
    expect(await faces('Flex')).toEqual(['450 normal'])
  })
})
