import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client, startServer, type Server } from './harness'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
}))

import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import { blankComponent } from '../server/components.ts'
import { changeInstances } from '../server/componentActions.ts'
import { isolateClasses } from '../server/componentClasses.ts'
import { COMPONENT_ATTR, INSTANCE_ATTR } from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'

/*
 * A frame's own `.sl` rule used to match the `sl` element inside a placed Select, since the
 * instance carries the component's markup under the component's class names.
 */
const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

const doc = (body: string, css = '') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`

const SELECT_CSS = `.select { display: flex; flex-direction: column }
.sl { color: #333; font-size: 12px }
.ctl { border: 1px solid #ccc }`
const FRAME_CSS = '.sl { position: absolute; left: 0 }\n.select { margin: 8px }'

const classesIn = (html: string, tag: RegExp) => [...html.matchAll(tag)].map((match) => match[1]!)
/** The class of the component's label element, in an instance or in its template. */
const labelClass = (html: string) => /<span class="([^"]*)"/.exec(html)![1]!

describe('a placed component and the classes of its frame', () => {
  let canvasId: string
  beforeEach(() => {
    canvasId = store.createCanvas('class isolation').id
  })

  function makeSelect() {
    const def = blankComponent({ name: 'Select', by: 'Tester', props: [] })
    store.saveComponent(canvasId, def)
    const frame = actions.createFrame(canvasId, { name: 'Select main', html: '' }, actor)!
    actions.updateFrame(
      frame.id,
      {
        html: doc(
          `<div class="select" ${COMPONENT_ATTR}="${def.id}"><span class="sl" data-doop-prop="label">Size</span><div class="ctl">M</div></div>`,
          SELECT_CSS,
        ),
      },
      actor,
    )
    return store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!
  }

  function place(defId: string) {
    const page = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
    actions.updateFrame(
      page.id,
      {
        html: doc(
          `<doop-use component="${defId}" label="Pick one" style="width: 200px"></doop-use><p class="sl">Note</p>`,
          FRAME_CSS,
        ),
      },
      actor,
    )
    return page
  }

  it('keeps the frame’s `.sl` rule off the instance’s own `.sl` element', () => {
    const def = makeSelect()
    const html = store.getFrame(place(def.id).id)!.html
    expect(html).toContain(`${INSTANCE_ATTR}="${def.id}"`)
    expect(labelClass(html)).not.toBe('sl')
    /* the frame's own element still wears the frame's class, and its rule is untouched */
    expect(html).toContain('<p class="sl">')
    expect(html).toContain('.sl { position: absolute; left: 0 }')
  })

  it('renames in the template and in the component’s stylesheet alike', () => {
    const def = makeSelect()
    const renamed = labelClass(def.template)
    expect(renamed).toMatch(/^sl__/)
    expect(def.css).toContain(`.${renamed}`)
    expect(def.css).not.toMatch(/\.sl[\s{,:.[]/)
    expect(def.rawCss).toContain(`.${renamed}`)
    /* the instance's outer element keeps its class, so the frame can still place and size it */
    expect(def.template).toMatch(/^<div class="select"/)
    expect(def.css).toContain('.select')
  })

  it('is the same on every write, and a main saved again is not a new revision', () => {
    const def = makeSelect()
    const frame = store.getFrame(def.mainFrameId!)!
    actions.updateFrame(frame.id, { html: `${frame.html} ` }, actor)
    const again = store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!
    expect(again.template).toBe(def.template)
    expect(again.rev).toBe(def.rev)
  })

  it('migrates a definition saved before the rename on the next write of its main', () => {
    const def = makeSelect()
    const plain = (text: string) => text.replaceAll(/__in-\w+/g, '')
    store.saveComponent(canvasId, {
      ...def,
      template: plain(def.template),
      css: plain(def.css),
      rawCss: plain(def.rawCss),
    })
    const frame = store.getFrame(def.mainFrameId!)!
    actions.updateFrame(frame.id, { html: `${frame.html} ` }, actor)
    const migrated = store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!
    expect(labelClass(migrated.template)).toMatch(/^sl__in-/)
    expect(migrated.rev).toBe(def.rev + 1)
  })

  it('leaves a detached instance looking as it did', () => {
    const def = makeSelect()
    const page = place(def.id)
    const html = store.getFrame(page.id)!.html
    const instanceId = new RegExp(`<[^>]*${INSTANCE_ATTR}="${def.id}"[^>]*>`)
      .exec(html)![0]
      .match(/data-doop-id="([^"]+)"/)![1]!
    const renamed = labelClass(html)
    changeInstances(canvasId, page.id, [{ instanceId, detach: true }], actor)
    const detached = store.getFrame(page.id)!.html
    expect(detached).not.toContain(` ${INSTANCE_ATTR}=`)
    expect(labelClass(detached)).toBe(renamed)
    expect(detached).toMatch(new RegExp(`\\.${renamed}[\\s{,]`))
  })

  it('does not rename a class the stylesheet never names, a root class, or one a script uses', () => {
    const out = isolateClasses(
      {
        template: `<div class="card"><span class="card tw-text-sm">a</span><i class="open hit"></i><script>el.classList.add('open')</script></div>`,
        css: '.card .hit { color: red } .open { color: blue }',
        rawCss: '.card .hit { color: red } .open { color: blue }',
      },
      'abc',
    )
    expect(out.template).toContain('<span class="card tw-text-sm">')
    expect(out.template).toContain('class="open hit__in-abc"')
    expect(out.css).toContain('.hit__in-abc')
    expect(out.css).toContain('.open {')
    expect(isolateClasses(out, 'abc')).toEqual(out)
  })
})

describe('a library component placed on another canvas', () => {
  let server: Server
  let owner: Client

  const json = async <T>(res: Response) => (await res.json()) as T

  beforeAll(async () => {
    server = await startServer()
    owner = await new Client(server).signUp('owner@isolation.test', 'Owner')
  }, 60_000)

  afterAll(() => server?.stop())

  it('arrives with its classes renamed, so the consumer’s `.sl` rule does not reach it', async () => {
    const workspaceId = (await json<{ id: string }>(await owner.post('/api/workspaces', { name: 'Team' }))).id
    const make = async (name: string) =>
      (await json<{ id: string }>(await owner.post('/api/canvases', { name, workspaceId }))).id
    const libraryId = await make('Kit')
    const consumerId = await make('App')
    const made = await owner.post(`/api/canvases/${libraryId}/components`, {
      name: 'Select',
      html: '<div class="select"><span class="sl" data-doop-prop="label">Size</span></div>',
      css: '.select { display: flex } .sl { color: #333 }',
    })
    expect(made.status, await made.clone().text()).toBe(200)
    expect((await owner.post(`/api/canvases/${libraryId}/library/publish`, {})).status).toBe(200)
    const frame = await json<{ id: string }>(
      await owner.post(`/api/canvases/${consumerId}/frames`, {
        name: 'Screen',
        html: doc('<doop-use component="Select" label="Pick"></doop-use>', '.sl { position: absolute }'),
      }),
    )
    const canvas = await json<{
      frames: { id: string; html: string }[]
      components: { name: string; css: string }[]
    }>(await owner.get(`/api/canvases/${consumerId}`))
    const html = canvas.frames.find((candidate) => candidate.id === frame.id)!.html
    expect(classesIn(html, /<span class="([^"]*)"/g)[0]).toMatch(/^sl__/)
    expect(canvas.components.find((def) => def.name === 'Select')!.css).toMatch(/\.sl__/)
  })
})
