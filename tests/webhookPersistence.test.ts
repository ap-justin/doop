import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import * as schema from '../server/db/schema.ts'
import type { Canvas } from '../shared/types.ts'

/**
 * A webhook's workspace limit survives a restart: create and update write
 * `workspace_ids`, and the boot load puts it back. A real migrated PGlite
 * stands in for the database, so what is asserted is what the rows hold and
 * what a rebooted registry does with them. Only DNS, HTTP and workspace
 * membership are stubbed.
 */

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  access: vi.fn((_userId: string, _canvas: unknown) => true),
  aliceIn: new Set<string>(),
}))
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }))
vi.mock('../server/db/index.ts', async () => {
  const database = drizzle(new PGlite(), { schema })
  await migrate(database, { migrationsFolder: 'server/db/migrations' })
  return { db: database }
})
vi.mock('../server/access.ts', () => ({ hasDurableCanvasAccess: mocks.access }))
vi.mock('../server/store.ts', () => ({
  store: { getCanvas: (id: string) => CANVASES.find((c) => c.id === id) },
}))
vi.mock('../server/workspaces.ts', () => ({
  getWorkspace: (id: string) => ({ id, name: id === 'ws-a' ? 'Alpha' : 'Beta' }),
  isWorkspaceMember: (id: string, userId?: string) => userId === 'alice' && mocks.aliceIn.has(id),
}))

const CANVAS: Canvas = { id: 'c1', name: 'Landing', ownerId: 'alice', createdAt: 0, updatedAt: 0, frames: [] }
const IN_A: Canvas = { ...CANVAS, id: 'c-a', workspaceId: 'ws-a' }
const IN_B: Canvas = { ...CANVAS, id: 'c-b', workspaceId: 'ws-b' }
const CANVASES = [CANVAS, IN_A, IN_B]

const { db } = await import('../server/db/index.ts')
const webhooks = await import('../server/webhooks.ts')

const rowFor = async (id: string) => (await db.select().from(schema.webhooks)).find((r) => r.id === id)
/** What a restart does: memory is dropped and rebuilt from the rows. */
const restart = () => webhooks.hydrateWebhooks()

beforeAll(() => {
  vi.stubGlobal('fetch', mocks.fetch)
})

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.fetch.mockResolvedValue({ ok: true, status: 200, body: { cancel: async () => {} } })
  mocks.access.mockReturnValue(true)
  mocks.aliceIn = new Set(['ws-a', 'ws-b'])
  await db.delete(schema.webhooks)
  await restart()
})

const register = (workspaceIds?: string[]) =>
  webhooks.createWebhook('alice', { url: 'https://hooks.example.com/doop', events: ['frame.created'], workspaceIds })

const eventOn = (canvas: Canvas) =>
  webhooks.onCanvasEvent(canvas.id, {
    type: 'frame.created',
    frame: { id: 'f1', canvasId: canvas.id, name: 'Hero', html: '', x: 0, y: 0, width: 1, height: 1 } as never,
    actor: { name: 'Doop', kind: 'agent', color: '#000' },
  })

const delivered = async () => {
  eventOn(IN_A)
  eventOn(IN_B)
  await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled())
  /* a delivery the limit should have stopped would have been posted within these turns */
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve))
  return mocks.fetch.mock.calls.map(
    ([, init]) => (JSON.parse(String((init as RequestInit).body)) as { canvas: { id: string } }).canvas.id,
  )
}

describe('webhook workspace limit persistence', () => {
  it('writes the limit on create and null for an unlimited hook', async () => {
    const { info: limited } = await register(['ws-a', 'ws-a'])
    const { info: open } = await register()
    expect((await rowFor(limited.id))?.workspaceIds).toEqual(['ws-a'])
    expect((await rowFor(open.id))?.workspaceIds).toBeNull()
  })

  it('keeps a limit across a restart, so the hook still hears only its workspaces', async () => {
    const { info } = await register(['ws-a'])
    await restart()
    expect(webhooks.listWebhooks('alice').find((h) => h.id === info.id)?.workspaces).toEqual([
      { id: 'ws-a', name: 'Alpha' },
    ])
    expect(await delivered()).toEqual(['c-a'])
  })

  it('writes an update to the limit and restores that after a restart', async () => {
    const { info } = await register(['ws-a'])
    await webhooks.updateWebhook('alice', info.id, { workspaceIds: ['ws-b'] })
    expect((await rowFor(info.id))?.workspaceIds).toEqual(['ws-b'])
    await restart()
    expect(await delivered()).toEqual(['c-b'])
  })

  it('writes null when the limit is lifted, and an update that leaves it alone keeps it', async () => {
    const { info } = await register(['ws-a'])
    await webhooks.updateWebhook('alice', info.id, { enabled: false })
    expect((await rowFor(info.id))?.workspaceIds).toEqual(['ws-a'])
    await webhooks.updateWebhook('alice', info.id, { enabled: true, workspaceIds: null })
    expect((await rowFor(info.id))?.workspaceIds).toBeNull()
    await restart()
    expect((await delivered()).sort()).toEqual(['c-a', 'c-b'])
  })
})
