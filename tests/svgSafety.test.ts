import { describe, expect, it } from 'vitest'
import { svgPayloadProblem } from '../server/svgSafety.ts'

/**
 * server/svgSafety.ts: an uploaded SVG has to be a plain image. Anything
 * that only does something when the file is opened as a document, or that
 * carries a stylesheet or script for a frame to fetch, is refused.
 */

const wrap = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`

describe('svgPayloadProblem', () => {
  it('accepts plain vector art, including inline style', () => {
    expect(svgPayloadProblem(wrap('<path d="M0 0h24v24H0z" fill="#000"/>'))).toBeUndefined()
    const styled = wrap('<style>.a{fill:red}</style><circle class="a" cx="12" cy="12" r="6"/>')
    expect(svgPayloadProblem(styled)).toBeUndefined()
    const titled = `<?xml version="1.0"?>${wrap('<title>Logo</title><desc>Brand mark</desc>')}`
    expect(svgPayloadProblem(titled)).toBeUndefined()
    /* words that only look like the patterns stay allowed */
    expect(svgPayloadProblem(wrap('<text>description of onboarding</text>'))).toBeUndefined()
  })

  it('refuses a script element', () => {
    expect(svgPayloadProblem(wrap('<script>alert(1)</script>'))).toBe('a <script> element')
    expect(svgPayloadProblem(wrap('<SCRIPT type="text/javascript"/>'))).toBe('a <script> element')
  })

  it('refuses a CDATA payload in style or desc', () => {
    expect(svgPayloadProblem(wrap('<style><![CDATA[@font-face{font-family:x}]]></style>'))).toBe('a CDATA section')
    expect(svgPayloadProblem(wrap('<desc><![CDATA[window.run=function(){}]]></desc>'))).toBe('a CDATA section')
  })

  it('refuses event handlers, foreignObject and javascript: URLs', () => {
    expect(svgPayloadProblem(wrap('<rect onload="x()"/>'))).toBe('an event handler attribute (on…=)')
    expect(svgPayloadProblem(wrap('<foreignObject><div/></foreignObject>'))).toBe('a <foreignObject> element')
    expect(svgPayloadProblem(wrap('<a href="javascript:x()"><rect/></a>'))).toBe('a javascript: URL')
  })

  it('accepts text content that only reads like a handler or a javascript: URL', () => {
    expect(svgPayloadProblem(wrap('<text>one = two</text>'))).toBeUndefined()
    expect(svgPayloadProblem(wrap('<desc>JavaScript: the logo</desc>'))).toBeUndefined()
    expect(svgPayloadProblem(wrap('<rect aria-label="tap onclick=here"/>'))).toBeUndefined()
  })

  it('refuses handlers and javascript: URLs wherever they sit in a start tag', () => {
    const handler = 'an event handler attribute (on…=)'
    expect(svgPayloadProblem(wrap('<rect\n  onclick = "x()"/>'))).toBe(handler)
    expect(svgPayloadProblem(wrap('<rect aria-label="a>b" onload="x()"/>'))).toBe(handler)
    expect(svgPayloadProblem(wrap('<a href=" JavaScript:x()"><rect/></a>'))).toBe('a javascript: URL')
  })

  it('refuses namespace-prefixed script and foreignObject elements', () => {
    const prefixed = '<svg:script xmlns:svg="http://www.w3.org/2000/svg">alert(1)</svg:script>'
    expect(svgPayloadProblem(wrap(prefixed))).toBe('a <script> element')
    expect(svgPayloadProblem(wrap('<svg:foreignObject><div/></svg:foreignObject>'))).toBe('a <foreignObject> element')
  })

  it('ignores commented-out markup without letting a comment hide any', () => {
    expect(svgPayloadProblem(wrap('<!-- <rect onload="x()"/> <script>alert(1)</script> -->'))).toBeUndefined()
    expect(svgPayloadProblem(wrap('<scr<!-- -->ipt>alert(1)</script>'))).toBe('a <script> element')
    expect(svgPayloadProblem(wrap('<?pi <!-- ?><script>alert(1)</script><!-- -->'))).toBe('a <script> element')
    const entity = `<!DOCTYPE svg [<!ENTITY a "<!--">]>${wrap('<script>alert(1)</script><!-- -->')}`
    expect(svgPayloadProblem(entity)).toBe('a <script> element')
  })
})
