import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { ttf, woff2 } from './fontFiles.ts'
import { fontFaceRule, type CustomFont } from '../shared/fonts.ts'

/* Font rules that went stale before any replacement named them (a face deleted, then another
   uploaded for its weight), healed by a write and by the boot repair pass; and the copies a
   swap used to skip: a pasted layer's carried style block, and the instance frames of a
   canvas that only holds a library copy of a component. */

let server: Server
let owner: Client

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('font-repair@test.dev', 'Owner')
}, 70_000)

afterAll(() => server?.stop())

const doc = (head: string, body: string) => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
const count = (html: string, text: string) => html.split(text).length - 1

function upload(bytes: Buffer, fileName: string, workspace?: string): Promise<CustomFont> {
  return owner
    .req(`/api/fonts${workspace ? `?workspace=${workspace}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(fileName) },
      body: new Uint8Array(bytes),
    })
    .then((res) => res.json())
}

async function remove(font: CustomFont): Promise<void> {
  expect((await owner.delete(`/api/fonts/${font.id}`)).status).toBe(200)
}

async function newWorkspace(name: string): Promise<string> {
  return (await (await owner.post('/api/workspaces', { name })).json()).id
}

async function newCanvas(name: string, workspaceId?: string): Promise<string> {
  return (await (await owner.post('/api/canvases', { name, workspaceId })).json()).id
}

async function newFrame(canvasId: string, html: string): Promise<string> {
  const res = await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'F', html })
  expect(res.status).toBe(200)
  return (await res.json()).id
}

interface FrameBody {
  id: string
  html: string
  updatedAt: number
  approval?: { status: string }
}

async function frameOn(canvasId: string, frameId: string): Promise<FrameBody> {
  const canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
  return canvas.frames.find((f: FrameBody) => f.id === frameId)
}

/** what a no-op leaves alone: the document and the time it was last written */
async function stamp(canvasId: string, frameId: string) {
  const { html, updatedAt } = await frameOn(canvasId, frameId)
  return { html, updatedAt }
}

async function reboot(): Promise<void> {
  server.stop({ keepData: true })
  await server.stopped
  server = await startServer({ PORT: String(server.port) }, server.dataDir)
}

/** A library whose only 400 face's file is gone: the frame written while it stood keeps
 *  a rule for it, and the library now holds a face from another file. */
async function staleFrame(family: string, extra = '') {
  const workspaceId = await newWorkspace(`${family} Co`)
  const gone = await upload(woff2({ family }), 'gone.woff2', workspaceId)
  const canvasId = await newCanvas('Stale', workspaceId)
  const frameId = await newFrame(canvasId, doc(extra, `<p style="font-family:'${family}'">Hi</p>`))
  expect((await frameOn(canvasId, frameId)).html).toContain(gone.url)
  await remove(gone)
  const current = await upload(ttf({ family }), 'current.ttf', workspaceId)
  expect(current.url).not.toBe(gone.url)
  return { workspaceId, canvasId, frameId, gone, current }
}

describe('a frame whose rules name files that left the library', () => {
  it('ends with only the library’s rules after a write', async () => {
    const { canvasId, frameId, gone, current } = await staleFrame('Stale Sans')
    const patched = await owner.patch(`/api/frames/${frameId}`, {
      html: (await frameOn(canvasId, frameId)).html.replace('Hi', 'Hello'),
    })
    expect(patched.status).toBe(200)
    const html = (await frameOn(canvasId, frameId)).html
    expect(html).not.toContain(gone.url)
    expect(count(html, fontFaceRule(current))).toBe(1)
    expect(count(html, '@font-face')).toBe(1)
  })

  it('keeps the rule of a family the library no longer has, another host’s font and a designer’s own rule', async () => {
    const workspaceId = await newWorkspace('Keep Co')
    const dropped = await upload(woff2({ family: 'Dropped Sans' }), 'd.woff2', workspaceId)
    const kept = await upload(woff2({ family: 'Kept Sans' }), 'k.woff2', workspaceId)
    const own = `<style>@font-face{font-family:"Own Sans";src:url("${dropped.url}")}</style>`
    const hosted = `@font-face{font-family:"Kept Sans";src:url("https://cdn.other.test/k.woff2");font-weight:300}`
    const canvasId = await newCanvas('Keep', workspaceId)
    const frameId = await newFrame(
      canvasId,
      doc(
        `${own}<style data-doop-fonts>\n${hosted}</style>`,
        `<p style="font-family:'Dropped Sans'">A</p><p style="font-family:'Kept Sans'">B</p>`,
      ),
    )
    expect((await frameOn(canvasId, frameId)).html).toContain(dropped.url)
    await remove(dropped)
    const patched = await owner.patch(`/api/frames/${frameId}`, {
      html: (await frameOn(canvasId, frameId)).html.replace('>A<', '>Aa<'),
    })
    expect(patched.status).toBe(200)
    const html = (await frameOn(canvasId, frameId)).html
    /* the dropped family's rule (in the block) stays rendering; the other host's and the designer's too */
    expect(html).toContain(own)
    expect(html).toContain(hosted)
    expect(html).toContain(kept.url)
    expect(html).toContain(dropped.url)
  })
})

