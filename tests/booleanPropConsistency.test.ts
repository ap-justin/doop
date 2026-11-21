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
import * as propagation from '../server/propagation.ts'
import { blankComponent } from '../server/components.ts'
import { changeInstances, compactFrameHtml, updateComponent } from '../server/componentActions.ts'
import {
  BIND_ATTR,
  COMPONENT_ATTR,
  DETACHED_ATTR,
  INSTANCE_ATTR,
  PROPS_ATTR,
  type ComponentProp,
} from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

const doc = (body: string, css = '') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`

const TABS_CSS = `.tabs { display: block }
.tabs[data-stretch] { display: flex }
.tabs[data-scroll] { overflow-x: auto }`

const TABS_PROPS: ComponentProp[] = [
  { name: 'stretch', type: 'boolean', default: 'false' },
  { name: 'scroll', type: 'boolean', default: 'true' },
]

/** A canvas with a Tabs main (two booleans) and an empty page to place instances on. */
function setup(props: ComponentProp[] = TABS_PROPS, name = 'Tabs') {
  const canvas = store.createCanvas(`boolean follow-ups ${name}`)
  const def = blankComponent({ name, by: 'Tester', props })
  store.saveComponent(canvas.id, def)
  const mainFrame = actions.createFrame(canvas.id, { name: 'Main', html: '' }, actor)!
  const main = `<nav class="tabs" ${COMPONENT_ATTR}="${def.id}"><a href="#">One</a></nav>`
  actions.updateFrame(mainFrame.id, { html: doc(main, TABS_CSS) }, actor)
  const page = actions.createFrame(canvas.id, { name: 'Page', html: '' }, actor)!
  return { canvas, def, mainFrame, page }
}

const current = (canvasId: string, id: string) => store.getComponents(canvasId).find((d) => d.id === id)!
const framed = (id: string) => store.getFrame(id)!.html
const roots = (html: string, tag = 'nav') =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))].map((match) => match[0])
const mainRoot = (html: string, tag = 'nav') => roots(html, tag).find((root) => root.includes(COMPONENT_ATTR)) ?? ''
const instanceRoots = (html: string, tag = 'nav') => roots(html, tag).filter((root) => root.includes(INSTANCE_ATTR))
const wears = (root: string, name: string) => new RegExp(` data-${name}(?=[\\s>=])`).test(root)
const markerProps = (root: string): Record<string, string> => {
  const raw = root.match(new RegExp(`${PROPS_ATTR}="([^"]*)"`))?.[1]
  return raw ? (JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&')) as Record<string, string>) : {}
}
const idOf = (root: string) => root.match(/ data-doop-id="([^"]+)"/)?.[1] ?? ''

describe('the main of a component with boolean props', () => {
  it('wears data-<name> for each boolean that defaults to on, as a default instance does', () => {
    const { mainFrame } = setup()
    const root = mainRoot(framed(mainFrame.id))
    expect(wears(root, 'scroll')).toBe(true)
    expect(wears(root, 'stretch')).toBe(false)
  })

  it('does not store the attribute in the template, and files no revision when saved again', () => {
    const { canvas, def, mainFrame } = setup()
    const before = current(canvas.id, def.id)
    expect(before.template).not.toMatch(/data-scroll/)
    actions.updateFrame(mainFrame.id, { html: framed(mainFrame.id) }, actor)
    actions.updateFrame(mainFrame.id, { html: framed(mainFrame.id) }, actor)
    const after = current(canvas.id, def.id)
    expect(after.rev).toBe(before.rev)
    expect(after.template).toBe(before.template)
    expect(wears(mainRoot(framed(mainFrame.id)), 'scroll')).toBe(true)
  })

  it('follows a changed default', async () => {
    const { canvas, def, mainFrame } = setup()
    updateComponent(
      canvas.id,
      def.id,
      {
        props: [
          { name: 'stretch', type: 'boolean', default: 'true' },
          { name: 'scroll', type: 'boolean', default: 'false' },
        ],
      },
      actor,
    )
    await propagation.whenIdle()
    const root = mainRoot(framed(mainFrame.id))
    expect(wears(root, 'stretch')).toBe(true)
    expect(wears(root, 'scroll')).toBe(false)
  })

  it('leaves a boolean whose attribute the root binds itself as written', () => {
    const canvas = store.createCanvas('bound main')
    const def = blankComponent({ name: 'Card', by: 'Tester', props: [{ name: 'x', type: 'boolean', default: 'true' }] })
    store.saveComponent(canvas.id, def)
    const frame = actions.createFrame(canvas.id, { name: 'Main', html: '' }, actor)!
    const main = `<section class="card" ${COMPONENT_ATTR}="${def.id}" data-x="true" ${BIND_ATTR}="data-x:x">Card</section>`
    actions.updateFrame(frame.id, { html: doc(main) }, actor)
    /* the binding is in charge of data-x: the main and its template keep the value as written */
    expect(mainRoot(framed(frame.id), 'section')).toContain('data-x="true"')
    expect(current(canvas.id, def.id).template).toContain('data-x="true"')
  })
})

