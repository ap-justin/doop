import { serializeOuter, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { attrOf, isElement, parseTemplateRoot, setAttr } from './componentEngine.ts'
import { INSTANCE_ATTR, USE_TAG } from '../shared/components.ts'
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

const classesNamedIn = (css: string) => new Set([...css.matchAll(CSS_CLASSES)].flatMap((match) => match[1] ?? []))

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
 * wears natural names, which its frame's stylesheet styles. These undo the rename, so markup or CSS
 * copied from get_component reads as the main's own.
 */
export function withNaturalClasses(root: Element, componentId: string): void {
  const stack: Element[] = [root]
  for (let el = stack.pop(); el; el = stack.pop()) {
    const classes = classesOf(el)
    const natural = classes.map((name) => naturalName(name, componentId))
    if (natural.some((name, index) => name !== classes[index])) setAttr(el, 'class', natural.join(' '))
    stack.push(...el.childNodes.filter(isElement))
  }
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
 * Left alone: the root's classes (the frame places and sizes that element), classes a nested
 * component's root wears (this component's rules place it), classes the stylesheet never names
 * (utility classes), classes a script, style, inline handler or prototype interaction in the
 * template reads, and anything inside a nested instance, which is its own component's. Renaming
 * twice changes nothing, so a main regenerated from a renamed template derives the same one again.
 */
export function isolateClasses(parts: ClassedParts, componentId: string): ClassedParts {
  const root = parseTemplateRoot(parts.template)
  if (!root) return parts
  const suffix = isolatedName('', componentId)
  const rootClasses = new Set(classesOf(root))
  const nestedRootClasses = new Set<string>()
  const inner: Element[] = []
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
          !rootClasses.has(name) &&
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
