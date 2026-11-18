import { serializeOuter, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { attrOf, isElement, parseTemplateRoot, setAttr } from './componentEngine.ts'
import { INSTANCE_ATTR, USE_TAG } from '../shared/components.ts'

type Element = Tree.Element

/** The parts of a component definition that name its classes. */
export interface ClassedParts {
  template: string
  css: string
  rawCss: string
}

const CLASS_NAME = /^[\w-]+$/
const classesOf = (el: Element) => (attrOf(el, 'class') ?? '').split(/\s+/).filter(Boolean)
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const isolatedName = (name: string, componentId: string) => `${name}__in-${componentId}`

/**
 * A frame's own rules must not reach into a placed component: its `.sl` rule would match the
 * component's `sl` element too. So the classes the component's stylesheet styles are renamed,
 * in its template and in its stylesheets alike, with the component's id as the suffix.
 * Left alone: the root's classes (the frame places and sizes that element), classes the
 * stylesheet never names (utility classes), classes a script or style in the template reads,
 * and anything inside a nested instance, which is its own component's. Renaming twice changes
 * nothing, so a main regenerated from a renamed template derives the same one again.
 */
export function isolateClasses(parts: ClassedParts, componentId: string): ClassedParts {
  const root = parseTemplateRoot(parts.template)
  if (!root) return parts
  const suffix = isolatedName('', componentId)
  const rootClasses = new Set(classesOf(root))
  const inner: Element[] = []
  let sources = ''
  const stack: Element[] = [root]
  for (let el = stack.pop(); el; el = stack.pop()) {
    if (el.tagName === 'script' || el.tagName === 'style') {
      sources += `\n${el.childNodes.map((node) => ('value' in node ? node.value : '')).join('')}`
      continue
    }
    if (el !== root) {
      if (el.tagName === USE_TAG || attrOf(el, INSTANCE_ATTR) !== undefined) continue
      inner.push(el)
    }
    stack.push(...el.childNodes.filter(isElement))
  }
  const named = (text: string, name: string) => new RegExp(`(?<![\\w-])\\.${escaped(name)}(?![\\w-])`).test(text)
  const read = (name: string) => new RegExp(`(?<![\\w-])${escaped(name)}(?![\\w-])`).test(sources)
  const names = new Set(
    inner
      .flatMap(classesOf)
      .filter(
        (name) =>
          CLASS_NAME.test(name) &&
          !name.endsWith(suffix) &&
          !rootClasses.has(name) &&
          named(parts.rawCss, name) &&
          !read(name),
      ),
  )
  if (!names.size) return parts
  for (const el of inner) {
    const classes = classesOf(el)
    if (classes.some((name) => names.has(name)))
      setAttr(el, 'class', classes.map((name) => (names.has(name) ? isolatedName(name, componentId) : name)).join(' '))
  }
  const pattern = new RegExp(`(?<![\\w-])\\.(${[...names].map(escaped).join('|')})(?![\\w-])`, 'g')
  const rename = (css: string) => css.replace(pattern, (_, name: string) => `.${isolatedName(name, componentId)}`)
  return { template: serializeOuter(root), css: rename(parts.css), rawCss: rename(parts.rawCss) }
}