describe('a boolean a condition made up', () => {
  const BADGE = (inner: string, id: string) => `<span class="badge" ${COMPONENT_ATTR}="${id}">${inner}</span>`

  it('goes from the stored props once no condition names it', () => {
    const canvas = store.createCanvas('stale boolean')
    const def = blankComponent({ name: 'Badge', by: 'Tester' })
    store.saveComponent(canvas.id, def)
    const frame = actions.createFrame(canvas.id, { name: 'Main', html: '' }, actor)!
    actions.updateFrame(frame.id, { html: doc(BADGE('<i data-doop-if="icon">★</i>New', def.id)) }, actor)
    expect(current(canvas.id, def.id).props.map((prop) => prop.name)).toEqual(['icon'])

    actions.updateFrame(frame.id, { html: doc(BADGE('New', def.id)) }, actor)
    expect(current(canvas.id, def.id).props).toEqual([])
    expect(wears(mainRoot(framed(frame.id), 'span'), 'icon')).toBe(false)
  })

  it('stays when it was declared on its own, with the condition gone', () => {
    const canvas = store.createCanvas('declared boolean')
    const def = blankComponent({
      name: 'Badge',
      by: 'Tester',
      props: [{ name: 'icon', type: 'boolean', default: 'true' }],
    })
    store.saveComponent(canvas.id, def)
    const frame = actions.createFrame(canvas.id, { name: 'Main', html: '' }, actor)!
    actions.updateFrame(frame.id, { html: doc(BADGE('<i data-doop-if="icon">★</i>New', def.id)) }, actor)
    actions.updateFrame(frame.id, { html: doc(BADGE('New', def.id)) }, actor)
    expect(current(canvas.id, def.id).props.map((prop) => prop.name)).toEqual(['icon'])
    expect(wears(mainRoot(framed(frame.id), 'span'), 'icon')).toBe(true)
  })

  it('keeps an enum prop the template does not use', () => {
    const { canvas, def, mainFrame } = setup([{ name: 'tone', type: 'enum', options: ['a', 'b'], default: 'a' }])
    actions.updateFrame(mainFrame.id, { html: framed(mainFrame.id) }, actor)
    expect(current(canvas.id, def.id).props.map((prop) => prop.name)).toEqual(['tone'])
  })
})

