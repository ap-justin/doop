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
import { COMPONENT_ATTR, INSTANCE_ATTR } from '../shared/components.ts'
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
const instances = (html: string) => [...html.matchAll(/<nav\b[^>]*>/g)].map((match) => match[0])

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