describe('the boot repair pass', () => {
  it('heals a stale frame without a version, leaves a canvas outside the library, and is a no-op the second time', async () => {
    const stale = await staleFrame('Boot Sans')
    /* a canvas outside every library whose block names the same gone file */
    const outside = await newCanvas('Outside')
    const outsideFrame = await newFrame(
      outside,
      doc(
        `<style data-doop-fonts>\n${fontFaceRule(stale.gone)}\n</style>`,
        `<p style="font-family:'Boot Sans'">Out</p>`,
      ),
    )
    const outsideStamp = await stamp(outside, outsideFrame)
    expect(outsideStamp.html).toContain(stale.gone.url)
    const signed = await owner.put(`/api/frames/${stale.frameId}/approval`, {
      status: 'ready_for_dev',
      expectedUpdatedAt: (await frameOn(stale.canvasId, stale.frameId)).updatedAt,
    })
    expect(signed.status).toBe(200)
    const versions = await (await owner.get(`/api/frames/${stale.frameId}/versions`)).json()

    await reboot()
    await expect
      .poll(async () => (await frameOn(stale.canvasId, stale.frameId)).html.includes(stale.current.url), {
        timeout: 15_000,
      })
      .toBe(true)
    const healed = await frameOn(stale.canvasId, stale.frameId)
    expect(healed.html).not.toContain(stale.gone.url)
    expect(healed.approval?.status).toBe('ready_for_dev')
    const healedStamp = await stamp(stale.canvasId, stale.frameId)
    expect(await (await owner.get(`/api/frames/${stale.frameId}/versions`)).json()).toEqual(versions)
    expect(await stamp(outside, outsideFrame)).toEqual(outsideStamp)

    await reboot()
    await new Promise((resolve) => setTimeout(resolve, 2000))
    expect(await stamp(stale.canvasId, stale.frameId)).toEqual(healedStamp)
    expect(await stamp(outside, outsideFrame)).toEqual(outsideStamp)
  }, 120_000)
})

describe('copies a replacing upload used to skip', () => {
  it('retargets a pasted layer’s carried font rule', async () => {
    const workspaceId = await newWorkspace('Carry Co')
    const regular = await upload(woff2({ family: 'Carry Sans' }), 'c.woff2', workspaceId)
    const canvasId = await newCanvas('Carry', workspaceId)
    const carried = (url: string) =>
      `<style data-doop-carried="c1">@font-face{font-family:"Carry Sans__c1";src:url("${url}") format("woff2");font-weight:400;unicode-range:U+0000-00FF}</style>`
    const frameId = await newFrame(
      canvasId,
      doc(carried(regular.url), `<p style="font-family:'Carry Sans__c1'">Hi</p>`),
    )
    expect((await frameOn(canvasId, frameId)).html).toContain(carried(regular.url))

    const next = await upload(ttf({ family: 'Carry Sans' }), 'c2.ttf', workspaceId)
    const html = (await frameOn(canvasId, frameId)).html
    expect(html).not.toContain(regular.url)
    expect(html).toContain(`font-family:"Carry Sans__c1";src:url("${next.url}")`)
    expect(html).toContain('unicode-range:U+0000-00FF')
  })

  it('reaches the instance frames of a canvas that only holds a library copy', async () => {
    const workspaceId = await newWorkspace('Copy Co')
    const regular = await upload(woff2({ family: 'Copy Sans' }), 'p.woff2', workspaceId)
    const libraryId = await newCanvas('Library', workspaceId)
    const made = await owner.post(`/api/canvases/${libraryId}/components`, {
      name: 'Tag',
      html: '<span class="tag">Tag</span>',
      css: `${fontFaceRule(regular)}\n.tag { font-family: "Copy Sans", sans-serif }`,
    })
    expect(made.status, await made.clone().text()).toBe(200)
    const tag = (await made.json()).component as { id: string }
    expect((await owner.post(`/api/canvases/${libraryId}/library/publish`, {})).status).toBe(200)
    const consumer = await newCanvas('Consumer', workspaceId)
    const imported = await owner.post(`/api/canvases/${consumer}/components/import`, {
      sourceCanvasId: libraryId,
      component: tag.id,
    })
    expect(imported.status).toBe(200)
    const frameId = await newFrame(consumer, doc('', `<doop-use component="${tag.id}"></doop-use>`))
    const block = (html: string) =>
      new RegExp(`<style[^>]*data-doop-component-css="${tag.id}"[^>]*>([\\s\\S]*?)</style>`).exec(html)?.[1] ?? ''
    expect(block((await frameOn(consumer, frameId)).html)).toContain(regular.url)
    /* it now designs with a library of its own, which has no such family */
    expect((await owner.put(`/api/canvases/${consumer}/workspace`, { workspaceId: null })).status).toBe(200)

    const next = await upload(ttf({ family: 'Copy Sans' }), 'p2.ttf', workspaceId)
    const html = (await frameOn(consumer, frameId)).html
    expect(block(html)).toContain(next.url)
    expect(html).not.toContain(regular.url)
  })
})