describe('an override equal to the default', () => {
  const place = (page: string, use: string) => actions.updateFrame(page, { html: doc(use) }, actor)

  it('is dropped when a boolean with no default is set to false', () => {
    const { page } = setup([{ name: 'icon', type: 'boolean' }])
    place(page.id, '<doop-use component="Tabs" icon="true"></doop-use>')
    /* an instance whose marker records "false" for a prop that was never on */
    const recorded = framed(page.id)
      .replace('&quot;true&quot;', '&quot;false&quot;')
      .replace(/ data-icon(="")?(?=[\s>])/, '')
    expect(markerProps(instanceRoots(recorded)[0]!)).toEqual({ icon: 'false' })
    actions.updateFrame(page.id, { html: recorded }, actor)
    expect(instanceRoots(framed(page.id))[0]).not.toContain(PROPS_ATTR)
  })

  it('is dropped when a boolean defaults to something that is not a literal true', () => {
    const { page } = setup([{ name: 'icon', type: 'boolean', default: 'yes' }])
    place(page.id, '<doop-use component="Tabs" icon="true"></doop-use>')
    actions.updateFrame(page.id, { html: framed(page.id) }, actor)
    expect(instanceRoots(framed(page.id))[0]).not.toContain(PROPS_ATTR)
  })

  it('stays when it differs from the default', () => {
    const { page } = setup([{ name: 'icon', type: 'boolean' }])
    place(page.id, '<doop-use component="Tabs" icon="true"></doop-use>')
    actions.updateFrame(page.id, { html: framed(page.id) }, actor)
    expect(markerProps(instanceRoots(framed(page.id))[0]!)).toEqual({ icon: 'true' })
  })
})

describe('boolean overrides on instances', () => {
  const place = (page: string, use = '<doop-use component="Tabs" stretch="true"></doop-use>') =>
    actions.updateFrame(page, { html: doc(use) }, actor)

  it('survive a new revision of the main', async () => {
    const { canvas, def, mainFrame, page } = setup()
    place(page.id)
    updateComponent(
      canvas.id,
      def.id,
      { html: `<nav class="tabs"><a href="#">One</a><a href="#">Two</a></nav>` },
      actor,
    )
    await propagation.whenIdle()
    expect(current(canvas.id, def.id).rev).toBe(2)
    expect(wears(mainRoot(framed(mainFrame.id)), 'scroll')).toBe(true)
    const [root] = instanceRoots(framed(page.id))
    expect(framed(page.id)).toContain('Two')
    expect(wears(root!, 'stretch')).toBe(true)
    expect(markerProps(root!).stretch).toBe('true')
  })

  it('are removed again by clearing the prop', () => {
    const { canvas, page } = setup()
    place(page.id)
    const id = idOf(instanceRoots(framed(page.id))[0]!)
    changeInstances(canvas.id, page.id, [{ instanceId: id, props: { stretch: null } }], actor)
    const [root] = instanceRoots(framed(page.id))
    expect(wears(root!, 'stretch')).toBe(false)
    expect(root).not.toContain(PROPS_ATTR)
  })

  it('are removed again by taking the attribute off the root', () => {
    const { page } = setup()
    place(page.id)
    actions.updateFrame(page.id, { html: framed(page.id).replace(/ data-stretch(="")?(?=[\s>])/, '') }, actor)
    const [root] = instanceRoots(framed(page.id))
    expect(wears(root!, 'stretch')).toBe(false)
    expect(root).not.toContain(PROPS_ATTR)
  })

  it('read "" as on, and anything but "false" as on, such as "0"', () => {
    const { page } = setup()
    place(
      page.id,
      '<doop-use component="Tabs" stretch=""></doop-use><doop-use component="Tabs" stretch="0"></doop-use>' +
        '<doop-use component="Tabs" scroll="false"></doop-use>',
    )
    const [bare, zero, off] = instanceRoots(framed(page.id))
    expect(wears(bare!, 'stretch')).toBe(true)
    expect(wears(zero!, 'stretch')).toBe(true)
    expect(wears(off!, 'scroll')).toBe(false)
  })

  it('read back in the short form and come out unchanged', () => {
    const { page } = setup()
    place(page.id)
    const full = framed(page.id)
    const compact = compactFrameHtml(store.getFrame(page.id)!)
    expect(compact).toContain('<doop-use')
    expect(compact).toMatch(/stretch/)
    expect(compact).not.toContain(INSTANCE_ATTR)
    actions.updateFrame(page.id, { html: compact }, actor)
    expect(framed(page.id)).toBe(full)
  })

  it('are carried by a nested instance', () => {
    const { canvas, page } = setup()
    const panel = blankComponent({ name: 'Panel', by: 'Tester' })
    store.saveComponent(canvas.id, panel)
    const frame = actions.createFrame(canvas.id, { name: 'Panel main', html: '' }, actor)!
    const inner = '<doop-use component="Tabs" stretch="true"></doop-use>'
    actions.updateFrame(
      frame.id,
      { html: doc(`<section class="panel" ${COMPONENT_ATTR}="${panel.id}">${inner}</section>`) },
      actor,
    )
    actions.updateFrame(page.id, { html: doc('<doop-use component="Panel"></doop-use>') }, actor)
    const [nested] = instanceRoots(framed(page.id)).filter((root) => root.startsWith('<nav'))
    expect(wears(nested!, 'stretch')).toBe(true)
    expect(wears(nested!, 'scroll')).toBe(true)
    /* the outer instance reads the nested state back from its own markup */
    actions.updateFrame(page.id, { html: framed(page.id) }, actor)
    expect(
      wears(
        instanceRoots(framed(page.id)).find((root) => root.startsWith('<nav'))!,
        'stretch',
      ),
    ).toBe(true)
  })

  it('apply to an instance of a library component, which has no main', () => {
    const { canvas, def } = setup()
    const library = current(canvas.id, def.id)
    const consumer = store.createCanvas('library consumer')
    store.saveComponent(consumer.id, {
      ...library,
      mainFrameId: null,
      source: { canvasId: canvas.id, componentId: library.id, rev: library.rev, library: true },
    })
    const page = actions.createFrame(consumer.id, { name: 'Page', html: '' }, actor)!
    place(page.id)
    const [root] = instanceRoots(framed(page.id))
    expect(wears(root!, 'stretch')).toBe(true)
    expect(wears(root!, 'scroll')).toBe(true)
    actions.updateFrame(page.id, { html: framed(page.id).replace(/ data-scroll(="")?(?=[\s>])/, '') }, actor)
    expect(markerProps(instanceRoots(framed(page.id))[0]!)).toEqual({ scroll: 'false', stretch: 'true' })
  })

  it('stay on a detached copy as the attributes it looked with', () => {
    const { canvas, page } = setup()
    place(page.id)
    const id = idOf(instanceRoots(framed(page.id))[0]!)
    changeInstances(canvas.id, page.id, [{ instanceId: id, detach: true }], actor)
    const html = framed(page.id)
    const copy = roots(html).find((root) => root.includes(DETACHED_ATTR))!
    expect(copy).not.toContain(INSTANCE_ATTR)
    expect(copy).not.toContain(PROPS_ATTR)
    expect(wears(copy, 'stretch')).toBe(true)
    expect(wears(copy, 'scroll')).toBe(true)
  })
})

