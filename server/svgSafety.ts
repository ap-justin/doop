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
 */
const RULES: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /<script[\s>/]/i, what: 'a <script> element' },
  { pattern: /<foreignObject[\s>/]/i, what: 'a <foreignObject> element' },
  { pattern: /<!\[CDATA\[/, what: 'a CDATA section' },
  { pattern: /\son[a-z]+\s*=/i, what: 'an event handler attribute (on…=)' },
  { pattern: /javascript\s*:/i, what: 'a javascript: URL' },
]

/** The first thing that keeps this SVG from being a plain image, or
 *  undefined when it is one. */
export function svgPayloadProblem(svg: string): string | undefined {
  return RULES.find((rule) => rule.pattern.test(svg))?.what
}
