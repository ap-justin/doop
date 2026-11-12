/**
 * What an uploaded SVG may not carry. Assets are images: frames reference
 * them with <img> or CSS, where an SVG never runs code. Scripts, event
 * handlers and foreignObject only matter when the file is opened as a
 * document, and CDATA sections are how a file smuggles a stylesheet or a
 * script past the image check for a frame to fetch and evaluate. A frame's
 * own CSS and JS belong inline in its HTML, so none of these has a use here.
 *
 * Text-level checks on purpose: an SVG that hides these from a regex (say,
 * through entities) is still rendered as an image, where they do nothing.
 * Comments are dropped first, so commented-out markup is ignored. The
 * <script> and <foreignObject> rules take any namespace prefix
 * (`<svg:script`). Handlers and javascript: URLs count only inside a tag,
 * between its `<` and `>`: an `on…=` attribute outside any quoted value, or
 * a quoted value that opens with `javascript:`. Words in text content never
 * match.
 */

/** From a `<` up to a point inside the same tag that is outside any quoted
 *  value (which may hold `>`). */
const IN_TAG = String.raw`<[^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*`

const RULES: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /<(?:[^\s<>/:]+:)?script[\s>/]/i, what: 'a <script> element' },
  { pattern: /<(?:[^\s<>/:]+:)?foreignObject[\s>/]/i, what: 'a <foreignObject> element' },
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
 * Comments, processing instructions, CDATA sections and DOCTYPEs, matched
 * left to right with the terminators an XML parser uses, so a `<!--` inside
 * an instruction, a CDATA section or a DOCTYPE's internal subset (an entity
 * value may hold one) is not taken for a comment that would swallow the
 * markup after it. Only comments are removed; the rest are kept whole. In a
 * well-formed file, where `<` cannot sit in text or an attribute value,
 * removal can join text but never hide it. A DOCTYPE subset this cannot read
 * stops all removal from there on. Inside the subset, comments and
 * instructions cannot run past their first terminator, so a failed match
 * backtracks in linear time.
 */
const XML_SKIPPABLE =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE(?:[^[>"']|"[^"]*"|'[^']*')*(?:\[(?:<!--(?:[^-]|-(?!->))*-->|<\?(?:[^?]|\?(?!>))*\?>|"[^"]*"|'[^']*'|[^\]"'<]|<(?!!--|\?))*\]\s*)?>|<!DOCTYPE/gi

function withoutComments(svg: string): string {
  let unreadable = false
  return svg.replace(XML_SKIPPABLE, (token) => {
    if (/^<!DOCTYPE$/i.test(token)) unreadable = true
    return !unreadable && token.startsWith('<!--') ? '' : token
  })
}

/** The first thing that keeps this SVG from being a plain image, or
 *  undefined when it is one. */
export function svgPayloadProblem(svg: string): string | undefined {
  const markup = withoutComments(svg)
  return RULES.find((rule) => rule.pattern.test(markup))?.what
}
