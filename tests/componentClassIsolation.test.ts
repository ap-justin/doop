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

/*
 * Without isolation a frame's own `.sl` rule matches the `sl` element inside a placed Select, since
 * the instance carries the component's markup under the component's class names.
 */
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

describe('isolateClasses', () => {
  const isolate = (template: string, css: string) => isolateClasses({ template, css, rawCss: css }, 'abc')

  it('renames a class wherever a selector names it, compounds included', () => {
    const css = 'span.sl { color: red } .a.b { color: blue } .sl-lg { color: green }'
    const out = isolate('<div class="root"><span class="sl a b">x</span><i class="sl-lg"></i></div>', css)
    expect(out.template).toContain('<span class="sl__in-abc a__in-abc b__in-abc">')
    expect(out.template).toContain('<i class="sl-lg__in-abc">')
    expect(out.css).toBe(
      'span.sl__in-abc { color: red } .a__in-abc.b__in-abc { color: blue } .sl-lg__in-abc { color: green }',
    )
  })

  it('keeps a state class on its compound, with or without a rule of its own', () => {
    const template = '<div class="root"><button class="chip selected">x</button></div>'
    const both = isolate(
      template,
      '.chip { padding: 4px } .chip.selected { color: red } .selected { font-weight: 500 }',
    )
    expect(both.template).toContain('class="chip__in-abc selected__in-abc"')
    expect(both.css).toContain('.chip__in-abc.selected__in-abc { color: red }')
    expect(both.css).toContain('.selected__in-abc { font-weight: 500 }')
    const compoundOnly = isolate(template, '.chip { padding: 4px } .chip.selected { color: red }')
    expect(compoundOnly.template).toContain('class="chip__in-abc selected__in-abc"')
    expect(compoundOnly.css).toContain('.chip__in-abc.selected__in-abc { color: red }')
  })

  it('keeps a class an inline handler reads', () => {
    const out = isolate(
      `<div class="tabs"><button class="tab" onclick="this.closest('.tabs').querySelector('.pane').hidden = false">A</button><div class="pane"></div></div>`,
      '.tab { color: red } .pane { padding: 8px }',
    )
    expect(out.template).toContain('<div class="pane">')
    expect(out.css).toContain('.pane {')
    expect(out.template).toContain('class="tab__in-abc"')
  })

  it('keeps a class a prototype interaction targets', () => {
    const out = isolate(
      `<div class="page"><a data-doop-on="click" data-doop-action="scroll-to:.faq">FAQ</a><a data-doop-interactions='[{"on":"click","action":"scroll-to:.top"}]'>Top</a><section class="faq"></section><header class="top"></header></div>`,
      '.faq { margin: 0 } .top { margin: 0 }',
    )
    expect(out.template).toContain('<section class="faq">')
    expect(out.template).toContain('<header class="top">')
    expect(out).toEqual({ template: out.template, css: '.faq { margin: 0 } .top { margin: 0 }', rawCss: out.rawCss })
  })

  it('keeps a class a <style> inside the template names', () => {
    const out = isolate(
      '<div class="root"><style>.tip:hover { color: red }</style><i class="tip"></i><b class="mark"></b></div>',
      '.tip { color: blue } .mark { color: green }',
    )
    expect(out.template).toContain('<i class="tip">')
    expect(out.template).toContain('<b class="mark__in-abc">')
  })

  it('leaves a nested instance’s classes to its own component', () => {
    const out = isolate(
      '<div class="root"><span class="sl">a</span><div class="row" data-doop-instance="inner"><span class="sl">b</span></div><doop-use component="Btn"><span class="sl">c</span></doop-use></div>',
      '.sl { color: red } .row { gap: 4px }',
    )
    expect(out.template).toContain('<span class="sl__in-abc">a</span>')
    expect(out.template).toContain('<span class="sl">b</span>')
    expect(out.template).toContain('<span class="sl">c</span>')
    expect(out.template).toContain('<div class="row" data-doop-instance="inner">')
  })

  it('changes nothing when fed its own output', () => {
    const once = isolate(
      '<div class="root"><button class="chip selected" onclick="go()">x</button><span class="sl"></span></div>',
      '.chip.selected { color: red } span.sl { color: blue } a[href$=".sl"] { color: green }',
    )
    expect(once.template).toContain('class="chip__in-abc selected__in-abc"')
    expect(isolateClasses(once, 'abc')).toEqual(once)
  })

  it('does not read an escaped or non-ASCII class as its ASCII prefix', () => {
    const out = isolate(
      '<div class="root"><i class="card hover"></i></div>',
      '.card { color: red } .cardé { color: blue } .hover\\:x { color: green } .hover { color: gray }',
    )
    expect(out.css).toBe(
      '.card__in-abc { color: red } .cardé { color: blue } .hover\\:x { color: green } .hover__in-abc { color: gray }',
    )
  })

  it('leaves dots in numbers, strings, comments and url() alone', () => {
    const css =
      '.pdf { opacity: .5; transition: color 1.5s } a[href$=".pdf"] { content: ".pdf" } /* .pdf */ .x { background: url(a.pdf) }'
    const out = isolate('<div class="root"><a class="pdf">x</a></div>', css)
    expect(out.css).toBe(
      '.pdf__in-abc { opacity: .5; transition: color 1.5s } a[href$=".pdf"] { content: ".pdf" } /* .pdf */ .x { background: url(a.pdf) }',
    )
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
