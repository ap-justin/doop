import { describe, expect, it } from 'vitest'
import { fontFaceRule, swapFaceRules, withFontFaces, withLibraryFaceRules, type CustomFont } from '../shared/fonts'

/**
 * `withFontFaces` rebuilds Doop's `<style data-doop-fonts>` block from the library:
 * a replaced face's rule is swapped for its successor, a deleted face's rule stays,
 * and nothing outside the block is touched.
 */

function face(weight: string, file: string, style: CustomFont['style'] = 'normal'): CustomFont {
  return {
    id: file,
    family: 'Swap Sans',
    weight,
    style,
    format: 'woff2',
    url: `https://doop.test/a/${file}.woff2`,
    fileName: `${file}.woff2`,
    size: 1,
    createdAt: 1,
  }
}

const doc = (head: string) =>
  `<!doctype html><html><head>${head}</head><body><p style="font-family:'Swap Sans'">Hi</p></body></html>`
const count = (html: string, text: string) => html.split(text).length - 1

describe('withFontFaces rebuilding the block', () => {
  const old500 = face('596', 'old-medium')
  const old600 = face('707', 'old-bold')
  const medium = face('500', 'medium')
  const bold = face('700', 'bold')
  const written = doc(`<style data-doop-fonts>\n${fontFaceRule(old500)}\n${fontFaceRule(old600)}\n</style>`)

  it('swaps a replaced face named by URL, without the frame being edited', () => {
    const html = withFontFaces(written, [medium, bold], {
      rebuild: true,
      replaced: [
        { from: old500.url, to: medium },
        { from: old600.url, to: bold },
      ],
    })
    expect(html).not.toContain(old500.url)
    expect(html).not.toContain(old600.url)
    expect(html).toContain(fontFaceRule(medium))
    expect(html).toContain(fontFaceRule(bold))
    expect(count(html, '@font-face')).toBe(2)
  })

  it('drops a rule when a library face now covers the same family, weight and style', () => {
    const next = face('500', 'medium-fixed')
    const html = withFontFaces(doc(`<style data-doop-fonts>\n${fontFaceRule(medium)}\n</style>`), [next], {
      rebuild: true,
    })
    expect(html).not.toContain(medium.url)
    expect(html).toContain(fontFaceRule(next))
    expect(count(html, '@font-face')).toBe(1)
  })

  it('an edit after a replace leaves one rule per face', () => {
    const edited = withFontFaces(written, [medium, bold], {
      rebuild: true,
      replaced: [
        { from: old500.url, to: medium },
        { from: old600.url, to: bold },
      ],
    })
    const again = withFontFaces(edited.replace('Hi', 'Hello'), [medium, bold], { rebuild: true })
    expect(count(again, '@font-face')).toBe(2)
  })

  it('keeps the rule of a face that left the library with nothing replacing it', () => {
    const html = withFontFaces(written, [medium], { rebuild: true })
    expect(html).toContain(old500.url)
    expect(html).toContain(old600.url)
    expect(html).toContain(medium.url)
  })

  it('never touches a rule the design wrote outside the block', () => {
    const own = `<style>@font-face{font-family:"Swap Sans";src:url("https://doop.test/a/own.woff2");font-weight:500}</style>`
    const html = withFontFaces(doc(`${own}<style data-doop-fonts>\n${fontFaceRule(old500)}\n</style>`), [medium], {
      rebuild: true,
      replaced: [{ from: old500.url, to: medium }],
    })
    expect(html).toContain(own)
    expect(html).not.toContain(old500.url)
  })

  it('returns the same string when the block is already current', () => {
    const current = withFontFaces(doc(''), [medium, bold])
    expect(withFontFaces(current, [medium, bold])).toBe(current)
  })

  it('removes the block when nothing in it is used any more', () => {
    const html = withFontFaces(
      `<html><head><style data-doop-fonts>\n${fontFaceRule(old500)}\n</style></head><body>x</body></html>`,
      [medium],
      { rebuild: true, replaced: [{ from: old500.url, to: medium }] },
    )
    expect(html).not.toContain('data-doop-fonts')
  })
})

