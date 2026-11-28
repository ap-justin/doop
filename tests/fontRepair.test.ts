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

async function signOff(canvasId: string, frameId: string): Promise<void> {
  const res = await owner.put(`/api/frames/${frameId}/approval`, {
    status: 'ready_for_dev',
    expectedUpdatedAt: (await frameOn(canvasId, frameId)).updatedAt,
  })
  expect(res.status).toBe(200)
}

async function versionsOf(frameId: string): Promise<unknown> {
  return (await owner.get(`/api/frames/${frameId}/versions`)).json()
}

/** canvases with frame HTML read into memory, as /healthz/store reports it: a canvas with no
 *  frames has no page to read, so it is never counted */
async function loadedCanvases(): Promise<number> {
  const { loaded } = (await (await fetch(`${server.base}/healthz/store`)).json()) as { loaded: number }
  return loaded
}

/** the rules inside Doop's own font block */
const fontBlock = (html: string) => /<style\b[^>]*data-doop-fonts[^>]*>([\s\S]*?)<\/style>/i.exec(html)?.[1] ?? ''

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
    const ownFile = await upload(woff2({ family: 'Own Sans' }), 'o.woff2', workspaceId)
    const own = `<style>@font-face{font-family:"Own Sans";src:url("${ownFile.url}")}</style>`
    const hosted = `@font-face{font-family:"Kept Sans";src:url("https://cdn.other.test/k.woff2");font-weight:300}`
    const canvasId = await newCanvas('Keep', workspaceId)
    const frameId = await newFrame(
      canvasId,
      doc(
        `${own}<style data-doop-fonts>\n${hosted}</style>`,
        `<p style="font-family:'Dropped Sans'">A</p><p style="font-family:'Kept Sans'">B</p>`,
      ),
    )
    const written = (await frameOn(canvasId, frameId)).html
    expect(fontBlock(written)).toContain(fontFaceRule(dropped))
    await remove(dropped)
    await remove(ownFile)
    const patched = await owner.patch(`/api/frames/${frameId}`, { html: written.replace('>A<', '>Aa<') })
    expect(patched.status).toBe(200)
    const html = (await frameOn(canvasId, frameId)).html
    /* the dropped family's rule stays in Doop's block, where only the block's own rules can be told from the designer's */
    expect(fontBlock(html)).toContain(fontFaceRule(dropped))
    expect(fontBlock(html)).toContain(hosted)
    expect(fontBlock(html)).toContain(kept.url)
    expect(html).toContain(own)
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
      `<style data-doop-carried="c1">@font-face{font-family:"Carry Sans-c1";src:url("${url}") format("woff2");font-weight:400;unicode-range:U+0000-00FF}</style>`
    const frameId = await newFrame(canvasId, doc(carried(regular.url), `<p style="font-family:'Carry Sans-c1'">Hi</p>`))
    expect((await frameOn(canvasId, frameId)).html).toContain(carried(regular.url))

    const next = await upload(ttf({ family: 'Carry Sans' }), 'c2.ttf', workspaceId)
    const html = (await frameOn(canvasId, frameId)).html
    expect(html).not.toContain(regular.url)
    expect(html).toContain(`font-family:"Carry Sans-c1";src:url("${next.url}")`)
    expect(html).toContain('unicode-range:U+0000-00FF')
  })

  it('swaps a pasted layer’s renamed face in a main and its component alike, so the main’s next write files no revision', async () => {
    const workspaceId = await newWorkspace('Carry Kit Co')
    const regular = await upload(woff2({ family: 'Kit Carry' }), 'k.woff2', workspaceId)
    const canvasId = await newCanvas('Carry Kit', workspaceId)
    /* a layer pasted into a frame already defining the family: its rule wears the paste's scope */
    const carried =
      `<style data-doop-carried="ab12cd">@font-face{font-family:"Kit Carry-ab12cd";src:url("${regular.url}") format("woff2");font-weight:400;font-style:normal}\n` +
      `.chip{font-family:"Kit Carry-ab12cd",sans-serif}</style>`
    const frameId = await newFrame(canvasId, doc(carried, `<span class="chip" data-doop-id="chipone">Chip</span>`))
    const made = await owner.post(`/api/canvases/${canvasId}/components`, { name: 'Chip', frameId, element: 'chipone' })
    expect(made.status, await made.clone().text()).toBe(200)
    const chip = async (): Promise<{ rev: number; css: string }> =>
      (await (await owner.get(`/api/canvases/${canvasId}/components`)).json())[0]
    const before = await chip()
    expect(before.css).toContain(regular.url)

    const next = await upload(ttf({ family: 'Kit Carry' }), 'k2.ttf', workspaceId)
    const swapped = await chip()
    expect(swapped.rev).toBe(before.rev)
    expect(swapped.css).toContain(next.url)
    expect(swapped.css).not.toContain(regular.url)
    const stored = (await frameOn(canvasId, frameId)).html
    expect(stored).toContain(`font-family:"Kit Carry-ab12cd";src:url("${next.url}")`)

    const patched = await owner.patch(`/api/frames/${frameId}`, {
      html: stored.replace('</body>', '<p>note</p></body>'),
    })
    expect(patched.status).toBe(200)
    const edited = await chip()
    expect(edited.rev).toBe(before.rev)
    expect(edited.css).toBe(swapped.css)
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

/** a canvas in its own library whose component's stylesheet loads the file that then left it */
async function staleFrameWithComponent(family: string) {
  const workspaceId = await newWorkspace(`${family} Co`)
  const gone = await upload(woff2({ family }), 'gone.woff2', workspaceId)
  const canvasId = await newCanvas('Stale kit', workspaceId)
  const frameId = await newFrame(canvasId, doc('', `<p style="font-family:'${family}'">Hi</p>`))
  const made = await owner.post(`/api/canvases/${canvasId}/components`, {
    name: 'Tag',
    html: '<span class="tag">Tag</span>',
    css: `${fontFaceRule(gone)}\n.tag { font-family: "${family}", sans-serif }`,
  })
  expect(made.status, await made.clone().text()).toBe(200)
  await remove(gone)
  const current = await upload(ttf({ family }), 'current.ttf', workspaceId)
  return { workspaceId, canvasId, frameId, gone, current }
}

const componentsOf = async (canvasId: string): Promise<{ rev: number; css: string }[]> =>
  (await owner.get(`/api/canvases/${canvasId}/components`)).json()

describe('the boot repair pass across canvases', () => {
  it('heals two stale files on two canvases in one run, reads no canvas it would not change, and files no component revision', async () => {
    const one = await staleFrameWithComponent('Multi One')
    const two = await staleFrame('Multi Two')
    expect(one.gone.id).not.toBe(two.gone.id)

    /* a canvas in a library with nothing stale */
    const cleanWorkspace = await newWorkspace('Clean Co')
    await upload(woff2({ family: 'Clean Sans' }), 'c.woff2', cleanWorkspace)
    const clean = await newCanvas('Clean', cleanWorkspace)
    const cleanFrame = await newFrame(clean, doc('', `<p style="font-family:'Clean Sans'">Hi</p>`))

    /* stale uploads that healing must leave exactly as written: a family the library dropped
       entirely and another host's font in Doop's block, and a designer's own stylesheet */
    const keepWorkspace = await newWorkspace('Keep Boot Co')
    const dropped = await upload(woff2({ family: 'Dropped Boot' }), 'd.woff2', keepWorkspace)
    const ownFile = await upload(woff2({ family: 'Own Boot' }), 'o.woff2', keepWorkspace)
    await upload(woff2({ family: 'Kept Boot' }), 'k.woff2', keepWorkspace)
    const hosted = `@font-face{font-family:"Kept Boot";src:url("https://cdn.other.test/k.woff2");font-weight:300}`
    const own = `<style>@font-face{font-family:"Own Boot";src:url("${ownFile.url}")}</style>`
    const keep = await newCanvas('Keep', keepWorkspace)
    const keepFrame = await newFrame(
      keep,
      doc(
        `${own}<style data-doop-fonts>\n${hosted}</style>`,
        `<p style="font-family:'Dropped Boot'">A</p><p style="font-family:'Kept Boot'">B</p>`,
      ),
    )
    expect(fontBlock((await frameOn(keep, keepFrame)).html)).toContain(fontFaceRule(dropped))
    await remove(dropped)
    await remove(ownFile)
    const keepStamp = await stamp(keep, keepFrame)
    const cleanStamp = await stamp(clean, cleanFrame)
    const kitBefore = await componentsOf(one.canvasId)
    expect(kitBefore[0]?.css).toContain(one.gone.url)

    await reboot()
    const healed = async (stale: { canvasId: string; frameId: string; current: CustomFont }) =>
      (await frameOn(stale.canvasId, stale.frameId)).html.includes(stale.current.url)
    await expect.poll(async () => (await healed(one)) && (await healed(two)), { timeout: 15_000 }).toBe(true)
    await expect
      .poll(async () => (await componentsOf(one.canvasId))[0]?.css.includes(one.current.url), { timeout: 15_000 })
      .toBe(true)
    expect((await frameOn(one.canvasId, one.frameId)).html).not.toContain(one.gone.url)
    expect((await frameOn(two.canvasId, two.frameId)).html).not.toContain(two.gone.url)

    const kitAfter = await componentsOf(one.canvasId)
    expect(kitAfter[0]?.css).not.toContain(one.gone.url)
    expect(kitAfter[0]?.rev).toBe(kitBefore[0]?.rev)

    /* only the two canvases that were read to heal them (and by the polls above) are in memory */
    expect(await loadedCanvases()).toBe(2)
    expect(await stamp(keep, keepFrame)).toEqual(keepStamp)
    expect(await stamp(clean, cleanFrame)).toEqual(cleanStamp)
  }, 120_000)

  it('writes nothing and loads no canvas the second time', async () => {
    const first = await staleFrame('Again Sans')
    await reboot()
    await expect
      .poll(async () => (await frameOn(first.canvasId, first.frameId)).html.includes(first.current.url), {
        timeout: 15_000,
      })
      .toBe(true)
    const healedStamp = await stamp(first.canvasId, first.frameId)

    /* a run that changes nothing sends no signal, so this canvas healing stands in for the pass being over */
    const last = await staleFrame('Again Last')
    await reboot()
    await expect
      .poll(async () => (await frameOn(last.canvasId, last.frameId)).html.includes(last.current.url), {
        timeout: 15_000,
      })
      .toBe(true)
    expect(await loadedCanvases()).toBe(1)
    expect(await stamp(first.canvasId, first.frameId)).toEqual(healedStamp)
  }, 120_000)
})

describe('the boot repair pass and another library’s file', () => {
  it('leaves a pasted layer’s file from another library as written, and heals this library’s own stale file', async () => {
    const family = 'Pasted Sans'
    const otherWorkspace = await newWorkspace('Source Co')
    const foreign = await upload(woff2({ family }), 'source.woff2', otherWorkspace)

    const workspaceId = await newWorkspace('Paste Co')
    const gone = await upload(woff2({ family }), 'gone.woff2', workspaceId)
    /* two carried sheets, each naming the family at the library's own weight and style, so only
       whose library the file belongs to tells them apart */
    const carried = (scope: string, url: string) =>
      `<style data-doop-carried="${scope}">${fontFaceRule({ ...gone, url })}</style>`
    const canvasId = await newCanvas('Paste', workspaceId)
    const frameId = await newFrame(
      canvasId,
      doc(`${carried('own', gone.url)}${carried('pasted', foreign.url)}`, `<p style="font-family:'${family}'">Hi</p>`),
    )
    await remove(gone)
    const current = await upload(ttf({ family }), 'current.ttf', workspaceId)

    await reboot()
    await expect
      .poll(async () => (await frameOn(canvasId, frameId)).html.includes(current.url), { timeout: 15_000 })
      .toBe(true)
    const html = (await frameOn(canvasId, frameId)).html
    expect(html).not.toContain(gone.url)
    expect(html).toContain(carried('pasted', foreign.url))
  }, 120_000)

  it('leaves another library’s file in a component’s stylesheet as written, through a reboot and the main’s next write', async () => {
    const family = 'Kit Foreign'
    const otherWorkspace = await newWorkspace('Kit Source Co')
    const foreign = await upload(woff2({ family }), 'source.woff2', otherWorkspace)

    const workspaceId = await newWorkspace('Kit Paste Co')
    const own = await upload(woff2({ family }), 'own.woff2', workspaceId)
    expect(own.url).not.toBe(foreign.url)
    const canvasId = await newCanvas('Kit Paste', workspaceId)
    /* a pasted layer's renamed face at the library's own weight and style, loading the other library's file */
    const carried =
      `<style data-doop-carried="ab12cd">@font-face{font-family:"${family}-ab12cd";src:url("${foreign.url}") format("woff2");font-weight:400;font-style:normal}\n` +
      `.chip{font-family:"${family}-ab12cd",sans-serif}</style>`
    const frameId = await newFrame(canvasId, doc(carried, `<span class="chip" data-doop-id="chipone">Chip</span>`))
    const made = await owner.post(`/api/canvases/${canvasId}/components`, { name: 'Chip', frameId, element: 'chipone' })
    expect(made.status, await made.clone().text()).toBe(200)
    const before = (await componentsOf(canvasId))[0]
    expect(before?.css).toContain(foreign.url)

    /* a stale canvas healing stands in for the boot pass being over */
    const signal = await staleFrame('Kit Foreign Signal')
    await reboot()
    await expect
      .poll(async () => (await frameOn(signal.canvasId, signal.frameId)).html.includes(signal.current.url), {
        timeout: 15_000,
      })
      .toBe(true)
    const rebooted = (await componentsOf(canvasId))[0]
    expect(rebooted?.css).toContain(foreign.url)
    expect(rebooted?.css).not.toContain(own.url)
    expect(rebooted?.rev).toBe(before?.rev)

    const stored = (await frameOn(canvasId, frameId)).html
    expect(stored).toContain(foreign.url)
    const patched = await owner.patch(`/api/frames/${frameId}`, {
      html: stored.replace('</body>', '<p>note</p></body>'),
    })
    expect(patched.status).toBe(200)
    const edited = (await componentsOf(canvasId))[0]
    expect(edited?.css).toContain(foreign.url)
    expect(edited?.css).not.toContain(own.url)
    expect(edited?.rev).toBe(before?.rev)
  }, 120_000)
})

describe('a replacing upload', () => {
  it('files no version and keeps sign-off on the frames it rewrites, a library copy’s instance frame included', async () => {
    const workspaceId = await newWorkspace('Swap Keep Co')
    const regular = await upload(woff2({ family: 'Swap Keep' }), 's.woff2', workspaceId)
    const own = await newCanvas('Own', workspaceId)
    const ownFrame = await newFrame(own, doc('', `<p style="font-family:'Swap Keep'">Hi</p>`))
    expect((await frameOn(own, ownFrame)).html).toContain(regular.url)

    const libraryId = await newCanvas('Library', workspaceId)
    const made = await owner.post(`/api/canvases/${libraryId}/components`, {
      name: 'Tag',
      html: '<span class="tag">Tag</span>',
      css: `${fontFaceRule(regular)}\n.tag { font-family: "Swap Keep", sans-serif }`,
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
    const instanceFrame = await newFrame(consumer, doc('', `<doop-use component="${tag.id}"></doop-use>`))
    expect((await owner.put(`/api/canvases/${consumer}/workspace`, { workspaceId: null })).status).toBe(200)

    await signOff(own, ownFrame)
    await signOff(consumer, instanceFrame)
    const versions = { own: await versionsOf(ownFrame), instance: await versionsOf(instanceFrame) }

    const next = await upload(ttf({ family: 'Swap Keep' }), 's2.ttf', workspaceId)
    const ownAfter = await frameOn(own, ownFrame)
    const instanceAfter = await frameOn(consumer, instanceFrame)
    /* the swap reached both, so what follows is about a real rewrite */
    expect(ownAfter.html).toContain(next.url)
    expect(ownAfter.html).not.toContain(regular.url)
    expect(instanceAfter.html).toContain(next.url)
    expect(instanceAfter.html).not.toContain(regular.url)
    expect(ownAfter.approval?.status).toBe('ready_for_dev')
    expect(instanceAfter.approval?.status).toBe('ready_for_dev')
    expect(await versionsOf(ownFrame)).toEqual(versions.own)
    expect(await versionsOf(instanceFrame)).toEqual(versions.instance)
  })
})
