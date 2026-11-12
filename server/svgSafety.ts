/**
 * What an uploaded SVG may not carry. Assets are images: frames reference
 * them with <img> or CSS, where an SVG never runs code. Scripts and event
 * handlers only matter when the file is opened as a document, and a CDATA
 * section lets a file carry a stylesheet or a script verbatim for a frame
 * to fetch and evaluate. A frame's own CSS and JS belong inline in its
 * HTML, so none of these has a use here.
 * <foreignObject> stays allowed: diagram exporters (draw.io, Mermaid) use it
 * for labels, and it is as inert as the rest of the file in an <img>.
 *
 * Text-level checks on purpose: they catch what exporters and agents write,
 * not a file built to slip past them. Markup hidden through entities still
 * renders inert as an image, though a frame that parses the file as markup
 * gets it decoded. Comments are dropped first, so commented-out markup is
 * ignored, up to a DOCTYPE the check cannot read: after one, comments stay
 * and commented-out markup is refused like any other. The <script> rule
 * takes any namespace prefix (`<svg:script`). Handlers and javascript: URLs
 * count only inside a tag, between its `<` and `>`: an `on…=` attribute
 * outside any quoted value, or a quoted value that opens with
 * `javascript:`. Words in text content never match.
 */

/** From a `<` up to a point inside the same tag that is outside any quoted
 *  value (which may hold `>`). */
const IN_TAG = String.raw`<[^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*`

const RULES: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /<(?:[^\s<>/:]+:)?script[\s>/]/i, what: 'a <script> element' },
  { pattern: /<!\[CDATA\[/, what: 'a CDATA section' },
  {
    pattern: new RegExp(String.raw`${IN_TAG}\son[a-z]+\s*=`, 'i'),
    what: 'an event handler attribute (on…=)',
  },
  {
    pattern: new RegExp(String.raw`${IN_TAG}=\s*["']\s*javascript\s*:`, 'i'),
    what: 'a javascript: URL',
  },
]

/**
 * Finds terminators in `svg`, searching to the end of the file at most once
 * per terminator: one missing after some point is missing after every later
 * point too.
 */
function terminatorFinder(svg: string): (terminator: string, from: number) => number {
  const missingFrom = new Map<string, number>()
  /** Index just past the first `terminator` at or after `from`, or -1. */
  return (terminator, from) => {
    if (from >= (missingFrom.get(terminator) ?? Infinity)) return -1
    const at = svg.indexOf(terminator, from)
    if (at === -1) {
      missingFrom.set(terminator, from)
      return -1
    }
    return at + terminator.length
  }
}

const opensWith = (svg: string, at: number, opener: string) =>
  svg.slice(at, at + opener.length).toUpperCase() === opener

/**
 * Index just past the DOCTYPE opening at `at`, or -1 when it cannot be read:
 * a quoted literal, or a comment or instruction in the internal subset, that
 * never closes, or a subset with no `]` and `>` after it.
 */
function doctypeEnd(svg: string, at: number, find: ReturnType<typeof terminatorFinder>): number {
  let i = at + '<!DOCTYPE'.length
  let inSubset = false
  while (i !== -1 && i < svg.length) {
    const char = svg[i]
    if (char === '"' || char === "'") {
      i = find(char, i + 1)
    } else if (!inSubset) {
      if (char === '>') return i + 1
      inSubset = char === '['
      i++
    } else if (char === ']') {
      const close = /\s*>/y
      close.lastIndex = i + 1
      return close.test(svg) ? close.lastIndex : -1
    } else if (svg.startsWith('<!--', i)) {
      i = find('-->', i + 4)
    } else if (svg.startsWith('<?', i)) {
      i = find('?>', i + 2)
    } else {
      i++
    }
  }
  return -1
}

/**
 * Removes XML comments. Processing instructions, CDATA sections and
 * DOCTYPEs are skipped whole, left to right, with the terminators an XML
 * parser uses, so a `<!--` inside an instruction, a CDATA section or a
 * DOCTYPE's internal subset (an entity value may hold one) is not taken for
 * a comment that would swallow the markup after it. In a well-formed file,
 * where `<` cannot sit in text or an attribute value, removal can join text
 * but never hide it. An opener with no terminator is left as text and the
 * scan moves on; a DOCTYPE this cannot read stops all removal from there on.
 * A terminator found missing is never searched for again, and every other
 * search ends at a match the scan moves past, so it is linear in the file's
 * size.
 */
function withoutComments(svg: string): string {
  const find = terminatorFinder(svg)
  const kept: string[] = []
  let copiedTo = 0
  for (let at = svg.indexOf('<'); at !== -1; ) {
    let end = -1
    if (svg.startsWith('<!--', at)) {
      end = find('-->', at + 4)
      if (end !== -1) {
        kept.push(svg.slice(copiedTo, at))
        copiedTo = end
      }
    } else if (svg.startsWith('<?', at)) {
      end = find('?>', at + 2)
    } else if (opensWith(svg, at, '<![CDATA[')) {
      end = find(']]>', at + 9)
    } else if (opensWith(svg, at, '<!DOCTYPE')) {
      end = doctypeEnd(svg, at, find)
      if (end === -1) break
    }
    at = svg.indexOf('<', end === -1 ? at + 1 : end)
  }
  kept.push(svg.slice(copiedTo))
  return kept.join('')
}

/** The first thing that keeps this SVG from being a plain image, or
 *  undefined when it is one. */
export function svgPayloadProblem(svg: string): string | undefined {
  const markup = withoutComments(svg)
  return RULES.find((rule) => rule.pattern.test(markup))?.what
}