describe('an enum prop beside the booleans', () => {
  const TONE: ComponentProp[] = [
    { name: 'tone', type: 'enum', options: ['solid', 'ghost'], default: 'solid' },
    { name: 'wide', type: 'boolean', default: 'true' },
  ]

  it('still shows its option on the instance root, and not on the main', () => {
    const { mainFrame, page } = setup(TONE)
    actions.updateFrame(
      page.id,
      { html: doc('<doop-use component="Tabs"></doop-use><doop-use component="Tabs" tone="ghost"></doop-use>') },
      actor,
    )
    const [plain, ghost] = instanceRoots(framed(page.id))
    expect(plain).toContain('data-tone="solid"')
    expect(ghost).toContain('data-tone="ghost"')
    expect(mainRoot(framed(mainFrame.id))).not.toContain('data-tone')
    expect(wears(mainRoot(framed(mainFrame.id)), 'wide')).toBe(true)
  })

  it('drops an option set back to the default, and keeps one that differs', () => {
    const { page } = setup(TONE)
    actions.updateFrame(
      page.id,
      {
        html: doc(
          '<doop-use component="Tabs" tone="solid"></doop-use><doop-use component="Tabs" tone="ghost"></doop-use>',
        ),
      },
      actor,
    )
    actions.updateFrame(page.id, { html: framed(page.id) }, actor)
    const [plain, ghost] = instanceRoots(framed(page.id))
    expect(plain).not.toContain(PROPS_ATTR)
    expect(markerProps(ghost!)).toEqual({ tone: 'ghost' })
  })
})
