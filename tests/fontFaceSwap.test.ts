import { describe, expect, it } from 'vitest'
import { fontFaceRule, swapFaceRules, withFontFaces, type CustomFont } from '../shared/fonts'

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
    const html = withFontFaces(
      written,
      [medium, bold],
      [
        { from: old500.url, to: medium },
        { from: old600.url, to: bold },
      ],
    )
    expect(html).not.toContain(old500.url)
    expect(html).not.toContain(old600.url)
    expect(html).toContain(fontFaceRule(medium))
    expect(html).toContain(fontFaceRule(bold))
    expect(count(html, '@font-face')).toBe(2)
  })

  it('drops a rule when a library face now covers the same family, weight and style', () => {
    const next = face('500', 'medium-fixed')
    const html = withFontFaces(doc(`<style data-doop-fonts>\n${fontFaceRule(medium)}\n</style>`), [next])
    expect(html).not.toContain(medium.url)
    expect(html).toContain(fontFaceRule(next))
    expect(count(html, '@font-face')).toBe(1)
  })

  it('an edit after a replace leaves one rule per face', () => {
    const edited = withFontFaces(
      written,
      [medium, bold],
      [
        { from: old500.url, to: medium },
        { from: old600.url, to: bold },
      ],
    )
    const again = withFontFaces(edited.replace('Hi', 'Hello'), [medium, bold])
    expect(count(again, '@font-face')).toBe(2)
  })

  it('keeps the rule of a face that left the library with nothing replacing it', () => {
    const html = withFontFaces(written, [medium])
    expect(html).toContain(old500.url)
    expect(html).toContain(old600.url)
    expect(html).toContain(medium.url)
  })

  it('never touches a rule the design wrote outside the block', () => {
    const own = `<style>@font-face{font-family:"Swap Sans";src:url("https://doop.test/a/own.woff2");font-weight:500}</style>`
    const html = withFontFaces(
      doc(`${own}<style data-doop-fonts>\n${fontFaceRule(old500)}\n</style>`),
      [medium],
      [{ from: old500.url, to: medium }],
    )
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
      [{ from: old500.url, to: medium }],
    )
    expect(html).not.toContain('data-doop-fonts')
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
