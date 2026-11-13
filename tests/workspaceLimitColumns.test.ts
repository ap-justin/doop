import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { eq } from 'drizzle-orm'
import * as schema from '../server/db/schema.ts'

/**
 * The workspace limit on agent keys and webhooks, held by the database:
 * null is no limit, a list names the workspaces, and an empty list (a limit
 * that admits nothing) is refused whoever writes it.
 */

const db = drizzle(new PGlite(), { schema })

beforeAll(async () => {
  await migrate(db, { migrationsFolder: 'server/db/migrations' })
}, 30_000)

const key = (id: string, workspaceIds?: string[] | null) => ({
  id,
  secretHash: `hash-${id}`,
  userId: 'user-1',
  name: id,
  start: 'doop_',
  createdAt: 1,
  workspaceIds,
})

const hook = (id: string, workspaceIds?: string[] | null) => ({
  id,
  userId: 'user-1',
  url: 'https://example.com/hook',
  secret: 'secret',
  events: ['frame.updated'],
  createdAt: 1,
  workspaceIds,
})

/** The Postgres error under drizzle's query wrapper. */
async function rejection(write: Promise<unknown>) {
  const error = await write.then(
    () => null,
    (e: unknown) => e,
  )
  return (error as { cause?: { code?: string; constraint?: string } } | null)?.cause
}

describe('agent_keys.workspace_ids', () => {
  it('is null for a key written without one', async () => {
    await db.insert(schema.agentKeys).values(key('k-unlimited'))
    const [row] = await db.select().from(schema.agentKeys).where(eq(schema.agentKeys.id, 'k-unlimited'))
    expect(row?.workspaceIds).toBeNull()
  })

  it('round-trips a list of workspace ids', async () => {
    await db.insert(schema.agentKeys).values(key('k-limited', ['ws-a', 'ws-b']))
    const [row] = await db.select().from(schema.agentKeys).where(eq(schema.agentKeys.id, 'k-limited'))
    expect(row?.workspaceIds).toEqual(['ws-a', 'ws-b'])
  })

  it('refuses an empty list', async () => {
    expect(await rejection(db.insert(schema.agentKeys).values(key('k-empty', [])))).toMatchObject({
      code: '23514',
      constraint: 'agent_keys_workspace_ids_nonempty',
    })
  })

  it.each([
    ['an object', `'{"id":"ws-a"}'`],
    ['a string', `'"ws-a"'`],
    ['the JSON null literal', `'null'::jsonb`],
  ])('refuses %s, not an array', async (label, value) => {
    const id = `k-${label.replaceAll(' ', '-')}`
    const write = db.execute(
      `INSERT INTO agent_keys (id, secret_hash, user_id, name, start, created_at, workspace_ids)
       VALUES ('${id}', 'hash-${id}', 'user-1', 'k', 'doop_', 1, ${value})`,
    )
    expect(await rejection(write)).toMatchObject({ code: '23514', constraint: 'agent_keys_workspace_ids_nonempty' })
  })
})

describe('webhooks.workspace_ids', () => {
  it('is null for a hook written without one and keeps a list', async () => {
    await db.insert(schema.webhooks).values([hook('h-unlimited'), hook('h-limited', ['ws-a'])])
    const rows = await db.select().from(schema.webhooks)
    expect(Object.fromEntries(rows.map((r) => [r.id, r.workspaceIds]))).toEqual({
      'h-unlimited': null,
      'h-limited': ['ws-a'],
    })
  })

  it('refuses an empty list', async () => {
    expect(await rejection(db.insert(schema.webhooks).values(hook('h-empty', [])))).toMatchObject({
      code: '23514',
      constraint: 'webhooks_workspace_ids_nonempty',
    })
  })

  it.each([
    ['an object', `'{"id":"ws-a"}'`],
    ['a string', `'"ws-a"'`],
    ['the JSON null literal', `'null'::jsonb`],
  ])('refuses %s, not an array', async (label, value) => {
    const id = `h-${label.replaceAll(' ', '-')}`
    const write = db.execute(
      `INSERT INTO webhooks (id, user_id, url, secret, events, created_at, workspace_ids)
       VALUES ('${id}', 'user-1', 'https://example.com/hook', 'secret', '["frame.updated"]', 1, ${value})`,
    )
    expect(await rejection(write)).toMatchObject({ code: '23514', constraint: 'webhooks_workspace_ids_nonempty' })
  })
})

describe('migration 0050 over a database that already holds rows', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'doop-migrations-'))
  afterAll(() => rmSync(folder, { recursive: true, force: true }))

  it('leaves existing keys and webhooks without a limit', async () => {
    /* the journal up to the migration before 0050, then the full one */
    cpSync('server/db/migrations', folder, { recursive: true })
    const journalPath = path.join(folder, 'meta', '_journal.json')
    const full = readFileSync(journalPath, 'utf8')
    const journal = JSON.parse(full) as { entries: { tag: string }[] }
    const before = { ...journal, entries: journal.entries.filter((e) => e.tag < '0050') }
    writeFileSync(journalPath, JSON.stringify(before))
    const old = drizzle(new PGlite(), { schema })
    await migrate(old, { migrationsFolder: folder })
    const columns = await old.execute(
      `SELECT table_name FROM information_schema.columns WHERE column_name = 'workspace_ids'`,
    )
    expect(columns.rows).toEqual([])

    await old.execute(
      `INSERT INTO agent_keys (id, secret_hash, user_id, name, start, created_at)
       VALUES ('k-old', 'hash-k-old', 'user-1', 'old key', 'doop_', 1)`,
    )
    await old.execute(
      `INSERT INTO webhooks (id, user_id, url, secret, events, created_at)
       VALUES ('h-old', 'user-1', 'https://example.com/hook', 'secret', '["frame.updated"]', 1)`,
    )

    writeFileSync(journalPath, full)
    await migrate(old, { migrationsFolder: folder })
    const [oldKey] = await old.select().from(schema.agentKeys).where(eq(schema.agentKeys.id, 'k-old'))
    const [oldHook] = await old.select().from(schema.webhooks).where(eq(schema.webhooks.id, 'h-old'))
    expect([oldKey?.workspaceIds, oldHook?.workspaceIds]).toEqual([null, null])
  }, 60_000)
})