describe('withFontFaces without rebuild (a browser save)', () => {
  const old = face('400', 'regular')
  const next = face('400', 'regular-fixed')

  it('keeps the server’s rule for a replaced face when the library it holds is out of date', () => {
    const current = doc(`<style data-doop-fonts>\n${fontFaceRule(next)}\n</style>`)
    expect(withFontFaces(current, [old])).toBe(current)
  })

  it('never removes a rule, even one the library has since replaced', () => {
    const written = doc(`<style data-doop-fonts>\n${fontFaceRule(old)}\n</style>`)
    expect(withFontFaces(written, [next])).toBe(written)
  })
})

describe('a family with an apostrophe', () => {
  const quoted = (weight: string, file: string): CustomFont => ({ ...face(weight, file), family: "O'Neil Sans" })
  const page = (head: string) =>
    `<html><head>${head}</head><body><p style="font-family:&quot;O'Neil Sans&quot;">Hi</p></body></html>`

  it('is read from its rule, so a replaced face leaves one rule', () => {
    const old = quoted('400', 'oneil')
    const next = quoted('400', 'oneil-fixed')
    const html = withFontFaces(page(`<style data-doop-fonts>\n${fontFaceRule(old)}\n</style>`), [next], {
      rebuild: true,
    })
    expect(html).not.toContain(old.url)
    expect(count(html, '@font-face')).toBe(1)
  })
})

describe('withLibraryFaceRules', () => {
  it('rewrites a rule for a face the library has from another file, and leaves the rest', () => {
    const old = face('400', 'a')
    const next = face('400', 'a2')
    const other = `@font-face{font-family:"Elsewhere";src:url("https://example.test/e.woff2")}`
    const css = `.x{color:red}\n${fontFaceRule(old)}\n${other}`
    expect(withLibraryFaceRules(css, [next])).toBe(`.x{color:red}\n${fontFaceRule(next)}\n${other}`)
    expect(withLibraryFaceRules(css, [old])).toBe(css)
  })
})

describe('swapFaceRules', () => {
  it('rewrites only the rules loading a replaced URL', () => {
    const a = face('400', 'a')
    const b = face('700', 'b')
    const next = face('400', 'a2')
    const css = `.x{color:red}\n${fontFaceRule(a)}\n${fontFaceRule(b)}`
    expect(swapFaceRules(css, [{ from: a.url, to: next }])).toBe(
      `.x{color:red}\n${fontFaceRule(next)}\n${fontFaceRule(b)}`,
    )
  })
})

describe('a written rule pointed at the face that replaced its file', () => {
  const old = face('400', 'kept')
  const next = face('400', 'kept2')
  /* a carried layer's scoped family, with descriptors Doop never writes */
  const written =
    `@font-face{font-family:"Swap Sans__c1";src:local("Swap Sans"),url("${old.url}") format("woff2");` +
    `font-weight:400;font-style:normal;unicode-range:U+0000-00FF}`

  it('swapFaceRules keeps the family and every other descriptor', () => {
    const swapped = swapFaceRules(written, [{ from: old.url, to: next }])
    expect(swapped).toBe(written.replace(old.url, next.url))
  })

  it('withLibraryFaceRules keeps them too', () => {
    const own = `@font-face{font-family:"Swap Sans";src:url("${old.url}");font-weight:400;unicode-range:U+0100}`
    expect(withLibraryFaceRules(own, [next])).toBe(own.replace(old.url, next.url))
  })

  it('withLibraryFaceRules leaves a rule loading a file that is not an upload byte for byte', () => {
    const hosted = `@font-face{font-family:"Swap Sans";src:url(https://fonts.gstatic.com/s/swapsans/v1/a.woff2) format("woff2");font-weight:400}`
    const css = `${hosted}\n${fontFaceRule(old)}`
    expect(withLibraryFaceRules(css, [next])).toBe(`${hosted}\n${fontFaceRule(next)}`)
  })
})
