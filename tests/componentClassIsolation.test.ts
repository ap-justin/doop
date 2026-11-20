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
import { isolateClasses, withMainCssBlock, withNaturalFrameStyles } from '../server/componentClasses.ts'
import { COMPONENT_ATTR, CSS_ATTR, INSTANCE_ATTR, SLOT_ATTR } from '../shared/components.ts'
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

  function makeButton() {
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
    return button
  }

  /**
   * A Plan whose main holds a Button, the Plan's sheet styling `.plan .btn`; the Plan's own frame.
   * `outside` is markup written after the main, given the Button's id.
   */
  function planWithButton(extraCss = '', outside: (buttonId: string) => string = () => '') {
    const button = makeButton()
    const plan = blankComponent({ name: 'Plan', by: 'Tester', props: [] })
    store.saveComponent(canvasId, plan)
    const planFrame = actions.createFrame(canvasId, { name: 'Plan main', html: '' }, actor)!
    actions.updateFrame(
      planFrame.id,
      {
        html: doc(
          `<div class="plan" ${COMPONENT_ATTR}="${plan.id}"><doop-use component="${button.id}"></doop-use></div><div class="plan"><i class="btn">plain</i></div>${outside(button.id)}`,
          `.plan { padding: 8px } .plan .btn { width: 100% }${extraCss}`,
        ),
      },
      actor,
    )
    return { button, plan, planFrame }
  }
  const mainCssBlock = (html: string, id: string) =>
    new RegExp(`<style data-doop-main-css="${id}">\\n([\\s\\S]*?)\\n</style>`).exec(html)
  /** The selectors of a block of plain rules (no at-rule groups), one per comma-separated entry. */
  const selectorsOf = (css: string) =>
    [...css.matchAll(/([^{}]+)\{/g)].flatMap((rule) => rule[1]!.split(',').map((selector) => selector.trim()))

  it('writes the parent’s nested-root rules into its own main frame, where they match the nested instance', async () => {
    const { button, plan, planFrame } = planWithButton()
    const html = store.getFrame(planFrame.id)!.html
    const block = mainCssBlock(html, plan.id)
    expect(block, html).not.toBeNull()
    /* before the frame's own styles, which stay in natural names */
    expect(html.indexOf('data-doop-main-css')).toBeLessThan(html.indexOf('<style>'))
    expect(html).toContain('.plan .btn { width: 100% }')
    const window = new Window()
    try {
      window.document.write(html)
      const nested = window.document.querySelector(`[${INSTANCE_ATTR}="${button.id}"]`)!
      const plain = window.document.querySelector('i.btn')!
      const selectors = [...block![1]!.matchAll(/([^{}]+)\{/g)].flatMap((rule) => rule[1]!.split(','))
      expect(selectors.length).toBeGreaterThan(0)
      /* a rule that reaches the Button inside the Plan, and none that reaches a plain `.btn` */
      const matches = (selector: string) => [...window.document.querySelectorAll(selector.trim())]
      expect(selectors.some((selector) => matches(selector).includes(nested))).toBe(true)
      for (const selector of selectors) expect(matches(selector)).not.toContain(plain)
    } finally {
      await window.happyDOM.close()
    }
  })

  it('files no new revision when that main is saved again, and never reads the block back as the author’s CSS', () => {
    const { plan, planFrame } = planWithButton()
    const before = store.getComponents(canvasId).find((candidate) => candidate.id === plan.id)!
    const frame = store.getFrame(planFrame.id)!
    const blockBefore = mainCssBlock(frame.html, plan.id)![0]
    actions.updateFrame(planFrame.id, { html: `${frame.html} ` }, actor)
    const after = store.getComponents(canvasId).find((candidate) => candidate.id === plan.id)!
    expect(after.rev).toBe(before.rev)
    expect(after.css).toBe(before.css)
    expect(after.rawCss).toBe(before.rawCss)
    const saved = store.getFrame(planFrame.id)!.html
    expect(saved.match(/data-doop-main-css/g)).toHaveLength(1)
    expect(mainCssBlock(saved, plan.id)![0]).toBe(blockBefore)
    /* the saved frame is a fixed point: saving its own output changes no byte */
    actions.updateFrame(planFrame.id, { html: saved }, actor)
    expect(store.getFrame(planFrame.id)!.html).toBe(saved)
  })

  it('scopes the block to its main, so the Button in a Plan outside the main gets none of its rules', async () => {
    const { button, plan, planFrame } = planWithButton(
      '',
      (buttonId) => `<div class="plan"><doop-use component="${buttonId}"></doop-use></div>`,
    )
    const html = store.getFrame(planFrame.id)!.html
    const block = mainCssBlock(html, plan.id)![1]!
    const selectors = selectorsOf(block)
    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) expect(selector).toContain(`[${COMPONENT_ATTR}="${plan.id}"]`)
    /* only the rule that ends at the nested Button, not the Plan's own `.plan { padding }` */
    expect(block).toContain(`.btn__in-${button.id}`)
    expect(block).not.toContain('padding')

    const window = new Window()
    try {
      window.document.write(html)
      const all = [...window.document.querySelectorAll(`[${INSTANCE_ATTR}="${button.id}"]`)]
      expect(all).toHaveLength(2)
      const inside = window.document.querySelector(`[${COMPONENT_ATTR}] [${INSTANCE_ATTR}="${button.id}"]`)!
      const outside = all.find((el) => el !== inside)!
      const matches = (selector: string) => [...window.document.querySelectorAll(selector)]
      expect(selectors.some((selector) => matches(selector).includes(inside))).toBe(true)
      for (const selector of selectors) expect(matches(selector)).not.toContain(outside)
    } finally {
      await window.happyDOM.close()
    }
  })

  it('removes the block when the last nested instance leaves the main and the frame is saved', () => {
    const { button, plan, planFrame } = planWithButton()
    const html = store.getFrame(planFrame.id)!.html
    expect(mainCssBlock(html, plan.id)).not.toBeNull()
    const withoutButton = html.replace(
      new RegExp(`<button[^>]*${INSTANCE_ATTR}="${button.id}"[^>]*>[\\s\\S]*?</button>`),
      '',
    )
    /* the instance is gone, the leftover block is still in the text that is saved */
    expect(withoutButton).not.toBe(html)
    expect(mainCssBlock(withoutButton, plan.id)).not.toBeNull()
    actions.updateFrame(planFrame.id, { html: withoutButton }, actor)
    expect(store.getFrame(planFrame.id)!.html).not.toContain('data-doop-main-css')
  })

  it('keeps an @media rule inside its group and only the nested-root selectors of a mixed list', () => {
    const { button, plan, planFrame } = planWithButton(
      '\n@media (max-width: 600px) { .plan .btn { width: 50% } }\n.plan .btn, .plan .other { gap: 4px }',
    )
    const block = mainCssBlock(store.getFrame(planFrame.id)!.html, plan.id)![1]!
    const renamed = `.btn__in-${button.id}`
    const media = /@media\s*\(max-width:\s*600px\)\s*\{([\s\S]*)\n\}/.exec(block)
    expect(media, block).not.toBeNull()
    expect(media![1]).toContain(renamed)
    expect(media![1]).toMatch(/width:\s*50%/)
    /* the plain rule stays outside the group */
    expect(block.slice(0, media!.index)).toMatch(/width:\s*100%/)
    /* `.plan .other` ends at no nested root: dropped, its sibling in the list kept */
    expect(block).not.toContain('.other')
    expect(block).toMatch(new RegExp(`${renamed}\\s*\\{[^}]*gap:\\s*4px`))
  })

  it('gives each of two mains in one frame its own block, scoped to it, and saving the output changes nothing', () => {
    const button = makeButton()
    const first = blankComponent({ name: 'Plan', by: 'Tester', props: [] })
    const second = blankComponent({ name: 'Tier', by: 'Tester', props: [] })
    store.saveComponent(canvasId, first)
    store.saveComponent(canvasId, second)
    const frame = actions.createFrame(canvasId, { name: 'Mains', html: '' }, actor)!
    const main = (cls: string, id: string) =>
      `<div class="${cls}" ${COMPONENT_ATTR}="${id}"><doop-use component="${button.id}"></doop-use></div>`
    actions.updateFrame(
      frame.id,
      {
        html: doc(`${main('pa', first.id)}${main('pb', second.id)}`, '.pa .btn { width: 1px } .pb .btn { width: 2px }'),
      },
      actor,
    )
    const html = store.getFrame(frame.id)!.html
    expect(html.match(/data-doop-main-css/g)).toHaveLength(2)
    for (const [id, width] of [
      [first.id, 'width: 1px'],
      [second.id, 'width: 2px'],
    ] as const) {
      const block = mainCssBlock(html, id)![1]!
      const selectors = selectorsOf(block)
      expect(selectors.length).toBeGreaterThan(0)
      for (const selector of selectors) expect(selector).toContain(`[${COMPONENT_ATTR}="${id}"]`)
      expect(block).toContain(width)
    }
    actions.updateFrame(frame.id, { html }, actor)
    expect(store.getFrame(frame.id)!.html).toBe(html)
  })

  it('removes the block when the main leaves the frame', () => {
    const { plan, planFrame } = planWithButton()
    const html = store.getFrame(planFrame.id)!.html
    const plain = html.replace(new RegExp(`\\s${COMPONENT_ATTR}="${plan.id}"`), '')
    actions.updateFrame(planFrame.id, { html: plain }, actor)
    expect(store.getFrame(planFrame.id)!.html).not.toContain('data-doop-main-css')
  })

  it('drops the block from a copy of the main’s frame, and never takes the copy for the main', () => {
    const { plan, planFrame } = planWithButton()
    const copy = actions.createFrame(
      canvasId,
      { name: 'Plan main copy', html: store.getFrame(planFrame.id)!.html },
      actor,
    )!
    expect(store.getFrame(copy.id)!.html).toContain(`${INSTANCE_ATTR}="${plan.id}"`)
    expect(store.getFrame(copy.id)!.html).not.toContain('data-doop-main-css')
    actions.deleteFrame(planFrame.id, actor)
    expect(store.getComponents(canvasId).find((candidate) => candidate.id === plan.id)!.mainFrameId).toBeNull()
  })

  it('takes no frame for a main because its stylesheet names the main', () => {
    const { plan, planFrame } = planWithButton()
    const other = actions.createFrame(canvasId, { name: 'Other', html: '' }, actor)!
    /* the block's scope, `[data-doop-component="…"]`, in a frame with no main */
    store.getFrame(other.id)!.html = doc('<p>x</p>', `:where([${COMPONENT_ATTR}="${plan.id}"]) .x { color: red }`)
    actions.deleteFrame(planFrame.id, actor)
    expect(store.getComponents(canvasId).find((candidate) => candidate.id === plan.id)!.mainFrameId).toBeNull()
  })

  it('keeps a deleted component’s block while its frozen main stays, and drops it once the main is gone', () => {
    const { plan, planFrame } = planWithButton()
    deleteComponent(canvasId, plan.id, actor)
    const frozen = store.getFrame(planFrame.id)!.html
    actions.updateFrame(planFrame.id, { html: `${frozen} ` }, actor)
    /* the frozen main still holds the nested instance its rules reach */
    expect(mainCssBlock(store.getFrame(planFrame.id)!.html, plan.id)).not.toBeNull()
    const plain = frozen.replace(new RegExp(`\\s${COMPONENT_ATTR}="${plan.id}"`), '')
    actions.updateFrame(planFrame.id, { html: plain }, actor)
    expect(store.getFrame(planFrame.id)!.html).not.toContain('data-doop-main-css')
  })

  it('leaves a frame with no leftover block as it was', () => {
    const { planFrame } = planWithButton()
    const html = store.getFrame(planFrame.id)!.html
    actions.updateFrame(planFrame.id, { html }, actor)
    expect(store.getFrame(planFrame.id)!.html).toBe(html)
  })

  it('writes a new main on restore when the frame carries the deleted component’s block and no main', () => {
    const { plan, planFrame } = planWithButton()
    deleteComponent(canvasId, plan.id, actor)
    const frame = store.getFrame(planFrame.id)!
    /* as a write that kept a leftover block could have stored it */
    frame.html = frame.html.replace(new RegExp(`\\s${COMPONENT_ATTR}="${plan.id}"`), '')
    expect(mainCssBlock(frame.html, plan.id)).not.toBeNull()
    expect(restoreComponent(canvasId, plan.id, actor).main).toBe('written')
  })

  it('leaves the block out of the frame agents read, and writes it again when that is saved', () => {
    const { plan, planFrame } = planWithButton()
    const compact = compactDocument(store.getFrame(planFrame.id)!.html, contextFor(canvasId))
    expect(compact).not.toContain('data-doop-main-css')
    actions.updateFrame(planFrame.id, { html: compact }, actor)
    expect(mainCssBlock(store.getFrame(planFrame.id)!.html, plan.id)).not.toBeNull()
  })

  it('carries a nested rule that ends at a nested root into the main frame, as the instances have it', () => {
    const { button, plan, planFrame } = planWithButton('\n.plan { color: rgb(1, 2, 3); & .btn { height: 5px } }')
    const btn = `.btn__in-${button.id}`
    /* the instances read the nested rule with the renamed class */
    const def = store.getComponents(canvasId).find((candidate) => candidate.id === plan.id)!
    expect(def.rawCss).toMatch(new RegExp(`& ${btn.replace('.', '\\.')}\\s*\\{\\s*height: 5px`))
    /* and the main frame must too: its nested Button wears the renamed class there as well */
    const block = mainCssBlock(store.getFrame(planFrame.id)!.html, plan.id)![1]!
    expect(block).toMatch(new RegExp(`& ${btn.replace('.', '\\.')}\\s*\\{\\s*height: 5px`))
    /* kept alone under its scoped parent: the parent's own declarations are not copied, the nested one once */
    expect(block).toContain(
      `:where([${COMPONENT_ATTR}="${plan.id}"]) .plan, .plan:where([${COMPONENT_ATTR}="${plan.id}"]) {\n& ${btn} {`,
    )
    expect(block).not.toContain('rgb(1, 2, 3)')
    expect(block).not.toContain('padding')
    expect(block.match(/height:\s*5px/g)).toHaveLength(1)
  })

  it('declares a copied @layer after the frame’s own layer order, so the cascade is the author’s', () => {
    /* the author's order statement comes before both blocks in the sheet */
    const { planFrame } = planWithButton(
      '\n@layer reset, base;\n@layer base { .plan .btn { width: 50% } }\n@layer reset { * { margin: 0 } }',
    )
    const html = store.getFrame(planFrame.id)!.html
    const order: string[] = []
    for (const style of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g))
      for (const layer of style[1]!.matchAll(/@layer\s+([^{;]+)[{;]/g))
        for (const name of layer[1]!.split(',')) if (!order.includes(name.trim())) order.push(name.trim())
    expect(order).toEqual(['reset', 'base'])
    expect(html).toContain('data-doop-main-css')
  })

  it('restates no layer order when the sheet has no @layer', () => {
    const { plan, planFrame } = planWithButton()
    const block = mainCssBlock(store.getFrame(planFrame.id)!.html, plan.id)![1]!
    expect(block).toContain('width: 100%')
    expect(block).not.toContain('@layer')
  })

  it('restates no layer order when the carried rules sit outside every layer', () => {
    const { plan, planFrame } = planWithButton('\n@layer base, reset;')
    const block = mainCssBlock(store.getFrame(planFrame.id)!.html, plan.id)![1]!
    expect(block).toContain('width: 100%')
    expect(block).not.toContain('@layer')
  })

  it('restates sublayers declared inside a layer block in the author’s order', () => {
    const { plan, planFrame } = planWithButton(
      '\n@layer ui { @layer reset { * { margin: 0 } } @layer comp { .plan .btn { margin: 8px } } }',
    )
    const block = mainCssBlock(store.getFrame(planFrame.id)!.html, plan.id)![1]!
    /* the block carries `ui.comp` ahead of the author's sheet: `ui.reset` must be declared before it */
    const statement = /^@layer ([^{;]+);/.exec(block)
    expect(statement, block).not.toBeNull()
    expect(statement![1]!.split(',').map((name) => name.trim())).toEqual(['ui', 'ui.reset', 'ui.comp'])
  })

  describe('a frame with no <head>', () => {
    const style = '<style data-doop-main-css="abc">\n.a { color: red }\n</style>'

    it('gets the block ahead of a bare fragment', () => {
      expect(withMainCssBlock('<div class="plan">x</div>', 'abc', '.a { color: red }')).toBe(
        `${style}\n<div class="plan">x</div>`,
      )
    })

    it('gets the block in a head made before its body, and loses it again when the css is empty', () => {
      const written = withMainCssBlock('<body><div>x</div></body>', 'abc', '.a { color: red }')
      expect(written).toBe(`<head>\n${style}\n</head><body><div>x</div></body>`)
      expect(withMainCssBlock(written, 'abc', '')).toBe('<head>\n</head><body><div>x</div></body>')
    })
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

  describe('the note for a renamed root class', () => {
    /** A Select whose stored definition predates the rename, and frames around it; the note is read after saving its main. */
    function staleSelect({ rootBefore = 'select', mixed = false, old = '' } = {}) {
      const select = makeSelect()
      const frame = (name: string, html: string) => {
        const created = actions.createFrame(canvasId, { name, html: '' }, actor)!
        if (html) store.getFrame(created.id)!.html = html
        return created
      }
      const instance = `<div class="select__in-${select.id}" ${INSTANCE_ATTR}="${select.id}">x</div>`
      const landing = frame('Landing', '')
      actions.updateFrame(
        landing.id,
        { html: doc(`<doop-use component="${select.id}" label="Pick"></doop-use>`, '.select { grid-column: span 2 }') },
        actor,
      )
      if (mixed) {
        const own = actions.createFrame(canvasId, { name: 'Mixed', html: '' }, actor)!
        actions.updateFrame(
          own.id,
          {
            html: doc(
              `<doop-use component="${select.id}" label="Pick"></doop-use><p class="select">own</p>`,
              '.select { margin: 1px }',
            ),
          },
          actor,
        )
      }
      /* `old`: body markup of a frame whose instance was placed from the old definition, so it wears the natural root class */
      if (old) {
        const placed = `<div class="select" ${INSTANCE_ATTR}="${select.id}">x</div>`
        frame('Old', doc(`${placed}${old}`, '.select { grid-column: span 2 }'))
      }
      frame('No rule', doc(instance, '.other { color: red }'))
      frame('Rule only', doc('<p class="select">x</p>', '.select { margin: 1px }'))
      frame(
        'Managed only',
        `<!doctype html><html><head><style ${CSS_ATTR}="${select.id}">.select { color: red }</style></head><body>${instance}</body></html>`,
      )
      store.saveComponent(canvasId, {
        ...select,
        template: select.template.replace(`select__in-${select.id}`, rootBefore),
      })
      const main = store.getFrame(select.mainFrameId!)!
      actions.takeComponentIssues(main.id)
      const save = () => {
        actions.updateFrame(main.id, { html: `${store.getFrame(main.id)!.html} ` }, actor)
        return actions.takeComponentIssues(main.id).find((issue) => issue.code === 'root_class_renamed')
      }
      return { save }
    }

    it('names the frames that hold an instance and a rule of their own for the class, and no other', () => {
      const note = staleSelect().save()
      expect(note).toBeDefined()
      /* the whole list: not the frame without a rule, the one without an instance, the one with only a managed block, nor the main's own */
      expect(note!.message).toContain(
        "these frames' own rules for it no longer reach its instances: “Landing” (.select). Move each",
      )
    })

    it('says nothing about a class that was not on the root before this save', () => {
      /* the root wore `other`; `select` was only just put on it, so no rule of the frame ever reached an instance by it */
      expect(staleSelect({ rootBefore: 'other' }).save()).toBeUndefined()
    })

    it('says plainly that a frame’s rule still styles its own elements with the class', () => {
      const note = staleSelect({ mixed: true }).save()
      expect(note).toBeDefined()
      expect(note!.message).toContain('“Landing” (.select)')
      expect(note!.message).toContain(
        '“Mixed” (.select, which its rule still styles on that frame’s own elements; only the placed instance needs a class)',
      )
      expectKeepAdvice(note!.message)
    })

    const OWN_WORDING = 'which its rule still styles on that frame’s own elements'
    /** Moving a rule the frame's own elements match would unstyle them: the closing advice keeps it there. */
    function expectKeepAdvice(message: string) {
      expect(message).not.toContain('Move each such rule')
      expect(message).toContain("keep the rule for them and give the instance's class the same styles")
    }

    it('lists a plain class when the only element wearing it is the placed instance', () => {
      const note = staleSelect({ old: '<p class="other">x</p>' }).save()
      expect(note).toBeDefined()
      expect(note!.message).toContain('“Old” (.select)')
      expect(note!.message).not.toContain(OWN_WORDING)
    })

    it('uses the long wording when the frame also has its own element wearing the class', () => {
      const note = staleSelect({ old: '<p class="a select">own</p>' }).save()
      expect(note).toBeDefined()
      expect(note!.message).toContain(`“Old” (.select, ${OWN_WORDING}; only the placed instance needs a class)`)
      expectKeepAdvice(note!.message)
    })

    /** Another component's instance, holding `slot` in its slot. */
    const section = (slot: string) =>
      `<section class="sec" ${INSTANCE_ATTR}="section"><h2 class="select">title</h2><div ${SLOT_ATTR}="body">${slot}</div></section>`

    it('counts an element the frame put in another instance’s slot as its own', () => {
      const note = staleSelect({ old: section('<p class="select">own</p>') }).save()
      expect(note).toBeDefined()
      expect(note!.message).toContain(`“Old” (.select, ${OWN_WORDING}; only the placed instance needs a class)`)
    })

    it('does not count an instance placed in a slot, nor another instance’s own markup', () => {
      const badge = `<span class="select" ${INSTANCE_ATTR}="badge"><b class="select">x</b></span>`
      const note = staleSelect({ old: section(badge) }).save()
      expect(note).toBeDefined()
      expect(note!.message).toContain('“Old” (.select)')
      expect(note!.message).not.toContain(OWN_WORDING)
    })

    it('counts an own element whose class attribute is unquoted', () => {
      const note = staleSelect({ old: '<p class=select>own</p>' }).save()
      expect(note).toBeDefined()
      expect(note!.message).toContain(`“Old” (.select, ${OWN_WORDING}`)
    })

    it('is not repeated by a second save of the main', () => {
      const { save } = staleSelect()
      expect(save()).toBeDefined()
      expect(save()).toBeUndefined()
    })
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
