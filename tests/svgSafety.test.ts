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

  it('refuses event handlers and javascript: URLs', () => {
    expect(svgPayloadProblem(wrap('<rect onload="x()"/>'))).toBe('an event handler attribute (on…=)')
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

  it('refuses a namespace-prefixed script element', () => {
    const prefixed = '<svg:script xmlns:svg="http://www.w3.org/2000/svg">alert(1)</svg:script>'
    expect(svgPayloadProblem(wrap(prefixed))).toBe('a <script> element')
  })

  it('ignores commented-out markup without letting a comment hide any', () => {
    expect(svgPayloadProblem(wrap('<!-- <rect onload="x()"/> <script>alert(1)</script> -->'))).toBeUndefined()
    expect(svgPayloadProblem(wrap('<scr<!-- -->ipt>alert(1)</script>'))).toBe('a <script> element')
    expect(svgPayloadProblem(wrap('<?pi <!-- ?><script>alert(1)</script><!-- -->'))).toBe('a <script> element')
    const entity = `<!DOCTYPE svg [<!ENTITY a "<!--">]>${wrap('<script>alert(1)</script><!-- -->')}`
    expect(svgPayloadProblem(entity)).toBe('a <script> element')
  })
})

describe('svgPayloadProblem on real exporter output', () => {
  it('accepts an Inkscape export with its namespaced attributes, RDF metadata and namedview', () => {
    const inkscape = `<svg xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:cc="http://creativecommons.org/ns#"
  xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://www.w3.org/2000/svg"
  xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
  xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="24" height="24" viewBox="0 0 24 24"
  id="svg8" version="1.1" inkscape:version="0.92.4" sodipodi:docname="icon.svg">
  <metadata id="metadata5"><rdf:RDF><cc:Work rdf:about=""><dc:format>image/svg+xml</dc:format>
  <dc:type rdf:resource="http://purl.org/dc/dcmitype/StillImage"/></cc:Work></rdf:RDF></metadata>
  <sodipodi:namedview id="base" pagecolor="#ffffff" bordercolor="#666666" borderopacity="1.0"
    inkscape:pageopacity="0.0" inkscape:zoom="1" inkscape:cx="12" inkscape:cy="12" showgrid="false"/>
  <path id="path4" d="M0 0h24v24H0z" style="fill:#000000;stroke-width:0.26"/>
</svg>`
    expect(svgPayloadProblem(inkscape)).toBeUndefined()
  })

  it('accepts a Figma or Sketch icon that clips and reuses through defs', () => {
    const figma = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"
  xmlns:xlink="http://www.w3.org/1999/xlink"><g clip-path="url(#a)"><use xlink:href="#b" transform="scale(.5)"/></g>
  <defs><clipPath id="a"><rect width="24" height="24" fill="#fff"/></clipPath><path id="b" d="M0 0h24v24H0z"/></defs></svg>`
    expect(svgPayloadProblem(figma)).toBeUndefined()
  })

  it('accepts a newer Illustrator export: declaration, generator comment, DOCTYPE with an entity, plain style', () => {
    const illustrator = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 26.0.1, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
	<!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">
]>
<svg version="1.1" id="Layer_1" xmlns:x="&ns_extend;" xmlns="http://www.w3.org/2000/svg"
	xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="0 0 24 24"
	style="enable-background:new 0 0 24 24;" xml:space="preserve">
<style type="text/css">.st0{fill:#fff}</style>
<path class="st0" d="M0 0h24v24H0z"/>
</svg>`
    expect(svgPayloadProblem(illustrator)).toBeUndefined()
  })

  it('accepts a simple-icons logo: one path with role and title', () => {
    const logo = `<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Example</title><path d="M12 0L24 24H0z"/></svg>`
    expect(svgPayloadProblem(logo)).toBeUndefined()
  })

  it('refuses an Illustrator-style CDATA-wrapped style (accepted trade-off)', () => {
    expect(svgPayloadProblem(wrap('<style><![CDATA[.st0{fill:red}]]></style>'))).toBe('a CDATA section')
  })
})

describe('svgPayloadProblem keeps its patterns tight', () => {
  it('lets near-misses through', () => {
    expect(svgPayloadProblem(wrap('<scripted/>'))).toBeUndefined()
    expect(svgPayloadProblem(wrap('<rect data-onclick="x"/>'))).toBeUndefined()
    expect(svgPayloadProblem(wrap('<a href="javascript"><rect/></a>'))).toBeUndefined()
    expect(svgPayloadProblem(wrap('<a href="javascript is a language"><rect/></a>'))).toBeUndefined()
  })

  it('matches the handler and javascript: rules in any letter case', () => {
    expect(svgPayloadProblem(wrap('<rect ONLOAD="x()"/>'))).toBe('an event handler attribute (on…=)')
    expect(svgPayloadProblem(wrap('<a href="JavaScript:x()"><rect/></a>'))).toBe('a javascript: URL')
  })

  it('treats a tab before a handler like a space', () => {
    expect(svgPayloadProblem(wrap('<rect\tonclick="x()"/>'))).toBe('an event handler attribute (on…=)')
  })

  it('reads single-quoted attribute values like double-quoted ones', () => {
    expect(svgPayloadProblem(wrap("<a href='javascript:x()'><rect/></a>"))).toBe('a javascript: URL')
    expect(svgPayloadProblem(wrap("<rect aria-label='a>b' onload='x()'/>"))).toBe('an event handler attribute (on…=)')
    expect(svgPayloadProblem(wrap("<rect aria-label='tap onclick=here'/>"))).toBeUndefined()
  })

  it('refuses a script element however its name ends', () => {
    const script = 'a <script> element'
    expect(svgPayloadProblem(wrap('<script/>'))).toBe(script)
    expect(svgPayloadProblem(wrap('<script\n>alert(1)</script>'))).toBe(script)
    expect(svgPayloadProblem(wrap('<script\ttype="text/javascript">alert(1)</script>'))).toBe(script)
  })

  it('refuses whitespace before the colon of a javascript: URL and an unquoted handler value', () => {
    expect(svgPayloadProblem(wrap('<a href="javascript :x()"><rect/></a>'))).toBe('a javascript: URL')
    expect(svgPayloadProblem(wrap('<rect onload=x/>'))).toBe('an event handler attribute (on…=)')
  })
})

