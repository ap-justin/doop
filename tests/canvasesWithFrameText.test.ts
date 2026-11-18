import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import { db } from '../server/db/index.ts'
import * as t from '../server/db/schema.ts'

/* `canvasesWithFrameText` names the idle canvases a font swap has to read back: only
   those the caller listed, whichever of the texts their stored frames hold. */
vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  return { db: drizzle(new PGlite(), { schema }) }
})

const persist = await import('../server/db/persist.ts')

const frame = (id: string, canvasId: string, html: string) => ({
  id,
  canvasId,
  name: id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'test',
})

beforeAll(async () => {
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  await migrate(db as unknown as ReturnType<typeof pgliteDrizzle>, { migrationsFolder: 'server/db/migrations' })
  await db.insert(t.frames).values([
    frame('f-listed', 'listed', '<p>loads /a/one.woff2</p>'),
    frame('f-other-two', 'other-two', '<p>loads /a/two.woff2</p>'),
    frame('f-other-one', 'other-one', '<p>loads /a/one.woff2</p>'),
    frame('f-plain', 'plain', '<p>no fonts</p>'),
  ])
})

describe('canvasesWithFrameText', () => {
  it('names a listed canvas whose frame holds one of the texts', async () => {
    expect(await persist.canvasesWithFrameText(['listed', 'plain'], ['/a/one.woff2'])).toEqual(['listed'])
  })

  it.each([
    ['one.woff2 first', ['/a/one.woff2', '/a/two.woff2']],
    ['two.woff2 first', ['/a/two.woff2', '/a/one.woff2']],
  ])('leaves out a canvas that was not listed, whichever text matches it (%s)', async (_order, texts) => {
    /* other-one holds the first text and other-two the second: a filter bound to only
       one of the texts would let the unlisted canvas holding the other through */
    expect(await persist.canvasesWithFrameText(['listed'], texts)).toEqual(['listed'])
  })

  it('names nothing when no listed canvas holds a text', async () => {
    expect(await persist.canvasesWithFrameText(['plain'], ['/a/one.woff2', '/a/two.woff2'])).toEqual([])
  })
})
