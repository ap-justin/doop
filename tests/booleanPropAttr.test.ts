import { describe, expect, it, vi } from 'vitest'

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
import { BIND_ATTR, COMPONENT_ATTR, INSTANCE_ATTR, PROPS_ATTR, REV_ATTR } from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

const doc = (body: string, css = '') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`

const TABS_CSS = `.tabs { display: block }
.tabs[data-stretch] { display: flex }
.tabs[data-scroll] { overflow-x: auto }`

/** A Tabs main whose template binds nothing to its two boolean props. */
function setup() {
  const canvas = store.createCanvas('boolean prop attribute')
  const def = blankComponent({
    name: 'Tabs',
    by: 'Tester',
    props: [
      { name: 'stretch', type: 'boolean', default: 'false' },
      { name: 'scroll', type: 'boolean', default: 'true' },
    ],
  })
  store.saveComponent(canvas.id, def)
  const mainFrame = actions.createFrame(canvas.id, { name: 'Main', html: '' }, actor)!
  const mainHtml = doc(`<nav class="tabs" ${COMPONENT_ATTR}="${def.id}"><a href="#">One</a></nav>`, TABS_CSS)
  actions.updateFrame(mainFrame.id, { html: mainHtml }, actor)
  const page = actions.createFrame(canvas.id, { name: 'Page', html: '' }, actor)!
  return { canvas, def, mainFrame, page }
}

const current = (canvasId: string, id: string) => store.getComponents(canvasId).find((d) => d.id === id)!
const framed = (id: string) => store.getFrame(id)!.html
const instances = (html: string, tag = 'nav') =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))].map((match) => match[0])
/** The props an instance root's marker records. */
const markerProps = (root: string): Record<string, string> => {
  const raw = root.match(new RegExp(`${PROPS_ATTR}="([^"]*)"`))?.[1]
  return raw ? (JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&')) as Record<string, string>) : {}
}
const instanceIdOf = (root: string) => root.match(/ data-doop-id="([^"]+)"/)?.[1] ?? ''

