import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { ttf, woff2 } from './fontFiles.ts'
import { fontFaceRule, type CustomFont } from '../shared/fonts.ts'

/**
 * Font libraries against the REAL server (see ./harness.ts): uploads land in
 * the right library and are served as assets, a canvas sees its workspace's
 * (or its owner's) fonts, and a frame write that names a library family gets
 * the @font-face rules added to its saved HTML.
 */

let server: Server
let owner: Client
let mate: Client
let stranger: Client
let workspaceId: string

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('fonts-owner@test.dev', 'Owner')
  mate = await new Client(server).signUp('fonts-mate@test.dev', 'Mate')
  stranger = await new Client(server).signUp('fonts-stranger@test.dev', 'Stranger')
  workspaceId = (await (await owner.post('/api/workspaces', { name: 'Brand Co' })).json()).id
  expect((await owner.post(`/api/workspaces/${workspaceId}/members`, { email: 'fonts-mate@test.dev' })).status).toBe(
    200,
  )
}, 70_000)

afterAll(() => server?.stop())

function upload(client: Client, bytes: Buffer, fileName: string, workspace?: string) {
  return client.req(`/api/fonts${workspace ? `?workspace=${workspace}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(fileName) },
    body: new Uint8Array(bytes),
  })
}

async function savedHtml(client: Client, canvasId: string, frameId: string): Promise<string> {
  const canvas = await (await client.get(`/api/canvases/${canvasId}`)).json()
  return canvas.frames.find((f: { id: string }) => f.id === frameId).html
}

