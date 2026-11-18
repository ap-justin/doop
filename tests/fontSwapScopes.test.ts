import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client, startServer, type Server } from './harness.ts'
import { ttf, woff, woff2 } from './fontFiles.ts'
import { fontFaceRule, type CustomFont } from '../shared/fonts.ts'

/* A replacing upload reaching what carries the old file, on the real server: the person's
   own library, a published workspace library (swapped without a new revision, kept across
   a reboot), a component copy on a canvas that has since left the library's scope, an
   open append stream, and the swap being an annotation (sign-off kept, no version, no
   activity line). */

let server: Server
let owner: Client

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('swap-scopes@test.dev', 'Owner')
}, 70_000)

afterAll(() => server?.stop())

const doc = (head: string, body: string) => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`

function upload(bytes: Buffer, fileName: string, workspace?: string): Promise<CustomFont> {
  return owner
    .req(`/api/fonts${workspace ? `?workspace=${workspace}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(fileName) },
      body: new Uint8Array(bytes),
    })
    .then((res) => res.json())
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
  approval?: { status: string }
}

async function frameOn(client: Client, canvasId: string, frameId: string): Promise<FrameBody> {
  const canvas = await (await client.get(`/api/canvases/${canvasId}`)).json()
  return canvas.frames.find((f: FrameBody) => f.id === frameId)
}

interface Listed {
  id: string
  rev: number
  css: string
}

async function componentsOn(client: Client, canvasId: string): Promise<Listed[]> {
  return (await client.get(`/api/canvases/${canvasId}/components`)).json()
}

describe('the person’s own library', () => {
  it('swaps a replaced face in their personal canvases, and not in another person’s', async () => {
    const regular = await upload(woff2({ family: 'Mine Sans' }), 'm.woff2')
    const mine = await newCanvas('Mine')
    const frameId = await newFrame(mine, doc('', `<p style="font-family:'Mine Sans'">Hi</p>`))
    expect((await frameOn(owner, mine, frameId)).html).toContain(regular.url)

    /* another person's personal canvas whose font block names the same file; their own library
       gets a face covering it only afterwards, so the block is stored as written and a swap
       into it would be the only thing that could change it */
    const other = await new Client(server).signUp('swap-scopes-other@test.dev', 'Other')
    const theirs = (await (await other.post('/api/canvases', { name: 'Theirs' })).json()).id
    const block = `<style data-doop-fonts>\n${fontFaceRule(regular)}\n</style>`
    const theirFrame = (
      await (
        await other.post(`/api/canvases/${theirs}/frames`, {
          name: 'F',
          html: doc(block, `<p style="font-family:'Mine Sans'">Theirs</p>`),
        })
      ).json()
    ).id
    const covering = await (
      await other.req('/api/fonts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'covering.ttf' },
        body: new Uint8Array(ttf({ family: 'Mine Sans' })),
      })
    ).json()
    expect(covering.family).toBe('Mine Sans')
    const theirsBefore = (await frameOn(other, theirs, theirFrame)).html
    expect(theirsBefore).toContain(regular.url)

    const next = await upload(ttf({ family: 'Mine Sans' }), 'm2.ttf')
    expect(next.url).not.toBe(regular.url)
    const after = (await frameOn(owner, mine, frameId)).html
    expect(after).toContain(next.url)
    expect(after).not.toContain(regular.url)
    expect((await frameOn(other, theirs, theirFrame)).html).toBe(theirsBefore)
  })
})

describe('a replacement stays in its own library', () => {
  /** a canvas of `holder` whose block names `named`'s file, then a covering face in `holder`'s own
   *  library (added after, so the block is stored as written); returns what to read back */
  async function untouchedHolder(holderWorkspace: string | undefined, named: CustomFont, family: string) {
    const canvasId = await newCanvas('Holder', holderWorkspace)
    const frameId = await newFrame(
      canvasId,
      doc(`<style data-doop-fonts>\n${fontFaceRule(named)}\n</style>`, `<p style="font-family:'${family}'">Hi</p>`),
    )
    await upload(woff({ family }), 'covering.woff', holderWorkspace)
    const before = (await frameOn(owner, canvasId, frameId)).html
    expect(before).toContain(named.url)
    return async () => ({ before, after: (await frameOn(owner, canvasId, frameId)).html })
  }

  it('leaves the owner’s workspace canvas alone when a personal face is replaced', async () => {
    const workspaceId = await newWorkspace('Scope Co')
    const personal = await upload(woff2({ family: 'Scope Sans' }), 'sp.woff2')
    const read = await untouchedHolder(workspaceId, personal, 'Scope Sans')

    const next = await upload(ttf({ family: 'Scope Sans' }), 'sp2.ttf')
    expect(next.url).not.toBe(personal.url)
    const { before, after } = await read()
    expect(after).toBe(before)
  })

  it('leaves another workspace’s canvas alone when a workspace face is replaced', async () => {
    const replacedIn = await newWorkspace('Replaced Co')
    const otherWorkspace = await newWorkspace('Bystander Co')
    const face = await upload(woff2({ family: 'Bystand Sans' }), 'bs.woff2', replacedIn)
    const read = await untouchedHolder(otherWorkspace, face, 'Bystand Sans')

    const next = await upload(ttf({ family: 'Bystand Sans' }), 'bs2.ttf', replacedIn)
    expect(next.url).not.toBe(face.url)
    const { before, after } = await read()
    expect(after).toBe(before)
  })
})

describe('a swap is an annotation', () => {
  it('keeps sign-off, files no version and no activity line, and tells the room', async () => {
    const workspaceId = await newWorkspace('Annotation Co')
    const regular = await upload(woff2({ family: 'Note Sans' }), 'n.woff2', workspaceId)
    const canvasId = await newCanvas('Note', workspaceId)
    const frameId = await newFrame(canvasId, doc('', `<p style="font-family:'Note Sans'">Hi</p>`))
    const frame = await frameOn(owner, canvasId, frameId)
    expect(frame.html).toContain(regular.url)
    const signed = await owner.put(`/api/frames/${frameId}/approval`, {
      status: 'ready_for_dev',
      expectedUpdatedAt: (await owner.get(`/api/canvases/${canvasId}`).then((r) => r.json())).frames[0].updatedAt,
    })
    expect(signed.status, await signed.clone().text()).toBe(200)

    const versionsBefore = await (await owner.get(`/api/frames/${frameId}/versions`)).json()
    const room = await joinRoom(canvasId)
    try {
      const activityBefore = room.activity.length
      const next = await upload(ttf({ family: 'Note Sans' }), 'n2.ttf', workspaceId)
      await expect
        .poll(async () => (await frameOn(owner, canvasId, frameId)).html.includes(next.url), { timeout: 10_000 })
        .toBe(true)

      const after = await frameOn(owner, canvasId, frameId)
      expect(after.html).not.toContain(regular.url)
      expect(after.approval?.status).toBe('ready_for_dev')
      expect(await (await owner.get(`/api/frames/${frameId}/versions`)).json()).toEqual(versionsBefore)
      expect(room.activity.length).toBe(activityBefore)
      const live = room.updates.find((m) => m.frame.id === frameId)
      expect(live?.frame.html).toContain(next.url)

      /* the same read is live: a person's edit files exactly one version (the swapped
         document it replaced, so the swap filed none of its own) and drops the sign-off */
      const versionsOf = async () => (await (await owner.get(`/api/frames/${frameId}/versions`)).json()) as { id: string }[]
      const edited = await owner.patch(`/api/frames/${frameId}`, { html: '<main>A different screen</main>' })
      expect(edited.status).toBe(200)
      await expect.poll(async () => (await versionsOf()).length, { timeout: 10_000 }).toBeGreaterThan(versionsBefore.length)
      const filed = await versionsOf()
      expect(filed).toHaveLength(versionsBefore.length + 1)
      const replaced = await (await owner.get(`/api/frames/${frameId}/versions/${filed[0]!.id}`)).json()
      expect(replaced.html).toContain(next.url)
      expect(replaced.html).not.toContain(regular.url)
      expect((await frameOn(owner, canvasId, frameId)).approval?.status).toBe('needs_review')
    } finally {
      room.close()
    }
  })

  it('a person’s edit, by contrast, files a version', async () => {
    const workspaceId = await newWorkspace('Edit Co')
    await upload(woff2({ family: 'Edit Sans' }), 'e.woff2', workspaceId)
    const canvasId = await newCanvas('Edit', workspaceId)
    const frameId = await newFrame(canvasId, doc('', `<p style="font-family:'Edit Sans'">Hi</p>`))
    const before = (await (await owner.get(`/api/frames/${frameId}/versions`)).json()) as unknown[]
    const patched = await owner.patch(`/api/frames/${frameId}`, { html: '<main>A different screen</main>' })
    expect(patched.status).toBe(200)
    const versions = async () => (await (await owner.get(`/api/frames/${frameId}/versions`)).json()) as unknown[]
    await expect.poll(async () => (await versions()).length, { timeout: 10_000 }).toBeGreaterThan(before.length)
  })
})

describe('an open append stream', () => {
  it('is left alone by the swap and takes the library’s face with its done chunk', async () => {
    const workspaceId = await newWorkspace('Stream Co')
    const regular = await upload(woff2({ family: 'Flow Sans' }), 'f.woff2', workspaceId)
    const canvasId = await newCanvas('Stream', workspaceId)
    const frameId = await newFrame(canvasId, doc('', '<p>Seed</p>'))
    const head = doc(
      `<style data-doop-fonts>\n${fontFaceRule(regular)}\n</style>`,
      `<p style="font-family:'Flow Sans'">Hi`,
    )
    const started = await owner.post(`/api/frames/${frameId}/append`, { html_chunk: head, start: true })
    expect(started.status).toBe(200)

    const next = await upload(ttf({ family: 'Flow Sans' }), 'f2.ttf', workspaceId)
    /* the swap is synchronous with the upload for a loaded canvas: nothing to wait for */
    expect((await frameOn(owner, canvasId, frameId)).html).toContain(regular.url)
    expect((await frameOn(owner, canvasId, frameId)).html).not.toContain(next.url)

    const done = await owner.post(`/api/frames/${frameId}/append`, { html_chunk: '</p>', done: true })
    expect(done.status).toBe(200)
    const settled = (await frameOn(owner, canvasId, frameId)).html
    expect(settled).toContain(next.url)
    expect(settled).not.toContain(regular.url)
  })
})

describe('components carrying a replaced face', () => {
  const button = (regular: CustomFont) => ({
    name: 'Tag',
    html: '<span class="tag">Tag</span>',
    css: `${fontFaceRule(regular)}\n.tag { font-family: "Pub Sans", sans-serif }`,
  })
  const importFrom = (consumerId: string, libraryId: string, component: string) =>
    owner.post(`/api/canvases/${consumerId}/components/import`, { sourceCanvasId: libraryId, component })

  it('swaps a published snapshot without a new revision, and keeps it across a reboot', async () => {
    const workspaceId = await newWorkspace('Pub Co')
    const regular = await upload(woff2({ family: 'Pub Sans' }), 'p.woff2', workspaceId)
    const libraryId = await newCanvas('Library', workspaceId)
    const made = await owner.post(`/api/canvases/${libraryId}/components`, button(regular))
    expect(made.status, await made.clone().text()).toBe(200)
    const tag = (await made.json()).component as { id: string }
    expect((await owner.post(`/api/canvases/${libraryId}/library/publish`, {})).status).toBe(200)
    const revOf = async () => {
      const libs = (await (
        await owner.get(`/api/canvases/${await newCanvas('Probe', workspaceId)}/component-libraries`)
      ).json()) as {
        id: string
        library?: boolean
        components: { id: string; rev: number }[]
      }[]
      return libs.find((lib) => lib.id === libraryId && lib.library)!.components.find((c) => c.id === tag.id)!.rev
    }
    const publishedRev = await revOf()

    const next = await upload(ttf({ family: 'Pub Sans' }), 'p2.ttf', workspaceId)
    expect(await revOf()).toBe(publishedRev)

    /* what a canvas takes from the snapshot now: the new file */
    const taker = await newCanvas('Taker', workspaceId)
    expect((await importFrom(taker, libraryId, tag.id)).status).toBe(200)
    const taken = (await componentsOn(owner, taker))[0]!
    expect(taken.css).toContain(next.url)
    expect(taken.css).not.toContain(regular.url)

    /* persisted: a rebooted server hands out the same snapshot */
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer({ PORT: String(server.port) }, server.dataDir)
    const again = await newCanvas('After reboot', workspaceId)
    expect((await importFrom(again, libraryId, tag.id)).status).toBe(200)
    const reread = (await componentsOn(owner, again))[0]!
    expect(reread.css).toContain(next.url)
    expect(reread.css).not.toContain(regular.url)
  }, 90_000)

  it('carries the new file into the stylesheet an instance brings to its frame', async () => {
    const workspaceId = await newWorkspace('Instance Co')
    const regular = await upload(woff2({ family: 'Kit Sans' }), 'k.woff2', workspaceId)
    const canvasId = await newCanvas('Kit', workspaceId)
    const made = await owner.post(`/api/canvases/${canvasId}/components`, {
      name: 'Chip',
      html: '<span class="chip">Chip</span>',
      css: `${fontFaceRule(regular)}\n.chip { font-family: "Kit Sans", sans-serif }`,
    })
    expect(made.status, await made.clone().text()).toBe(200)
    const chip = (await made.json()).component as { id: string }
    const frameId = await newFrame(canvasId, doc('', `<doop-use component="${chip.id}"></doop-use>`))
    const block = (html: string) =>
      new RegExp(`<style[^>]*data-doop-component-css="${chip.id}"[^>]*>([\\s\\S]*?)</style>`).exec(html)?.[1] ?? ''
    expect(block((await frameOn(owner, canvasId, frameId)).html)).toContain(regular.url)

    const next = await upload(ttf({ family: 'Kit Sans' }), 'k2.ttf', workspaceId)
    const after = (await frameOn(owner, canvasId, frameId)).html
    expect(block(after)).toContain(next.url)
    expect(after).not.toContain(regular.url)
  })

  it('swaps a library copy on a canvas that has left the workspace', async () => {
    const workspaceId = await newWorkspace('Carry Co')
    const regular = await upload(woff2({ family: 'Pub Sans' }), 'c.woff2', workspaceId)
    const libraryId = await newCanvas('Library', workspaceId)
    const made = await owner.post(`/api/canvases/${libraryId}/components`, button(regular))
    const tag = (await made.json()).component as { id: string }
    expect((await owner.post(`/api/canvases/${libraryId}/library/publish`, {})).status).toBe(200)
    const consumer = await newCanvas('Consumer', workspaceId)
    expect((await importFrom(consumer, libraryId, tag.id)).status).toBe(200)
    const copy = (await componentsOn(owner, consumer))[0]!
    expect(copy.css).toContain(regular.url)
    expect((await owner.put(`/api/canvases/${consumer}/workspace`, { workspaceId: null })).status).toBe(200)

    const next = await upload(ttf({ family: 'Pub Sans' }), 'c2.ttf', workspaceId)
    const swapped = (await componentsOn(owner, consumer))[0]!
    expect(swapped.css).toContain(next.url)
    expect(swapped.css).not.toContain(regular.url)
    expect(swapped.rev).toBe(copy.rev)
  })
})

interface Room {
  activity: unknown[]
  updates: { frame: { id: string; html: string } }[]
  close(): void
}

/** a room connection that keeps the init's activity feed and every frame:updated since */
function joinRoom(canvasId: string): Promise<Room> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
    const room: Room = { activity: [], updates: [], close: () => ws.close() }
    const timer = setTimeout(() => reject(new Error('ws join timed out')), 8000)
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'join', canvasId, clientId: `s-${Math.random()}`, name: 't', kind: 'user' })),
    )
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data))
      if (msg.type === 'init') {
        clearTimeout(timer)
        room.activity = msg.activity
        resolve(room)
      } else if (msg.type === 'activity') room.activity = [...room.activity, msg.item]
      else if (msg.type === 'frame:updated') room.updates.push(msg)
    })
    ws.on('error', reject)
  })
}
