import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* Lean mode stops new billing, never the cleanup of subscriptions Stripe already charges for. */

const stripeCalls = vi.hoisted(() => ({
  cancel: [] as string[],
  quantity: [] as number[],
}))
vi.mock('stripe', () => ({
  default: class {
    subscriptions = {
      cancel: async (id: string) => void stripeCalls.cancel.push(id),
      retrieve: async () => ({ status: 'active', items: { data: [{ id: 'si_seats', quantity: 1 }] } }),
    }
    subscriptionItems = {
      update: async (_id: string, { quantity }: { quantity: number }) => void stripeCalls.quantity.push(quantity),
    }
  },
}))
vi.mock('../server/db/index.ts', () => {
  /* every query builder call chains, and awaiting one resolves to no rows */
  const chain: object = new Proxy(() => chain, {
    get: (_target, key) => (key === 'then' ? (resolve: (rows: unknown[]) => void) => resolve([]) : chain),
    apply: () => chain,
  })
  return { db: { transaction: (run: (tx: unknown) => Promise<void>) => run(chain), insert: chain, delete: chain } }
})
vi.mock('../server/store.ts', () => ({ store: { detachWorkspace: vi.fn() } }))
vi.mock('../server/fonts.ts', () => ({ dropWorkspaceFonts: vi.fn(async () => undefined) }))
vi.mock('../server/userEvents.ts', () => ({ notifyUsers: vi.fn() }))

beforeEach(() => {
  stripeCalls.cancel.length = 0
  stripeCalls.quantity.length = 0
})
afterEach(() => vi.unstubAllEnvs())

/** A fresh import, so billing.ts reads the Stripe key stubbed here. */
async function paidWorkspace(env: { lean?: string; stripeKey?: string }) {
  vi.resetModules()
  vi.stubEnv('DOOP_LEAN', env.lean)
  vi.stubEnv('STRIPE_SECRET_KEY', env.stripeKey)
  const workspaces = await import('../server/workspaces.ts')
  const ws = workspaces.createWorkspace('Paid team', 'owner')
  ws.stripeSubscriptionId = 'sub_paid'
  return { workspaces, ws }
}

describe.each([
  { mode: 'lean on', lean: '1' },
  { mode: 'lean off', lean: undefined },
])('with a Stripe key and $mode', ({ lean }) => {
  it('cancels the subscription of a deleted workspace', async () => {
    const { workspaces, ws } = await paidWorkspace({ lean, stripeKey: 'sk_test_doop_fake' })
    await workspaces.deleteWorkspace(ws.id)
    expect(stripeCalls.cancel).toEqual(['sub_paid'])
  })

  it('keeps the billed seats equal to the members', async () => {
    const { workspaces, ws } = await paidWorkspace({ lean, stripeKey: 'sk_test_doop_fake' })
    workspaces.addMember(ws.id, 'second', 'member', 'owner')
    await vi.waitFor(() => expect(stripeCalls.quantity).toEqual([2]))
  })
})

it('touches nothing on Stripe without a key', async () => {
  const { workspaces, ws } = await paidWorkspace({ lean: '1' })
  workspaces.addMember(ws.id, 'second', 'member', 'owner')
  await workspaces.deleteWorkspace(ws.id)
  expect(stripeCalls).toEqual({ cancel: [], quantity: [] })
})