describe('personal font library', () => {
  let regular: CustomFont

  it('reads the uploaded file and serves it as an immutable asset', async () => {
    const res = await upload(owner, woff2({ family: 'Owner Sans' }), 'OwnerSans-Regular.woff2')
    expect(res.status).toBe(200)
    regular = await res.json()
    expect(regular).toMatchObject({ family: 'Owner Sans', weight: '400', style: 'normal', format: 'woff2' })
    const asset = await fetch(regular.url.replace(/^https?:\/\/[^/]+/, server.base))
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('font/woff2')
    expect(asset.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('is private to its owner', async () => {
    expect((await (await owner.get('/api/fonts')).json()).map((f: CustomFont) => f.id)).toEqual([regular.id])
    expect(await (await stranger.get('/api/fonts')).json()).toEqual([])
    expect((await stranger.delete(`/api/fonts/${regular.id}`)).status).toBe(404)
  })

  it('replaces a face uploaded again instead of listing it twice', async () => {
    const again: CustomFont = await (await upload(owner, ttf({ family: 'Owner Sans' }), 'OwnerSans.ttf')).json()
    const list: CustomFont[] = await (await owner.get('/api/fonts')).json()
    expect(list.map((f) => f.id)).toEqual([again.id])
    regular = again
  })

  it('refuses files that are not fonts', async () => {
    const res = await upload(owner, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.svg')
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not a font file/)
  })

  it('is the library of the owner’s personal canvases, and frames using it carry the face', async () => {
    const canvasId = (await (await owner.post('/api/canvases', { name: 'Personal' })).json()).id
    const fonts: CustomFont[] = await (await owner.get(`/api/canvases/${canvasId}/fonts`)).json()
    expect(fonts.map((f) => f.family)).toEqual(['Owner Sans'])

    const created = await owner.post(`/api/canvases/${canvasId}/frames`, {
      name: 'Hero',
      html: '<!doctype html><html><head></head><body><h1 style="font-family: \'Owner Sans\', sans-serif">Hi</h1></body></html>',
    })
    expect(created.status).toBe(200)
    const frameId = (await created.json()).id
    const html = await savedHtml(owner, canvasId, frameId)
    expect(html).toContain('<style data-doop-fonts>')
    expect(html).toContain(regular.url)
  })
})

describe('a replaced face in frames', () => {
  const USES = `<p style="font-family: 'Swap Sans', sans-serif">Hi</p>`
  const OWN_RULE = `@font-face{font-family:"Own";src:url("https://example.test/own.woff2")}`
  const count = (html: string, text: string) => html.split(text).length - 1

  async function frameOn(canvasId: string, html: string): Promise<string> {
    const res = await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'F', html })
    expect(res.status).toBe(200)
    return (await res.json()).id
  }

  it('is swapped in untouched frames, replaces a deleted face of a family the library has, and is left alone elsewhere', async () => {
    const workspaceId = (await (await owner.post('/api/workspaces', { name: 'Swap Co' })).json()).id
    const regular: CustomFont = await (
      await upload(owner, woff2({ family: 'Swap Sans' }), 'a.woff2', workspaceId)
    ).json()
    const bold: CustomFont = await (
      await upload(owner, woff2({ family: 'Swap Sans', weight: 700 }), 'b.woff2', workspaceId)
    ).json()
    const inside = (await (await owner.post('/api/canvases', { name: 'Inside', workspaceId })).json()).id
    const outside = (await (await owner.post('/api/canvases', { name: 'Outside' })).json()).id

    const bodyHtml = `<!doctype html><html><head><style>${OWN_RULE}</style></head><body>${USES}</body></html>`
    const frameId = await frameOn(inside, bodyHtml)
    const before = await savedHtml(owner, inside, frameId)
    expect(before).toContain(regular.url)
    expect(before).toContain(bold.url)

    /* a managed block on a canvas outside the library that names the old file; the owner's own
       library gets a face for the same family and style afterwards, so a swap that wrongly
       reached this canvas would find a covering face and rewrite the rule */
    const foreign = `<html><head><style data-doop-fonts>\n${fontFaceRule(regular)}\n</style></head><body>${USES}</body></html>`
    const foreignId = await frameOn(outside, foreign)
    const foreignBefore = await savedHtml(owner, outside, foreignId)
    expect(foreignBefore).toContain(regular.url)
    const personal: CustomFont = await (await upload(owner, woff2({ family: 'Swap Sans' }), 'p.woff2')).json()
    expect(personal.url).not.toBe(regular.url)

    /* a deleted face's rule is dropped at the next rebuild, the library having the family */
    expect((await owner.delete(`/api/fonts/${bold.id}`)).status).toBe(200)

    const next: CustomFont = await (await upload(owner, ttf({ family: 'Swap Sans' }), 'a2.ttf', workspaceId)).json()
    expect(next.url).not.toBe(regular.url)

    const after = await savedHtml(owner, inside, frameId)
    expect(after).toContain(next.url)
    expect(after).not.toContain(regular.url)
    /* the library still has the family, so its own faces stand in for the deleted one */
    expect(after).not.toContain(bold.url)
    expect(after).toContain(OWN_RULE)
    expect(await savedHtml(owner, outside, foreignId)).toBe(foreignBefore)

    /* edited afterwards: one rule per face */
    const patched = await owner.patch(`/api/frames/${frameId}`, { html: after.replace('Hi', 'Hello') })
    expect(patched.status).toBe(200)
    const edited = await savedHtml(owner, inside, frameId)
    expect(count(edited, `url("${next.url}")`)).toBe(1)
    expect(count(edited, '@font-face')).toBe(2)
  })
})

describe('a replaced face in a component main', () => {
  interface Listed {
    id: string
    rev: number
    css: string
  }

  it('is swapped without a revision, and the main’s next write files none', async () => {
    const workspaceId = (await (await owner.post('/api/workspaces', { name: 'Kit Co' })).json()).id
    const regular: CustomFont = await (
      await upload(owner, woff2({ family: 'Kit Sans' }), 'k.woff2', workspaceId)
    ).json()
    const canvasId = (await (await owner.post('/api/canvases', { name: 'Kit', workspaceId })).json()).id
    /* the design's own rule loads the file, so the main's component CSS carries it */
    const html = `<!doctype html><html><head><style>${fontFaceRule(regular)}\n.chip{font-family:"Kit Sans",sans-serif}</style></head><body><span class="chip" data-doop-id="chipone">Chip</span></body></html>`
    const frame = await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'Kit', html })
    const frameId: string = (await frame.json()).id
    const made = await owner.post(`/api/canvases/${canvasId}/components`, { name: 'Chip', frameId, element: 'chipone' })
    expect(made.status).toBe(200)
    const chip = async (): Promise<Listed> =>
      ((await (await owner.get(`/api/canvases/${canvasId}/components`)).json()) as Listed[])[0]!
    const before = await chip()
    expect(before.css).toContain(regular.url)

    const next: CustomFont = await (await upload(owner, ttf({ family: 'Kit Sans' }), 'k2.ttf', workspaceId)).json()
    const swapped = await chip()
    expect(swapped.rev).toBe(before.rev)
    expect(swapped.css).toContain(next.url)
    expect(swapped.css).not.toContain(regular.url)

    const stored = await savedHtml(owner, canvasId, frameId)
    expect(stored).toContain(fontFaceRule(regular))
    const patched = await owner.patch(`/api/frames/${frameId}`, {
      html: stored.replace('</body>', '<p>note</p></body>'),
    })
    expect(patched.status).toBe(200)
    const edited = await chip()
    expect(edited.rev).toBe(before.rev)
    expect(edited.css).toBe(swapped.css)
  })
})