describe('a boolean prop on the instance root', () => {
  it('is kept in the definition although the template binds nothing to it', () => {
    const { canvas, def } = setup()
    expect(
      current(canvas.id, def.id)
        .props.map((prop) => prop.name)
        .sort(),
    ).toEqual(['scroll', 'stretch'])
  })

  it('shows as data-<name> when true, nothing when false, and the default when not overridden', () => {
    const { page } = setup()
    actions.updateFrame(
      page.id,
      {
        html: doc(
          `<doop-use component="Tabs" stretch="true"></doop-use>` +
            `<doop-use component="Tabs" scroll="false"></doop-use>` +
            `<doop-use component="Tabs"></doop-use>`,
        ),
      },
      actor,
    )
    const [stretched, unscrolled, plain] = instances(framed(page.id))
    expect(stretched).toMatch(/ data-stretch(?=[\s>=])/)
    expect(stretched).toMatch(/ data-scroll(?=[\s>=])/)
    expect(unscrolled).not.toContain('data-stretch')
    expect(unscrolled).not.toContain('data-scroll')
    expect(plain).not.toContain('data-stretch')
    expect(plain).toMatch(/ data-scroll(?=[\s>=])/)
  })

  it('is set through the instance props and survives the round trip', () => {
    const { page } = setup()
    actions.updateFrame(page.id, { html: doc(`<doop-use component="Tabs" stretch="true"></doop-use>`) }, actor)
    const html = framed(page.id)
    expect(html).toMatch(/data-doop-props="[^"]*stretch[^"]*true/)
    /* writing the expanded markup back changes nothing */
    actions.updateFrame(page.id, { html }, actor)
    expect(framed(page.id)).toBe(html)
  })

  it('records an override when an instance root gains or loses data-<name>', () => {
    const { page } = setup()
    actions.updateFrame(page.id, { html: doc(`<doop-use component="Tabs"></doop-use>`) }, actor)
    const plain = framed(page.id)
    actions.updateFrame(page.id, { html: plain.replace('<nav ', '<nav data-stretch="" ') }, actor)
    expect(framed(page.id)).toMatch(/data-doop-props="[^"]*stretch[^"]*true/)
    expect(instances(framed(page.id))[0]).toMatch(/ data-stretch(?=[\s>=])/)

    actions.updateFrame(page.id, { html: framed(page.id).replace(/ data-scroll(="")?/, '') }, actor)
    expect(framed(page.id)).toMatch(/data-doop-props="[^"]*scroll[^"]*false/)
    expect(instances(framed(page.id))[0]).not.toContain('data-scroll')
  })

  it('keeps a [data-<name>] rule in the component CSS, scoped to the instance, and only true instances match', () => {
    const { canvas, def, page } = setup()
    const { css } = current(canvas.id, def.id)
    const scope = `:where([${INSTANCE_ATTR}="${def.id}"])`
    expect(css).toMatch(new RegExp(`${scope.replace(/[[\]().]/g, '\\$&')} \\.tabs[\\w-]*\\[data-stretch\\]`))
    expect(css).toMatch(new RegExp(`${scope.replace(/[[\]().]/g, '\\$&')} \\.tabs[\\w-]*\\[data-scroll\\]`))
    actions.updateFrame(
      page.id,
      { html: doc(`<doop-use component="Tabs" stretch="true"></doop-use><doop-use component="Tabs"></doop-use>`) },
      actor,
    )
    const [first, second] = instances(framed(page.id))
    expect(first).toContain('data-stretch')
    expect(second).not.toContain('data-stretch')
  })

  it('keeps the default of an instance rendered before booleans were marked, recording no override', () => {
    const { page } = setup()
    actions.updateFrame(page.id, { html: doc(`<doop-use component="Tabs"></doop-use>`) }, actor)
    /* what such an instance wears: its marker and revision, and none of the booleans' data-<name> */
    const legacy = framed(page.id).replace(/ data-scroll(="")?(?=[\s>])/, '')
    const [root] = instances(legacy)
    expect(root).toContain(`${INSTANCE_ATTR}=`)
    expect(root).toContain(`${REV_ATTR}=`)
    expect(root).not.toMatch(/ data-(scroll|stretch)(?=[\s>=])/)

    actions.updateFrame(page.id, { html: legacy }, actor)
    expect(framed(page.id)).not.toContain(PROPS_ATTR)
    expect(instances(framed(page.id))[0]).toMatch(/ data-scroll(?=[\s>=])/)
  })

  it('files no new revision when an unchanged main is saved again', () => {
    const { canvas, def, mainFrame } = setup()
    const before = current(canvas.id, def.id)
    actions.updateFrame(mainFrame.id, { html: framed(mainFrame.id) }, actor)
    actions.updateFrame(mainFrame.id, { html: framed(mainFrame.id) }, actor)
    const after = current(canvas.id, def.id)
    expect(after.rev).toBe(before.rev)
    expect(after.props).toEqual(before.props)
    expect(after.template).toBe(before.template)
  })
})

describe('a declared boolean with no default that a condition names', () => {
  it('defaults to true, so a default instance shows its content and wears data-<name>', () => {
    const canvas = store.createCanvas('default-less boolean')
    const def = blankComponent({ name: 'Badge', by: 'Tester', props: [{ name: 'icon', type: 'boolean' }] })
    store.saveComponent(canvas.id, def)
    const mainFrame = actions.createFrame(canvas.id, { name: 'Main', html: '' }, actor)!
    const main = `<span class="badge" ${COMPONENT_ATTR}="${def.id}"><i data-doop-if="icon">★</i>New</span>`
    actions.updateFrame(mainFrame.id, { html: doc(main) }, actor)
    expect(current(canvas.id, def.id).props.find((prop) => prop.name === 'icon')?.default).toBe('true')

    const page = actions.createFrame(canvas.id, { name: 'Page', html: '' }, actor)!
    actions.updateFrame(page.id, { html: doc(`<doop-use component="Badge"></doop-use>`) }, actor)
    const html = framed(page.id)
    expect(html).toContain('★')
    expect(html.match(/<span\b[^>]*>/)?.[0]).toMatch(/ data-icon(?=[\s>=])/)
  })

  it('keeps the order its props were derived in, so re-saving an unchanged main files no new revision', () => {
    const canvas = store.createCanvas('derived prop order')
    const def = blankComponent({ name: 'Badge', by: 'Tester' })
    store.saveComponent(canvas.id, def)
    const mainFrame = actions.createFrame(canvas.id, { name: 'Main', html: '' }, actor)!
    const main = `<span class="badge" ${COMPONENT_ATTR}="${def.id}"><b ${BIND_ATTR}="label">New</b><i data-doop-if="icon">★</i></span>`
    actions.updateFrame(mainFrame.id, { html: doc(main) }, actor)
    const before = current(canvas.id, def.id)
    /* in the order the template names them, as before booleans showed on the root */
    expect(before.props.map((prop) => prop.name)).toEqual(['label', 'icon'])
    actions.updateFrame(mainFrame.id, { html: framed(mainFrame.id) }, actor)
    const after = current(canvas.id, def.id)
    expect(after.rev).toBe(before.rev)
    expect(after.props).toEqual(before.props)
  })
})

describe('a boolean whose data-<name> the root binds itself', () => {
  /** A Card whose root binds `data-x` to its boolean x, rendering "true" / "false", plus an unbound boolean y. */
  function setupBound() {
    const canvas = store.createCanvas('bound boolean attribute')
    const def = blankComponent({
      name: 'Card',
      by: 'Tester',
      props: [
        { name: 'x', type: 'boolean', default: 'false' },
        { name: 'y', type: 'boolean', default: 'true' },
      ],
    })
    store.saveComponent(canvas.id, def)
    const mainFrame = actions.createFrame(canvas.id, { name: 'Main', html: '' }, actor)!
    const main = `<section class="card" ${COMPONENT_ATTR}="${def.id}" data-x="false" ${BIND_ATTR}="data-x:x">Card</section>`
    actions.updateFrame(mainFrame.id, { html: doc(main, '.card[data-x="true"] { color: red }') }, actor)
    const page = actions.createFrame(canvas.id, { name: 'Page', html: '' }, actor)!
    return { canvas, def, page }
  }

  it('keeps rendering "true" and "false" through the binding, so rules on those values still match', () => {
    const { canvas, def, page } = setupBound()
    expect(current(canvas.id, def.id).css).toContain('[data-x="true"]')
    actions.updateFrame(
      page.id,
      {
        html: doc(
          `<doop-use component="Card" x="true"></doop-use>` +
            `<doop-use component="Card" x="false"></doop-use>` +
            `<doop-use component="Card"></doop-use>`,
        ),
      },
      actor,
    )
    const [on, off, plain] = instances(framed(page.id), 'section')
    expect(on).toContain('data-x="true"')
    expect(off).toContain('data-x="false"')
    expect(plain).toContain('data-x="false"')
  })

  it('reads an edit to the bound attribute as its value, not as presence', () => {
    const { page } = setupBound()
    actions.updateFrame(page.id, { html: doc(`<doop-use component="Card" x="true"></doop-use>`) }, actor)
    actions.updateFrame(page.id, { html: framed(page.id).replace('data-x="true"', 'data-x="false"') }, actor)
    const [root] = instances(framed(page.id), 'section')
    /* "false" is the default, so no override is left */
    expect(markerProps(root!).x).toBeUndefined()
    expect(root).toContain('data-x="false"')
  })

  it('does not count the bound attribute when reading an instance rendered before booleans were marked', () => {
    const { page } = setupBound()
    actions.updateFrame(page.id, { html: doc(`<doop-use component="Card"></doop-use>`) }, actor)
    /* such an instance wears the bound data-x="false" and no data-y */
    const legacy = framed(page.id).replace(/ data-y(="")?(?=[\s>])/, '')
    expect(instances(legacy, 'section')[0]).not.toMatch(/ data-y(?=[\s>=])/)
    actions.updateFrame(page.id, { html: legacy }, actor)
    const [root] = instances(framed(page.id), 'section')
    expect(root).not.toContain(PROPS_ATTR)
    expect(root).toMatch(/ data-y(?=[\s>=])/)
  })
})

describe('update_instances on a boolean prop', () => {
  it('reads "" as true, as a bare attribute on <doop-use> is, and null as back to the default', () => {
    const { canvas, page } = setup()
    actions.updateFrame(page.id, { html: doc(`<doop-use component="Tabs"></doop-use>`) }, actor)
    const instanceId = instanceIdOf(instances(framed(page.id))[0]!)
    expect(instanceId).not.toBe('')

    changeInstances(canvas.id, page.id, [{ instanceId, props: { stretch: '' } }], actor)
    const [stretched] = instances(framed(page.id))
    expect(stretched).toMatch(/ data-stretch(?=[\s>=])/)
    expect(markerProps(stretched!).stretch).toBe('true')

    changeInstances(canvas.id, page.id, [{ instanceId, props: { stretch: null } }], actor)
    const [plain] = instances(framed(page.id))
    expect(plain).not.toContain('data-stretch')
    expect(plain).not.toContain(PROPS_ATTR)
  })
})
