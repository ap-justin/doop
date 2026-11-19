import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
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
import { blankComponent, contextFor } from '../server/components.ts'
import { compactDocument } from '../server/componentEngine.ts'
import {
  changeInstances,
  deleteComponent,
  lookalikesIn,
  restoreComponent,
  restoreComponentVersion,
  updateComponent,
} from '../server/componentActions.ts'
import { isolateClasses, withNaturalFrameStyles } from '../server/componentClasses.ts'
import { COMPONENT_ATTR, CSS_ATTR, INSTANCE_ATTR } from '../shared/components.ts'
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
    expect(labelClass(html)).toBe(`sl__in-${def.id}`)
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
    /* the root's class is the component's own too, once its stylesheet names it */
    expect(def.template).toMatch(new RegExp(`^<div class="select__in-${def.id}"`))
    const selectRule = def.css
      .split('\n')
      .find((line) => line.includes('.select__in-') && line.includes('display: flex'))
    expect(selectRule).toContain('{ display: flex; flex-direction: column }')
    expect(def.css).not.toMatch(/\.select[\s{,:.[]/)
    expect(def.rawCss).not.toMatch(/\.select[\s{,:.[]/)
  })

  it('is the same on every write, and a main saved again is not a new revision', () => {
    const def = makeSelect()
    const frame = store.getFrame(def.mainFrameId!)!
    actions.updateFrame(frame.id, { html: `${frame.html} ` }, actor)
    const again = store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!
    const stored = (candidate: typeof def) => ({
      template: candidate.template,
      css: candidate.css,
      rawCss: candidate.rawCss,
      head: candidate.head,
      props: candidate.props,
      slots: candidate.slots,
      rev: candidate.rev,
    })
    expect(stored(again)).toEqual(stored(def))
  })

  it('wears the renamed class on an instance beside its own main, and its rule reaches that frame', () => {
    const def = makeSelect()
    const frame = store.getFrame(def.mainFrameId!)!
    const withUse = frame.html.replace('</body>', `<doop-use component="${def.id}" label="Again"></doop-use></body>`)
    actions.updateFrame(frame.id, { html: withUse }, actor)
    const html = store.getFrame(frame.id)!.html
    /* the main keeps the name its own sheet styles; the instance wears the renamed one */
    expect(classesIn(html, /<span class="([^"]*)"/g)).toEqual(['sl', `sl__in-${def.id}`])
    const sheet = new RegExp(`<style ${CSS_ATTR}="${def.id}">\n([\\s\\S]*?)\n</style>`).exec(html)![1]!
    expect(sheet).toBe(def.css)
    const rule = sheet.split('\n').find((line) => line.includes(`.sl__in-${def.id}`) && line.includes('color: #333'))
    expect(rule).toContain('{ color: #333; font-size: 12px }')
    /* an instance beside the main is not a change to the component */
    const after = store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!
    expect(after.template).toBe(def.template)
    expect(after.rev).toBe(def.rev)
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
    expect(labelClass(migrated.template)).toBe(`sl__in-${def.id}`)
    expect(migrated.rev).toBe(def.rev + 1)
  })

  it('leaves an old-style definition and its placed instance alone until its main is written, then renames all three parts', () => {
    const def = makeSelect()
    const page = place(def.id)
    const placed = store.getFrame(page.id)!.html
    const plain = (text: string) => text.replaceAll(/__in-\w+/g, '')
    store.saveComponent(canvasId, {
      ...def,
      template: plain(def.template),
      css: plain(def.css),
      rawCss: plain(def.rawCss),
    })
    const old = store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!
    expect(old.template).toBe(plain(def.template))
    expect(old.css).toBe(plain(def.css))
    expect(old.rawCss).toBe(plain(def.rawCss))
    expect(old.css).not.toContain('__in-')
    expect(store.getFrame(page.id)!.html).toBe(placed)

    const frame = store.getFrame(def.mainFrameId!)!
    actions.updateFrame(frame.id, { html: `${frame.html} ` }, actor)
    const migrated = store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!
    expect(migrated.template).toBe(def.template)
    expect(migrated.css).toBe(def.css)
    expect(migrated.rawCss).toBe(def.rawCss)
    expect(migrated.css).toContain(`.sl__in-${def.id}`)
    expect(migrated.rawCss).toContain(`.sl__in-${def.id}`)
  })

  const rootClasses = (html: string, id: string) =>
    (new RegExp(`<div class="([^"]*)"[^>]*${INSTANCE_ATTR}="${id}"`).exec(html)?.[1] ?? '').split(' ')

  it('keeps the frame’s rule for the root’s class off a placed instance’s root', () => {
    const def = makeSelect()
    const html = store.getFrame(place(def.id).id)!.html
    /* the frame styles `.select` too (FRAME_CSS), and the component's own rule names it */
    expect(rootClasses(html, def.id)).toEqual([`select__in-${def.id}`])
  })

  it('keeps a class put on the placed instance as written, so the frame can still size it', () => {
    const def = makeSelect()
    const page = actions.createFrame(canvasId, { name: 'Sized', html: '' }, actor)!
    actions.updateFrame(
      page.id,
      {
        html: doc(
          `<doop-use component="${def.id}" class="wide" label="Pick"></doop-use>`,
          '.wide { width: 320px } .select { margin: 8px }',
        ),
      },
      actor,
    )
    const html = store.getFrame(page.id)!.html
    expect(rootClasses(html, def.id)).toEqual([`select__in-${def.id}`, 'wide'])
    actions.updateFrame(page.id, { html: `${html} ` }, actor)
    expect(rootClasses(store.getFrame(page.id)!.html, def.id)).toEqual([`select__in-${def.id}`, 'wide'])
  })

  describe('a class put on the instance, through an upgrade', () => {
    const current = (id: string) => store.getComponents(canvasId).find((candidate) => candidate.id === id)!
    const pageHtml = (id: string) => store.getFrame(id)!.html
    /* a write of the page upgrades its instances whether or not propagation has reached it yet */
    const rewrite = (id: string) => actions.updateFrame(id, { html: `${pageHtml(id)} ` }, actor)

    it('keeps it beside the root’s class when the main’s next write renames that class', () => {
      const def = makeSelect()
      const plain = (text: string) => text.replaceAll(/__in-\w+/g, '')
      store.saveComponent(canvasId, {
        ...def,
        template: plain(def.template),
        css: plain(def.css),
        rawCss: plain(def.rawCss),
      })
      const page = actions.createFrame(canvasId, { name: 'Sized', html: '' }, actor)!
      actions.updateFrame(
        page.id,
        {
          html: doc(`<doop-use component="${def.id}" class="wide" label="Pick"></doop-use>`, '.wide { width: 320px }'),
        },
        actor,
      )
      expect(rootClasses(pageHtml(page.id), def.id)).toEqual(['select', 'wide'])

      const main = store.getFrame(def.mainFrameId!)!
      actions.updateFrame(main.id, { html: `${main.html} ` }, actor)
      expect(current(def.id).rev).toBe(def.rev + 1)
      rewrite(page.id)
      const upgraded = pageHtml(page.id)
      expect(rootClasses(upgraded, def.id)).toEqual([`select__in-${def.id}`, 'wide'])

      /* the same markup again, at the same revision: nothing moves */
      actions.updateFrame(page.id, { html: upgraded }, actor)
      expect(pageHtml(page.id)).toBe(upgraded)
    })

    it('takes a class the root gained and keeps one the instance took away gone', () => {
      const def = blankComponent({ name: 'Box', by: 'Tester', props: [] })
      store.saveComponent(canvasId, def)
      const main = actions.createFrame(canvasId, { name: 'Box main', html: '' }, actor)!
      const css = '.box { display: flex } .boxed { border: 1px solid } .raised { box-shadow: 0 1px 2px }'
      actions.updateFrame(
        main.id,
        { html: doc(`<div class="box boxed" ${COMPONENT_ATTR}="${def.id}"><b>Box</b></div>`, css) },
        actor,
      )
      const page = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
      actions.updateFrame(page.id, { html: doc(`<doop-use component="${def.id}"></doop-use>`) }, actor)
      const id = def.id
      expect(rootClasses(pageHtml(page.id), id)).toEqual([`box__in-${id}`, `boxed__in-${id}`])
      /* edited by hand on the page: `boxed` taken off, `wide` put on */
      actions.updateFrame(
        page.id,
        { html: pageHtml(page.id).replace(`class="box__in-${id} boxed__in-${id}"`, `class="box__in-${id} wide"`) },
        actor,
      )
      expect(rootClasses(pageHtml(page.id), id)).toEqual([`box__in-${id}`, 'wide'])
      const rev = current(id).rev

      /* the main as stored, part keys and all, so the root keeps its key across the revision */
      const stored = store.getFrame(main.id)!.html
      actions.updateFrame(main.id, { html: stored.replace('class="box boxed"', 'class="box boxed raised"') }, actor)
      expect(current(id).rev).toBe(rev + 1)
      rewrite(page.id)
      expect(rootClasses(pageHtml(page.id), id)).toEqual([`box__in-${id}`, `raised__in-${id}`, 'wide'])
    })

    it('reads back as the class it was given, not as an override spelling the root’s classes', () => {
      const def = makeSelect()
      const page = actions.createFrame(canvasId, { name: 'Sized', html: '' }, actor)!
      actions.updateFrame(
        page.id,
        { html: doc(`<doop-use component="${def.id}" class="wide" label="Pick"></doop-use>`) },
        actor,
      )
      const compact = compactDocument(pageHtml(page.id), contextFor(canvasId))
      expect(compact).toMatch(/<doop-use [^>]*class="wide"/)
      expect(compact).not.toContain(`__in-${def.id}`)
    })
  })

  it('reports a hand-drawn copy on natural names as a lookalike of a component stored on renamed ones', () => {
    const def = makeSelect()
    expect(def.template).toContain(`select__in-${def.id}`)
    const copy = '<div class="select"><span class="sl">Size</span><div class="ctl">M</div></div>'
    const drawn = actions.createFrame(canvasId, { name: 'Drawn', html: '' }, actor)!
    actions.updateFrame(drawn.id, { html: doc(`<main>${copy}${copy}</main>`) }, actor)
    expect(lookalikesIn(store.getFrame(drawn.id)!)).toEqual([
      { component: 'Select', occurrences: 2, usage: expect.any(String) },
    ])
  })

  it('keeps the main in its own frame on natural root names, with no new revision on a re-save', () => {
    const def = makeSelect()
    /* plain values: the store may update a definition in place, which would make `def` and `again` one object */
    const { rev, template, css } = def
    const frame = store.getFrame(def.mainFrameId!)!
    expect(frame.html).toContain('<div class="select"')
    actions.updateFrame(frame.id, { html: `${frame.html} ` }, actor)
    const renamed = frame.html.replace('class="select"', `class="select__in-${def.id}"`)
    actions.updateFrame(frame.id, { html: renamed }, actor)
    const again = store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!
    expect(again.rev).toBe(rev)
    expect(again.template).toBe(template)
    expect(again.css).toBe(css)
    const stored = store.getFrame(frame.id)!.html
    expect(stored).toContain('<div class="select"')
    expect(stored).not.toContain('__in-')
  })

  it('lets a parent component’s rule reach a nested component’s root, which wears its renamed class', () => {
    const button = blankComponent({ name: 'Button', by: 'Tester', props: [] })
    store.saveComponent(canvasId, button)
    const buttonFrame = actions.createFrame(canvasId, { name: 'Button main', html: '' }, actor)!
    actions.updateFrame(
      buttonFrame.id,
      {
        html: doc(`<button class="btn" ${COMPONENT_ATTR}="${button.id}">Go</button>`, '.btn { display: inline-flex }'),
      },
      actor,
    )
    const plan = blankComponent({ name: 'Plan', by: 'Tester', props: [] })
    store.saveComponent(canvasId, plan)
    const planFrame = actions.createFrame(canvasId, { name: 'Plan main', html: '' }, actor)!
    actions.updateFrame(
      planFrame.id,
      {
        html: doc(
          `<div class="plan" ${COMPONENT_ATTR}="${plan.id}"><doop-use component="${button.id}"></doop-use></div>`,
          '.plan { padding: 8px } .plan .btn { width: 100% }',
        ),
      },
      actor,
    )
    const planDef = store.getComponents(canvasId).find((candidate) => candidate.id === plan.id)!
    const btn = `btn__in-${button.id}`
    /* the sheet names the nested root's renamed class, so it is kept and matches the Button inside a Plan */
    expect(planDef.rawCss).toContain(`.plan__in-${plan.id} .${btn} { width: 100% }`)
    const page = actions.createFrame(canvasId, { name: 'Pricing', html: '' }, actor)!
    actions.updateFrame(
      page.id,
      { html: doc(`<doop-use component="${plan.id}"></doop-use>`, '.btn { width: 10px }') },
      actor,
    )
    const html = store.getFrame(page.id)!.html
    const planBlock = new RegExp(`<style data-doop-component-css="${plan.id}">[\\s\\S]*?</style>`).exec(html)![0]
    expect(planBlock).toContain(`:where([data-doop-instance="${plan.id}"]) .${btn}`)
    expect(html).toMatch(
      new RegExp(`<div class="plan__in-${plan.id}"[^>]*${INSTANCE_ATTR}="${plan.id}"[\\s\\S]*<button class="${btn}"`),
    )
    /* and the frame's own `.btn` rule does not */
    expect(html).not.toMatch(/<button class="btn"/)
  })

  /** A Plan whose main holds a Button, the Plan's sheet styling `.plan .btn`; the Plan's own frame. */
  function planWithButton(extraCss = '') {
    const button = blankComponent({ name: 'Button', by: 'Tester', props: [] })
    store.saveComponent(canvasId, button)
    const buttonFrame = actions.createFrame(canvasId, { name: 'Button main', html: '' }, actor)!
    actions.updateFrame(
      buttonFrame.id,
      {
        html: doc(`<button class="btn" ${COMPONENT_ATTR}="${button.id}">Go</button>`, '.btn { display: inline-flex }'),
      },
      actor,
    )
    const plan = blankComponent({ name: 'Plan', by: 'Tester', props: [] })
    store.saveComponent(canvasId, plan)
    const planFrame = actions.createFrame(canvasId, { name: 'Plan main', html: '' }, actor)!
    actions.updateFrame(
      planFrame.id,
      {
        html: doc(
          `<div class="plan" ${COMPONENT_ATTR}="${plan.id}"><doop-use component="${button.id}"></doop-use></div><div class="plan"><i class="btn">plain</i></div>`,
          `.plan { padding: 8px } .plan .btn { width: 100% }${extraCss}`,
        ),
      },
      actor,
    )
    return { button, plan, planFrame }
  }
  const mainCssBlock = (html: string, id: string) =>
    new RegExp(`<style data-doop-main-css="${id}">\\n([\\s\\S]*?)\\n</style>`).exec(html)

  it('writes the parent’s nested-root rules into its own main frame, where they match the nested instance', () => {
    const { button, plan, planFrame } = planWithButton()
    const html = store.getFrame(planFrame.id)!.html
    const block = mainCssBlock(html, plan.id)
    expect(block, html).not.toBeNull()
    /* before the frame's own styles, which stay in natural names */
    expect(html.indexOf('data-doop-main-css')).toBeLessThan(html.indexOf('<style>'))
    expect(html).toContain('.plan .btn { width: 100% }')
    const window = new Window()
    window.document.write(html)
    const nested = window.document.querySelector(`[${INSTANCE_ATTR}="${button.id}"]`)!
    const plain = window.document.querySelector('i.btn')!
    const selectors = [...block![1]!.matchAll(/([^{}]+)\{/g)].flatMap((rule) => rule[1]!.split(','))
    expect(selectors.length).toBeGreaterThan(0)
    /* a rule that reaches the Button inside the Plan, and none that reaches a plain `.btn` */
    const matches = (selector: string) => [...window.document.querySelectorAll(selector.trim())]
    expect(selectors.some((selector) => matches(selector).includes(nested))).toBe(true)
    for (const selector of selectors) expect(matches(selector)).not.toContain(plain)
  })

  it('files no new revision when that main is saved again, and never reads the block back as the author’s CSS', () => {
    const { plan, planFrame } = planWithButton()
    const before = store.getComponents(canvasId).find((candidate) => candidate.id === plan.id)!
    const frame = store.getFrame(planFrame.id)!
    actions.updateFrame(planFrame.id, { html: `${frame.html} ` }, actor)
    const after = store.getComponents(canvasId).find((candidate) => candidate.id === plan.id)!
    expect(after.rev).toBe(before.rev)
    expect(after.css).toBe(before.css)
    expect(after.rawCss).toBe(before.rawCss)
    expect(store.getFrame(planFrame.id)!.html.match(/data-doop-main-css/g)).toHaveLength(1)
  })

  it('removes the block when the main leaves the frame', () => {
    const { plan, planFrame } = planWithButton()
    const html = store.getFrame(planFrame.id)!.html
    const plain = html.replace(new RegExp(`\\s${COMPONENT_ATTR}="${plan.id}"`), '')
    actions.updateFrame(planFrame.id, { html: plain }, actor)
    expect(store.getFrame(planFrame.id)!.html).not.toContain('data-doop-main-css')
  })

  it('says which frames’ own rules stop reaching a main whose root class is renamed', () => {
    const plan = makeSelect()
    const page = actions.createFrame(canvasId, { name: 'Landing', html: '' }, actor)!
    actions.updateFrame(
      page.id,
      { html: doc(`<doop-use component="${plan.id}" label="Pick"></doop-use>`, '.select { grid-column: span 2 }') },
      actor,
    )
    /* the component was made before its root class was renamed: write its main again with an old-style definition */
    const stale = { ...plan, template: plan.template.replace(`select__in-${plan.id}`, 'select') }
    store.saveComponent(canvasId, stale)
    const main = store.getFrame(plan.mainFrameId!)!
    actions.takeComponentIssues(main.id)
    actions.updateFrame(main.id, { html: `${main.html} ` }, actor)
    const note = actions.takeComponentIssues(main.id).find((issue) => issue.code === 'root_class_renamed')
    expect(note?.message).toContain('“Landing” (.select)')
    expect(note?.message).toContain('class="your-class"')
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

  /*
   * The main in its frame wears natural names (`sl`), which its frame's sheet styles; the stored
   * definition and get_component carry the renamed ones. A main written back from the stored text
   * must not splice `sl__in-<id>` beside a `.sl` rule: the next derivation would drop the rule and
   * every instance would lose its styling.
   */
  describe('a main written from the stored definition', () => {
    const current = (id: string) => store.getComponents(canvasId).find((candidate) => candidate.id === id)!
    const mainHtml = (id: string) => store.getFrame(current(id).mainFrameId!)!.html
    const labelRule = (def: { id: string; css: string }) =>
      def.css.split('\n').find((line) => line.includes(`.sl__in-${def.id},`) && line.includes('color: #333'))!

    function expectStyledAndNatural(before: ReturnType<typeof makeSelect>) {
      const after = current(before.id)
      expect(labelClass(after.template).split(' ')[0]).toBe(`sl__in-${before.id}`)
      expect(after.css.split('\n')).toContain(labelRule(before))
      expect(labelClass(mainHtml(before.id)).split(' ')[0]).toBe('sl')
      expect(mainHtml(before.id).includes(`__in-${before.id}`)).toBe(false)
    }

    it('keeps the styling through a props-only update', () => {
      const def = makeSelect()
      expect(labelRule(def)).toContain('{ color: #333; font-size: 12px }')
      /* the props it already has: `[]` would remove the `label` prop the markup binds, a new revision */
      updateComponent(canvasId, def.id, { props: def.props }, actor)
      expectStyledAndNatural(def)
      expect(current(def.id).css).toBe(def.css)
      expect(current(def.id).template).toBe(def.template)
      expect(current(def.id).rev).toBe(def.rev)
    })

    it('keeps the styling through find and replace with find copied from the stored template', () => {
      const def = makeSelect()
      const find = `class="sl__in-${def.id}"`
      updateComponent(canvasId, def.id, { find, replace: `class="sl__in-${def.id} wide"` }, actor)
      expectStyledAndNatural(def)
      expect(labelClass(current(def.id).template)).toBe(`sl__in-${def.id} wide`)
      expect(labelClass(mainHtml(def.id))).toBe('sl wide')
      expect(current(def.id).css).toBe(def.css)
    })

    it('keeps the styling when html and css are taken from get_component', () => {
      const def = makeSelect()
      updateComponent(canvasId, def.id, { html: def.template, css: def.rawCss }, actor)
      expectStyledAndNatural(def)
    })

    it('keeps the styling when a version is restored', () => {
      const def = makeSelect()
      updateComponent(canvasId, def.id, { find: '>Size<', replace: '>Width<' }, actor)
      expect(current(def.id).rev).toBe(def.rev + 1)
      restoreComponentVersion(canvasId, def.id, def.rev, actor)
      expectStyledAndNatural(def)
      expect(current(def.id).template).toBe(def.template)
    })

    it('keeps the styling when a deleted component whose main is gone is restored', () => {
      const def = makeSelect()
      deleteComponent(canvasId, def.id, actor)
      actions.deleteFrame(def.mainFrameId!, actor)
      expect(restoreComponent(canvasId, def.id, actor).main).toBe('written')
      expectStyledAndNatural(def)
      expect(current(def.id).css).toBe(def.css)
    })

    it('derives the same definition from a main written with renamed names, with no new revision', () => {
      const def = makeSelect()
      const frame = store.getFrame(def.mainFrameId!)!
      /* the store's frame object is updated in place, so each rewrite starts from this copy */
      const written = frame.html
      const markup = (html: string) =>
        html.replace('class="sl"', `class="sl__in-${def.id}"`).replace('class="ctl"', `class="ctl__in-${def.id}"`)
      const sheet = (html: string) =>
        html.replace('.sl {', `.sl__in-${def.id} {`).replace('.ctl {', `.ctl__in-${def.id} {`)
      for (const rewrite of [markup, sheet, (html: string) => sheet(markup(html))]) {
        const html = rewrite(written)
        expect(html).not.toBe(written)
        actions.updateFrame(frame.id, { html }, actor)
        const again = current(def.id)
        expect(again.template).toBe(def.template)
        expect(again.css).toBe(def.css)
        expect(again.rawCss).toBe(def.rawCss)
        expect(again.rev).toBe(def.rev)
        /* the main in its frame wears natural names, which the frame's own rule styles */
        const stored = store.getFrame(frame.id)!.html
        expect(stored).not.toContain('__in-')
        expect(stored).toContain('class="sl"')
        expect(stored).toMatch(/\.sl \{/)
      }
    })

    it('keeps the renamed names in the stylesheet of an instance placed in the main’s own frame', () => {
      const def = makeSelect()
      const frame = store.getFrame(def.mainFrameId!)!
      const instance = `<doop-use component="${def.id}" label="Again"></doop-use>`
      actions.updateFrame(frame.id, { html: frame.html.replace('</body>', `${instance}</body>`) }, actor)
      const block = (html: string) =>
        new RegExp(`<style data-doop-component-css="${def.id}">[\\s\\S]*?</style>`).exec(html)?.[0] ?? ''
      const before = block(store.getFrame(frame.id)!.html)
      expect(before).toContain(`.sl__in-${def.id}`)
      actions.updateFrame(
        frame.id,
        { html: store.getFrame(frame.id)!.html.replace('class="sl"', `class="sl__in-${def.id}"`) },
        actor,
      )
      const stored = store.getFrame(frame.id)!.html
      expect(block(stored)).toBe(before)
      expect(stored).toContain('class="sl"')
    })

    it('leaves another component’s renamed names alone when a main is written back', () => {
      const def = makeSelect()
      const badge = blankComponent({ name: 'Badge', by: 'Tester', props: [] })
      store.saveComponent(canvasId, badge)
      const badgeFrame = actions.createFrame(canvasId, { name: 'Badge main', html: '' }, actor)!
      actions.updateFrame(
        badgeFrame.id,
        {
          html: doc(
            `<span class="badge" ${COMPONENT_ATTR}="${badge.id}"><b class="tag">New</b></span>`,
            '.badge { display: inline-flex } .tag { font-weight: 600 }',
          ),
        },
        actor,
      )
      const inner = `tag__in-${badge.id}`
      const frame = store.getFrame(def.mainFrameId!)!
      /* the frame's own sheet names both components' renamed classes: only the outer one's come back */
      const nested = `<span class="${inner}" data-keep>x</span><style>.${inner} { outline: 1px solid } .sl__in-${def.id} { margin: 0 }</style>`
      actions.updateFrame(frame.id, { html: frame.html.replace('</body>', `${nested}</body>`) }, actor)
      actions.updateFrame(
        frame.id,
        { html: store.getFrame(frame.id)!.html.replace('class="sl"', `class="sl__in-${def.id}"`) },
        actor,
      )
      const stored = store.getFrame(frame.id)!.html
      expect(stored).toContain(`<span class="${inner}" data-keep>`)
      expect(stored).toContain(`.${inner} { outline: 1px solid }`)
      expect(stored).toContain('.sl { margin: 0 }')
      expect(stored).not.toContain(`__in-${def.id}`)
    })
  })

  it('does not rename a class the stylesheet never names, or one a script uses', () => {
    const out = isolateClasses(
      {
        template: `<div class="card"><span class="card tw-text-sm">a</span><i class="open hit"></i><script>el.classList.add('open')</script></div>`,
        css: '.card .hit { color: red } .open { color: blue }',
        rawCss: '.card .hit { color: red } .open { color: blue }',
      },
      'abc',
    )
    const renamed = '.card__in-abc .hit__in-abc { color: red } .open { color: blue }'
    expect(out.template).toBe(
      `<div class="card__in-abc"><span class="card__in-abc tw-text-sm">a</span><i class="open hit__in-abc"></i><script>el.classList.add('open')</script></div>`,
    )
    expect(out.css).toBe(renamed)
    expect(out.rawCss).toBe(renamed)
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
    const template = (plain: string) =>
      `<div class="page"><a data-doop-on="click" data-doop-action="scroll-to:.faq">FAQ</a><a data-doop-interactions="[{&quot;on&quot;:&quot;click&quot;,&quot;action&quot;:&quot;scroll-to:.top&quot;}]">Top</a><section class="faq"></section><header class="top"></header><i class="${plain}"></i></div>`
    const css = '.faq { margin: 0 } .top { margin: 0 } .plain { margin: 0 }'
    const out = isolate(template('plain'), css)
    /* the two the interactions target stay; one nothing reads is renamed, so the pass ran */
    expect(out.template).toBe(template('plain__in-abc'))
    expect(out.css).toBe('.faq { margin: 0 } .top { margin: 0 } .plain__in-abc { margin: 0 }')
    expect(out.rawCss).toBe(out.css)
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

  it('keeps a class a nested component’s root wears, so this component’s rule still places it', () => {
    const template = (mark: string) =>
      `<div class="root"><span class="btn">a</span><div class="btn" data-doop-instance="inner"></div><doop-use component="Tag" class="pill"></doop-use><i class="pill"></i><b class="${mark}"></b></div>`
    const out = isolate(template('mark'), '.btn { color: red } .pill { gap: 4px } .mark { color: blue }')
    expect(out.template).toBe(template('mark__in-abc'))
    expect(out.css).toBe('.btn { color: red } .pill { gap: 4px } .mark__in-abc { color: blue }')
  })

  it.each([
    { form: ':is()', css: ':is(.a,.sl) { color: red }', expected: ':is(.a__in-abc,.sl__in-abc) { color: red }' },
    { form: ':where()', css: ':where(.sl) { color: red }', expected: ':where(.sl__in-abc) { color: red }' },
    { form: ':not()', css: 'div:not(.sl) { margin: 0 }', expected: 'div:not(.sl__in-abc) { margin: 0 }' },
    {
      form: ':has()',
      css: '.a:has(.sl) { margin: 0 }',
      expected: '.a__in-abc:has(.sl__in-abc) { margin: 0 }',
    },
    {
      form: '@media',
      css: '@media (min-width: 37.5em) { .sl { color: red } }',
      expected: '@media (min-width: 37.5em) { .sl__in-abc { color: red } }',
    },
    {
      form: '@container',
      css: '@container card (min-width: 20em) { .sl { color: red } }',
      expected: '@container card (min-width: 20em) { .sl__in-abc { color: red } }',
    },
    {
      form: '@supports',
      css: '@supports (display: grid) { .sl { display: grid } }',
      expected: '@supports (display: grid) { .sl__in-abc { display: grid } }',
    },
    {
      form: 'nested CSS',
      css: '.a { .sl { color: red } &.sl { color: blue } }',
      expected: '.a__in-abc { .sl__in-abc { color: red } &.sl__in-abc { color: blue } }',
    },
    {
      form: '@keyframes with fractional stops',
      css: '@keyframes pulse { 0% { opacity: 0 } 50.5% { opacity: .5 } 100% { opacity: 1 } } .sl { animation: pulse 1.5s }',
      expected:
        '@keyframes pulse { 0% { opacity: 0 } 50.5% { opacity: .5 } 100% { opacity: 1 } } .sl__in-abc { animation: pulse 1.5s }',
    },
    {
      form: 'pseudo-elements and states',
      css: '.sl::before { content: "" } .sl:hover { color: red }',
      expected: '.sl__in-abc::before { content: "" } .sl__in-abc:hover { color: red }',
    },
    {
      form: 'leading-dot lengths',
      css: '.sl { margin: .5em 1.5em }',
      expected: '.sl__in-abc { margin: .5em 1.5em }',
    },
    {
      form: 'quoted and spaced url()',
      css: '.pdf { background: url("a.pdf") } .sl { background: url( a.pdf ) }',
      expected: '.pdf__in-abc { background: url("a.pdf") } .sl__in-abc { background: url( a.pdf ) }',
    },
    {
      form: 'comments and strings',
      css: '/* .sl { color: red } */ .sl { content: ".sl" } .a::after { content: \'.sl\' }',
      expected: '/* .sl { color: red } */ .sl__in-abc { content: ".sl" } .a__in-abc::after { content: \'.sl\' }',
    },
  ])('renames only the class selectors in $form', ({ css, expected }) => {
    const out = isolate('<div class="root"><span class="sl a pdf">x</span></div>', css)
    expect(out.css).toBe(expected)
    expect(out.rawCss).toBe(expected)
    expect(isolateClasses(out, 'abc')).toEqual(out)
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
  interface Def {
    id: string
    name: string
    template: string
    css: string
    rawCss: string
    source?: { canvasId: string; library?: boolean }
    mainFrameId: string | null
  }
  interface CanvasBody {
    frames: { id: string; html: string }[]
    components: Def[]
  }
  let server: Server
  let owner: Client
  let libraryId: string
  let consumerId: string
  let otherId: string
  let selectId: string
  let consumerFrameId: string
  let otherFrameId: string

  const json = async <T>(res: Response) => (await res.json()) as T
  const canvasOf = async (id: string) => json<CanvasBody>(await owner.get(`/api/canvases/${id}`))
  const defOf = async (canvas: string) => (await canvasOf(canvas)).components.find((def) => def.name === 'Select')!
  const frameHtml = async (canvas: string, frameId: string) =>
    (await canvasOf(canvas)).frames.find((frame) => frame.id === frameId)!.html
  const makeCanvas = async (name: string, workspaceId?: string) =>
    (await json<{ id: string }>(await owner.post('/api/canvases', { name, workspaceId }))).id
  const publish = async () =>
    expect((await owner.post(`/api/canvases/${libraryId}/library/publish`, {})).status).toBe(200)
  const edit = async (html: string, css: string) => {
    const res = await owner.patch(`/api/canvases/${libraryId}/components/${selectId}`, { html, css })
    expect(res.status, await res.clone().text()).toBe(200)
  }
  /** Every component id a text carries a suffix for: one entry when the rename is consistent and single. */
  const suffixes = (text: string) => [...new Set([...text.matchAll(/__in-(\w+)/g)].map((match) => match[1]!))]
  const place = async (canvas: string, name: string) =>
    (
      await json<{ id: string }>(
        await owner.post(`/api/canvases/${canvas}/frames`, {
          name,
          html: doc('<doop-use component="Select" label="Pick"></doop-use>', '.sl { position: absolute }'),
        }),
      )
    ).id

  beforeAll(async () => {
    server = await startServer()
    owner = await new Client(server).signUp('owner@isolation.test', 'Owner')
    const workspaceId = (await json<{ id: string }>(await owner.post('/api/workspaces', { name: 'Team' }))).id
    libraryId = await makeCanvas('Kit', workspaceId)
    consumerId = await makeCanvas('App', workspaceId)
    otherId = await makeCanvas('Other app', workspaceId)
    const made = await owner.post(`/api/canvases/${libraryId}/components`, {
      name: 'Select',
      html: '<div class="select"><span class="sl" data-doop-prop="label">Size</span></div>',
      css: '.select { display: flex } .sl { color: #333 }',
    })
    expect(made.status, await made.clone().text()).toBe(200)
    selectId = (await json<{ component: Def }>(made)).component.id
    await publish()
    consumerFrameId = await place(consumerId, 'Screen')
    otherFrameId = await place(otherId, 'Other screen')
  }, 60_000)

  afterAll(() => server?.stop())

  it('arrives with its classes renamed, so the consumer’s `.sl` rule does not reach it', async () => {
    const html = await frameHtml(consumerId, consumerFrameId)
    expect(classesIn(html, /<span class="([^"]*)"/g)).toEqual([`sl__in-${selectId}`])
    /* the consumer's own rule is the one it wrote */
    expect(/<style>([^<]*)<\/style>/.exec(html)![1]).toBe('.sl { position: absolute }')

    const library = await defOf(libraryId)
    const consumer = await defOf(consumerId)
    expect(library.id).toBe(selectId)
    expect(consumer.id).toBe(selectId)
    expect(consumer.source).toMatchObject({ canvasId: libraryId, library: true })
    expect(classesIn(consumer.template, /<span class="([^"]*)"/g)).toEqual([`sl__in-${selectId}`])
    for (const part of ['template', 'css', 'rawCss'] as const) {
      expect(suffixes(consumer[part]), part).toEqual([selectId])
      expect(consumer[part], part).toBe(library[part])
    }
    expect(consumer.css).toContain(`.sl__in-${selectId}`)
  })

  it('carries a new styled inner class through sync_component with one suffix', async () => {
    await edit(
      '<div class="select"><span class="sl" data-doop-prop="label">Size</span><i class="badge">!</i></div>',
      '.select { display: flex } .sl { color: #333 } .badge { color: red }',
    )
    await publish()
    const res = await owner.post(`/api/canvases/${consumerId}/components/${selectId}/sync`, {})
    expect(res.status, await res.clone().text()).toBe(200)

    const library = await defOf(libraryId)
    const consumer = await defOf(consumerId)
    expect(classesIn(consumer.template, /<i class="([^"]*)"/g)).toEqual([`badge__in-${selectId}`])
    const badgeRule = consumer.css.split('\n').find((line) => line.includes(`.badge__in-${selectId}`))
    expect(badgeRule).toContain('{ color: red }')
    for (const part of ['template', 'css', 'rawCss'] as const) {
      expect(suffixes(consumer[part]), part).toEqual([selectId])
      expect(consumer[part], part).toBe(library[part])
    }
    const html = await frameHtml(consumerId, consumerFrameId)
    expect(classesIn(html, /<i class="([^"]*)"/g)).toEqual([`badge__in-${selectId}`])
    expect(/<style>([^<]*)<\/style>/.exec(html)![1]).toBe('.sl { position: absolute }')
  })

  it('carries one more styled inner class through update_library_everywhere, to a canvas two publications behind', async () => {
    await edit(
      '<div class="select"><span class="sl" data-doop-prop="label">Size</span><i class="badge">!</i><b class="chip">x</b></div>',
      '.select { display: flex } .sl { color: #333 } .badge { color: red } .chip { color: green }',
    )
    await publish()
    const res = await owner.post(`/api/canvases/${libraryId}/library/update-consumers`, {})
    expect(res.status, await res.clone().text()).toBe(200)

    const library = await defOf(libraryId)
    for (const [canvas, frameId] of [
      [consumerId, consumerFrameId],
      [otherId, otherFrameId],
    ] as const) {
      const def = await defOf(canvas)
      expect(classesIn(def.template, /<b class="([^"]*)"/g), canvas).toEqual([`chip__in-${selectId}`])
      expect(
        def.css.split('\n').find((line) => line.includes(`.chip__in-${selectId}`)),
        canvas,
      ).toContain('{ color: green }')
      for (const part of ['template', 'css', 'rawCss'] as const) {
        expect(suffixes(def[part]), `${canvas} ${part}`).toEqual([selectId])
        expect(def[part], `${canvas} ${part}`).toBe(library[part])
      }
      const html = await frameHtml(canvas, frameId)
      expect(classesIn(html, /<b class="([^"]*)"/g), canvas).toEqual([`chip__in-${selectId}`])
      expect(classesIn(html, /<span class="([^"]*)"/g), canvas).toEqual([`sl__in-${selectId}`])
    }
  })

  it('imports from a canvas outside any workspace with natural names in the main and one suffix in the definition', async () => {
    const sourceId = await makeCanvas('Loose kit')
    const targetId = await makeCanvas('Loose app')
    const made = await owner.post(`/api/canvases/${sourceId}/components`, {
      name: 'Select',
      html: '<div class="select"><span class="sl" data-doop-prop="label">Size</span></div>',
      css: '.select { display: flex } .sl { color: #333 }',
    })
    expect(made.status, await made.clone().text()).toBe(200)
    const imported = await owner.post(`/api/canvases/${targetId}/components/import`, {
      sourceCanvasId: sourceId,
      component: 'Select',
    })
    expect(imported.status, await imported.clone().text()).toBe(200)

    const source = await defOf(sourceId)
    const target = await defOf(targetId)
    expect(target.id).toBe(source.id)
    for (const part of ['template', 'css', 'rawCss'] as const) {
      expect(suffixes(target[part]), part).toEqual([source.id])
      expect(target[part], part).toBe(source[part])
    }
    const main = (await canvasOf(targetId)).frames.find((frame) => frame.id === target.mainFrameId)!
    expect(classesIn(main.html, /<span class="([^"]*)"/g)).toEqual(['sl'])
    expect(main.html.includes('__in-')).toBe(false)
  })
})

describe('withNaturalFrameStyles', () => {
  const rule = (attrs: string) => `<style${attrs}>.sl__in-abc { color: red }</style>`
  const natural = '.sl { color: red }'

  it('reads the frame’s own and carried blocks as the definition does, and leaves the managed ones', () => {
    const html = [
      rule(''),
      rule(' data-doop-carried="x"'),
      rule(' data-doop-import="x"'),
      rule(' data-doop-component-css="abc"'),
      rule(' data-doop-detached-css="abc-1"'),
      rule(' data-doop-tokens'),
      rule(' data-doop-fonts'),
    ].join('\n')
    const out = withNaturalFrameStyles(html, 'abc').split('\n')
    expect(out.slice(0, 3).every((block) => block.includes(natural))).toBe(true)
    expect(out.slice(3)).toEqual(html.split('\n').slice(3))
  })
})