describe('workspace font library', () => {
  let brand: CustomFont

  it('takes uploads from any member and none from outsiders', async () => {
    const res = await upload(
      mate,
      woff2({ family: 'Brand Grotesk', weight: 700 }),
      'BrandGrotesk-Bold.woff2',
      workspaceId,
    )
    expect(res.status).toBe(200)
    brand = await res.json()
    expect((await upload(stranger, woff2({ family: 'Sneaky' }), 's.woff2', workspaceId)).status).toBe(403)
    expect((await stranger.get(`/api/fonts?workspace=${workspaceId}`)).status).toBe(403)
    const list: CustomFont[] = await (await owner.get(`/api/fonts?workspace=${workspaceId}`)).json()
    expect(list.map((f) => f.family)).toEqual(['Brand Grotesk'])
  })

  it('is what a workspace canvas designs with, and a PATCH that starts using it adds the face', async () => {
    const canvasId = (await (await mate.post('/api/canvases', { name: 'Site', workspaceId })).json()).id
    const fonts: CustomFont[] = await (await owner.get(`/api/canvases/${canvasId}/fonts`)).json()
    expect(fonts.map((f) => f.family)).toEqual(['Brand Grotesk'])

    const frame = await (
      await owner.post(`/api/canvases/${canvasId}/frames`, {
        name: 'Card',
        html: '<html><body><p>Hi</p></body></html>',
      })
    ).json()
    expect(await savedHtml(owner, canvasId, frame.id)).not.toContain('data-doop-fonts')

    const patched = await owner.patch(`/api/frames/${frame.id}`, {
      html: '<html><body><p style="font-family: &quot;Brand Grotesk&quot;">Hi</p></body></html>',
    })
    expect(patched.status).toBe(200)
    expect(await savedHtml(owner, canvasId, frame.id)).toContain(brand.url)
  })

  it('lets a member remove a font; frames that load it keep their face', async () => {
    expect((await owner.delete(`/api/fonts/${brand.id}`)).status).toBe(200)
    const left: CustomFont[] = await (await owner.get(`/api/fonts?workspace=${workspaceId}`)).json()
    expect(left.map((f) => f.family)).not.toContain('Brand Grotesk')
    const asset = await fetch(brand.url.replace(/^https?:\/\/[^/]+/, server.base))
    expect(asset.status).toBe(200)
  })
})
