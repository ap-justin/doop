import { serializeOuter, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { attrOf, insertIntoHead, isElement, parseTemplateRoot, setAttr } from './componentEngine.ts'
import { MANAGED_STYLE_ATTRS, parseCss, scopeSelector, splitTopLevel, type CssNode } from './componentCss.ts'
import { COMPONENT_ATTR, INSTANCE_ATTR, MAIN_CSS_ATTR, USE_TAG } from '../shared/components.ts'
import { PROTO_ATTRS } from '../shared/prototype.ts'

type Element = Tree.Element

/** The parts of a component definition that name its classes. */
export interface ClassedParts {
  template: string
  css: string
  rawCss: string
}

/** A class a selector can name unescaped: an identifier start, so `.5` stays a number. */
const CLASS_NAME = /^(?:-?[A-Za-z_]|--)[\w-]*$/
const classesOf = (el: Element) => (attrOf(el, 'class') ?? '').split(/\s+/).filter(Boolean)
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/*
 * Comments, strings and unquoted url() are matched whole and passed through, so a `.pdf` in an
 * attribute value or a path is not a class; every other `.` before an identifier is a class dot,
 * after another class (`.a.b`), a tag (`span.sl`), `]` or `)` too. The identifier takes escapes
 * and non-ASCII, so `.hover\:x` and `.cardé` are never read as `hover` or `card`.
 */
const CSS_CLASSES =
  /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\burl\(\s*[^)'"\s]*\s*\)|(?<!\\)\.((?:[\w-]|[\u{80}-\u{10ffff}]|\\[\s\S])+)/giu

export const classesNamedIn = (css: string) =>
  new Set([...css.matchAll(CSS_CLASSES)].flatMap((match) => match[1] ?? []))

/** Values that hold script or a selector: inline handlers and prototype targets. */
const readsSelectors = (attr: string) =>
  attr.startsWith('on') || attr === PROTO_ATTRS.action || attr === PROTO_ATTRS.interactions

export const isolatedName = (name: string, componentId: string) => `${name}__in-${componentId}`

/** `sl__in-<id>` back to `sl`, for this component's id only: a nested component's names stay its own. */
function naturalName(name: string, componentId: string): string {
  const suffix = isolatedName('', componentId)
  return name.length > suffix.length && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name
}

/**
 * The renamed vocabulary lives in the stored definition and its instances only; a main in its frame
 * wears natural names, which its frame's stylesheet styles. This, `withNaturalFrameStyles` and
 * `naturalCss` undo the rename, so markup or CSS copied from get_component reads as the main's own.
 * True when it renamed anything.
 */
export function withNaturalClasses(root: Element, componentId: string): boolean {
  let changed = false
  const stack: Element[] = [root]
  for (let el = stack.pop(); el; el = stack.pop()) {
    const classes = classesOf(el)
    const natural = classes.map((name) => naturalName(name, componentId))
    if (natural.some((name, index) => name !== classes[index])) {
      setAttr(el, 'class', natural.join(' '))
      changed = true
    }
    stack.push(...el.childNodes.filter(isElement))
  }
  return changed
}

const MANAGED_STYLE_OPEN = new RegExp(`\\s(?:${[...MANAGED_STYLE_ATTRS].join('|')})(?=[\\s=>/])`)

/**
 * A rule of this component's sheet that ends at a nested component's root (`.plan .btn`) names the
 * class that root wore when the sheet was written. The nested root now wears the renamed class
 * (`btn__in-<nestedId>`), so the rule is read as naming that, or it would match nothing and be
 * dropped. A name this component's own elements wear too is left alone: it is not only the nested
 * root's.
 */
export function withNestedRootNames(sheet: string, main: Element): string {
  return nestedRootRenamer(main)(sheet)
}

/** Natural name to renamed name, for the classes nested instance roots wear and this main's own elements do not. */
function nestedRootRenamer(main: Element): (css: string) => string {
  const renamed = new Map<string, string>()
  const own = new Set<string>()
  const stack: Element[] = [main]
  for (let el = stack.pop(); el; el = stack.pop()) {
    const nested = el !== main ? attrOf(el, INSTANCE_ATTR) : undefined
    if (nested === undefined) {
      for (const name of classesOf(el)) own.add(name)
      stack.push(...el.childNodes.filter(isElement))
      continue
    }
    const suffix = isolatedName('', nested)
    for (const name of classesOf(el)) if (name.endsWith(suffix)) renamed.set(naturalName(name, nested), name)
  }
  return (css) =>
    renamed.size
      ? css.replace(CSS_CLASSES, (match, name: string | undefined) => {
          const to = name === undefined || own.has(name) ? undefined : renamed.get(name)
          return to === undefined ? match : `.${to}`
        })
      : css
}

/**
 * The names a sheet's `@layer` statements and blocks declare, in the order the cascade first sees them,
 * a sublayer by its full name (`ui.reset` for `@layer reset` inside `@layer ui {}`). An anonymous
 * layer's sublayers cannot be named, so they are left out.
 */
function layerOrder(nodes: CssNode[], order: string[] = [], parent = ''): string[] {
  const declare = (list: string) => {
    const names = list
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((name) => `${parent}${name}`)
    for (const name of names) if (!order.includes(name)) order.push(name)
    return names
  }
  for (const node of nodes) {
    if (node.kind === 'group' && /^@layer\b/i.test(node.prelude)) {
      const [name] = declare(node.prelude.replace(/^@layer\s*/i, ''))
      if (name) layerOrder(node.nodes, order, `${name}.`)
    } else if (node.kind === 'group') layerOrder(node.nodes, order, parent)
    else if (node.kind === 'atomic' && node.name === 'layer') declare(node.text.replace(/^@layer\s*|;$/gi, ''))
  }
  return order
}

/**
 * The rules of a main's natural sheet that end at a nested instance's root, as the main's own frame
 * needs them: the nested root wears its renamed class there, so the author's `.plan .btn` matches
 * nothing. Written with the renamed class and scoped to the main, so they reach the nested instance
 * and nothing else (`withNestedRootNames`'s output, narrowed to the rules it changed). A rule nested
 * in another (`.plan { & .btn {} }`) is kept alone under its scoped parent, without the parent's own
 * declarations. The block leads the frame's head, so when it carries a layer it first restates the
 * sheet's layer order: a layer first named here would otherwise rank ahead of the author's own order.
 */
export function nestedRootRules(sheet: string, main: Element, componentId: string): string {
  const rename = nestedRootRenamer(main)
  const scope = `[${COMPONENT_ATTR}="${componentId}"]`
  const keep = (nodes: CssNode[], top: boolean): string[] =>
    nodes.flatMap((node) => {
      if (node.kind === 'group') {
        const inner = keep(node.nodes, top)
        return inner.length ? [`${node.prelude} {\n${inner.join('\n')}\n}`] : []
      }
      if (node.kind !== 'rule') return []
      const selectors = splitTopLevel(node.selector, ',').map((selector) => selector.trim())
      const place = (selector: string) => (top ? scopeSelector(selector, scope) : selector)
      const renamed = selectors.flatMap((selector) => {
        const to = rename(selector)
        return to === selector ? [] : [place(to)]
      })
      if (renamed.length) return [`${renamed.join(', ')} {${rename(node.body)}}`]
      const inner = keep(parseCss(node.body), false)
      return inner.length ? [`${selectors.map(place).join(', ')} {\n${inner.join('\n')}\n}`] : []
    })
  const rules = keep(parseCss(sheet), true).join('\n')
  const layers = /@layer\b/i.test(rules) ? layerOrder(parseCss(sheet)) : []
  return layers.length ? `@layer ${layers.join(', ')};\n${rules}` : rules
}

/**
 * The root classes this save renames: on the main's root before it, in their natural spelling, and
 * worn renamed after. A class that was only just put on the root never reached an instance, so a
 * frame's rule for it loses nothing.
 */
export function newlyRenamedRootClasses(before: string, after: string, componentId: string): string[] {
  const rootClasses = (template: string) => {
    const root = template ? parseTemplateRoot(template) : undefined
    return root ? classesOf(root) : []
  }
  const had = new Set(rootClasses(before))
  const suffix = isolatedName('', componentId)
  return rootClasses(after)
    .filter((name) => name.endsWith(suffix) && !had.has(name) && had.has(naturalName(name, componentId)))
    .map((name) => naturalName(name, componentId))
}

/** The frame with this main's block of nested-root rules set to `css`, or gone when it is empty. It leads the head, before the frame's own styles. */
export function withMainCssBlock(html: string, componentId: string, css: string): string {
  const own = new RegExp(`<style[^>]*\\b${MAIN_CSS_ATTR}="${componentId}"[^>]*>[\\s\\S]*?</style>\\n?`, 'i')
  const bare = html.replace(own, '')
  if (!css) return bare
  const block = `<style ${MAIN_CSS_ATTR}="${componentId}">\n${css}\n</style>\n`
  const head = /<head\b[^>]*>\n?/i.exec(bare)
  if (head) return `${bare.slice(0, head.index + head[0].length)}${block}${bare.slice(head.index + head[0].length)}`
  return insertIntoHead(bare, block.trimEnd())
}

/** A stored template with this component's renamed classes put back, for a find written the way the
 *  main reads (an agent that never saw the renamed text). */
export function naturalTemplate(template: string, componentId: string): string {
  const root = parseTemplateRoot(template)
  if (!root || !withNaturalClasses(root, componentId)) return template
  return serializeOuter(root)
}

/** The frame's own `<style>` blocks with this component's renamed classes put back, so the frame's
 *  rules match the natural names its main wears. The blocks the definition does not read as the
 *  frame's own (`MANAGED_STYLE_ATTRS`: component, detached-copy, token and font blocks) keep their names; any other,
 *  carried and imported ones included, is read and written back the way the definition reads it. */
export function withNaturalFrameStyles(html: string, componentId: string): string {
  if (!html.includes(isolatedName('', componentId))) return html
  return html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (block, open: string, css: string, close: string) =>
    MANAGED_STYLE_OPEN.test(open) ? block : `${open}${naturalCss(css, componentId)}${close}`,
  )
}

export function naturalCss(css: string, componentId: string): string {
  return css.replace(CSS_CLASSES, (match, name: string | undefined) =>
    name === undefined ? match : `.${naturalName(name, componentId)}`,
  )
}

/**
 * A frame's own rules must not reach into a placed component: its `.sl` rule would match the
 * component's `sl` element too. So the classes the component's stylesheet styles are renamed,
 * in its template and in its stylesheets alike, with the component's id as the suffix.
 * The root is the component's own element too: a class on it that the stylesheet names is renamed
 * like any other, or the frame's `.sl` rule would restyle every instance. What the designer puts
 * on a placed instance (`<doop-use class>`, a class the frame adds to the root) is not in the
 * template and stays as written, so the frame still places and sizes the instance with its own
 * classes. Left alone: classes a nested component's root wears (this component's rules place it),
 * classes the stylesheet never names (utility classes), classes a script, style, inline handler or
 * prototype interaction in the template reads, and anything inside a nested instance, which is its
 * own component's. Renaming twice changes nothing, so a main regenerated from a renamed template
 * derives the same one again.
 */
export function isolateClasses(parts: ClassedParts, componentId: string): ClassedParts {
  const root = parseTemplateRoot(parts.template)
  if (!root) return parts
  const suffix = isolatedName('', componentId)
  const nestedRootClasses = new Set<string>()
  /* the root and everything below it that is this component's own */
  const inner: Element[] = [root]
  let sources = ''
  const stack: Element[] = [root]
  for (let el = stack.pop(); el; el = stack.pop()) {
    for (const attr of el.attrs) if (readsSelectors(attr.name)) sources += `\n${attr.value}`
    if (el.tagName === 'script' || el.tagName === 'style') {
      sources += `\n${el.childNodes.map((node) => ('value' in node ? node.value : '')).join('')}`
      continue
    }
    if (el !== root) {
      if (el.tagName === USE_TAG || attrOf(el, INSTANCE_ATTR) !== undefined) {
        for (const name of classesOf(el)) nestedRootClasses.add(name)
        continue
      }
      inner.push(el)
    }
    stack.push(...el.childNodes.filter(isElement))
  }
  const styled = classesNamedIn(parts.rawCss)
  const read = (name: string) => new RegExp(`(?<![\\w-])${escaped(name)}(?![\\w-])`).test(sources)
  const names = new Set(
    inner
      .flatMap(classesOf)
      .filter(
        (name) =>
          CLASS_NAME.test(name) &&
          !name.endsWith(suffix) &&
          !nestedRootClasses.has(name) &&
          styled.has(name) &&
          !read(name),
      ),
  )
  if (!names.size) return parts
  for (const el of inner) {
    const classes = classesOf(el)
    if (classes.some((name) => names.has(name)))
      setAttr(el, 'class', classes.map((name) => (names.has(name) ? isolatedName(name, componentId) : name)).join(' '))
  }
  const rename = (css: string) =>
    css.replace(CSS_CLASSES, (match, name: string | undefined) =>
      name !== undefined && names.has(name) ? `.${isolatedName(name, componentId)}` : match,
    )
  return { template: serializeOuter(root), css: rename(parts.css), rawCss: rename(parts.rawCss) }
}