describe('svgPayloadProblem and foreignObject', () => {
  /* diagram exporters write labels in foreignObject on purpose */
  const drawio = wrap(
    '<switch><foreignObject pointer-events="none" width="100%" height="100%" ' +
      'requiredFeatures="http://www.w3.org/TR/SVG11/feature#Extensibility" style="overflow: visible; text-align: left;">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" style="display: flex; align-items: unsafe center; ' +
      'justify-content: unsafe center; width: 78px; height: 1px; padding-top: 30px; margin-left: 1px;">' +
      '<div style="display: inline-block; font-size: 12px; font-family: Helvetica; color: #000000; line-height: 1.2; ' +
      'pointer-events: all; white-space: normal; overflow-wrap: normal;">Label<br/></div></div></foreignObject>' +
      '<text x="40" y="34" fill="#000000" font-family="Helvetica" font-size="12px" text-anchor="middle">Label</text></switch>',
  )
  const mermaid = wrap(
    '<foreignObject width="80" height="24"><div xmlns="http://www.w3.org/1999/xhtml" ' +
      'style="display: inline-block; white-space: nowrap;"><span class="nodeLabel">Start</span></div></foreignObject>',
  )

  it('accepts a draw.io label with its text fallback and a Mermaid node label', () => {
    expect(svgPayloadProblem(drawio)).toBeUndefined()
    expect(svgPayloadProblem(mermaid)).toBeUndefined()
  })

  it('accepts a prefixed or upper-case foreignObject', () => {
    expect(svgPayloadProblem(wrap('<svg:foreignObject><div>Label</div></svg:foreignObject>'))).toBeUndefined()
    expect(svgPayloadProblem(wrap('<FOREIGNOBJECT><div>Label</div></FOREIGNOBJECT>'))).toBeUndefined()
  })

  it('still refuses a handler, a script and a javascript: link inside it', () => {
    const xhtml = 'xmlns="http://www.w3.org/1999/xhtml"'
    const inside = (html: string) => wrap(`<foreignObject>${html}</foreignObject>`)
    expect(svgPayloadProblem(inside(`<div ${xhtml} onmouseover="x()">Label</div>`))).toBe(
      'an event handler attribute (on…=)',
    )
    expect(svgPayloadProblem(inside(`<script ${xhtml}>alert(1)</script>`))).toBe('a <script> element')
    expect(svgPayloadProblem(inside(`<a ${xhtml} href="javascript:x()">Label</a>`))).toBe('a javascript: URL')
  })
})

describe('svgPayloadProblem on openers that never close', () => {
  /* At 1 MB a scan that restarts its search at every opener takes from
   * 15 s (CDATA) to minutes (DOCTYPE); a linear one takes about 100 ms. */
  const size = 1024 * 1024
  const cases = [
    ['<!DOCTYPE [', '', undefined],
    ['<!DOCTYPE [', ']x', undefined], // a stray ] closes every subset but no `>` follows it
    ['<!DOCTYPE "', '', undefined],
    ['<![CDATA[', '', 'a CDATA section'],
    ['<!--', '', undefined],
    ['<?', '', undefined],
  ] as const

  it.each(cases)('reads 1 MB of repeated %s then %j in linear time', (opener, tail, problem) => {
    const svg = `<svg>${opener.repeat(Math.ceil(size / opener.length))}${tail}`
    const started = performance.now()
    expect(svgPayloadProblem(svg)).toBe(problem)
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('keeps an unclosed comment, so it cannot hide the markup after it', () => {
    expect(svgPayloadProblem('<svg><!-- <script>alert(1)</script>')).toBe('a <script> element')
  })
})

describe('svgPayloadProblem after a DOCTYPE it cannot read', () => {
  const commented = '<svg><!-- <script>alert(1)</script> --></svg>'

  it('ignores the same commented-out script after a DOCTYPE it can read', () => {
    expect(svgPayloadProblem(`<!DOCTYPE svg>${commented}`)).toBeUndefined()
  })

  it.each([
    ['a quoted literal that never closes', '<!DOCTYPE svg "unterminated'],
    ['an internal subset that never closes', '<!DOCTYPE svg [ <!ENTITY a "b">'],
    ['an internal subset closed by ] with no > after it', '<!DOCTYPE svg [ ]x'],
  ])('refuses commented-out markup after %s', (_, doctype) => {
    expect(svgPayloadProblem(`${doctype}${commented}`)).toBe('a <script> element')
  })
})
