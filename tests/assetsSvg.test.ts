import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAsset } from '../server/assets.ts'

/**
 * createAsset and SVG uploads: the payload check runs on the whole file for
 * SVG only, refuses before anything is written, and leaves other types alone.
 * Object storage and the database are the boundary, stood in for below and
 * recording what reaches them.
 */

const written = vi.hoisted(() => ({
  objects: [] as { key: string; body: Buffer; mime: string }[],
  rows: [] as Record<string, unknown>[],
}))

vi.mock('../server/storage.ts', () => ({
  putObject: async (key: string, body: Buffer, mime: string) => {
    written.objects.push({ key, body, mime })
  },
}))

vi.mock('../server/db/index.ts', () => ({
  db: {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        written.rows.push(row)
      },
    }),
  },
}))

const meta = { uploadedBy: 'u1' }
const svg = (inner: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`)
const REFUSAL_HINT = "put a frame's CSS and JS inline in its HTML"

beforeEach(() => {
  written.objects.length = 0
  written.rows.length = 0
})

describe('createAsset with SVG', () => {
  it('stores a clean SVG as svg / image/svg+xml', async () => {
    const buf = svg('<path d="M0 0h24v24H0z"/>')
    const asset = await createAsset(buf, meta)
    expect(asset).toMatchObject({ mime: 'image/svg+xml', ext: 'svg', size: buf.length })
    expect(written.objects).toHaveLength(1)
    expect(written.objects[0]).toMatchObject({ key: `${asset.id}.svg`, mime: 'image/svg+xml' })
    expect(written.rows).toHaveLength(1)
    expect(written.rows[0]).toMatchObject({ id: asset.id, ext: 'svg', mime: 'image/svg+xml', uploadedBy: 'u1' })
  })

  it('stores an Illustrator export: declaration, generator comment and DOCTYPE ahead of the svg', async () => {
    const illustrator = Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 26.0.1, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
	<!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">
]>
<svg version="1.1" id="Layer_1" xmlns:x="&ns_extend;" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
<style type="text/css">.st0{fill:#fff}</style>
<path class="st0" d="M0 0h24v24H0z"/>
</svg>`)
    const asset = await createAsset(illustrator, meta)
    expect(asset).toMatchObject({ mime: 'image/svg+xml', ext: 'svg', size: illustrator.length })
    expect(written.objects).toHaveLength(1)
    expect(written.objects[0]?.body).toEqual(illustrator)
  })

  it('stores a draw.io diagram whose label sits in a foreignObject', async () => {
    const drawio = svg(
      '<switch><foreignObject pointer-events="none" width="100%" height="100%" style="overflow: visible; text-align: left;">' +
        '<div xmlns="http://www.w3.org/1999/xhtml" style="display: flex; width: 78px; height: 1px;">' +
        '<div style="display: inline-block; font-size: 12px; white-space: normal;">Label<br/></div></div></foreignObject>' +
        '<text x="40" y="34" font-size="12px" text-anchor="middle">Label</text></switch>',
    )
    const asset = await createAsset(drawio, meta)
    expect(asset).toMatchObject({ mime: 'image/svg+xml', ext: 'svg', size: drawio.length })
    expect(written.objects).toHaveLength(1)
    expect(written.rows).toHaveLength(1)
  })

  it.each([
    ['a script element', '<script>alert(1)</script>', 'a <script> element'],
    ['a CDATA section', '<style><![CDATA[.a{fill:red}]]></style>', 'a CDATA section'],
    ['an event handler', '<rect onload="x()"/>', 'an event handler attribute (on…=)'],
    ['a javascript: URL', '<a href="javascript:x()"><rect/></a>', 'a javascript: URL'],
  ])('refuses an SVG with %s, naming the rule and the way out, and writes nothing', async (_, inner, rule) => {
    await expect(createAsset(svg(inner), meta)).rejects.toThrow(
      `this SVG contains ${rule}, so it was not uploaded. Upload plain images only, and ${REFUSAL_HINT}`,
    )
    expect(written.objects).toEqual([])
    expect(written.rows).toEqual([])
  })

  it('refuses a payload past the first 1500 bytes, which is all the type sniff reads', async () => {
    const buf = svg(`${'<rect width="1" height="1"/>'.repeat(100)}<script>alert(1)</script>`)
    expect(buf.indexOf('<script>')).toBeGreaterThan(1500)
    await expect(createAsset(buf, meta)).rejects.toThrow(/a <script> element/)
    expect(written.objects).toEqual([])
    expect(written.rows).toEqual([])
  })
})

describe('createAsset with other types', () => {
  it('still stores a PNG whose bytes contain script and CDATA text', async () => {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const buf = Buffer.concat([signature, Buffer.from('<script>alert(1)</script><![CDATA[x]]>')])
    const asset = await createAsset(buf, meta)
    expect(asset).toMatchObject({ mime: 'image/png', ext: 'png', size: buf.length })
    expect(written.objects).toHaveLength(1)
    expect(written.objects[0]).toMatchObject({ key: `${asset.id}.png`, mime: 'image/png' })
    expect(written.rows).toHaveLength(1)
  })
})
