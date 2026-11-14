import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/* What lean mode changes in image generation and billing. */

vi.mock('../server/modelAccounts.ts', () => ({
  getAccounts: vi.fn(),
  withFreshToken: vi.fn((account: unknown) => Promise.resolve(account)),
}))
vi.mock('../server/imagePrefs.ts', () => ({ getImagePref: vi.fn(() => Promise.resolve(undefined)) }))

import { getAccounts } from '../server/modelAccounts.ts'
import { imageModelAvailability } from '../server/imageGen.ts'

afterEach(() => {
  vi.mocked(getAccounts).mockReset()
  unstubAllEnvs()
})

describe('image generation', () => {
  const connected = [{ kind: 'gemini-key', apiKey: 'g-key', enabled: true }] as never
  const gptImage = async () => (await imageModelAvailability('user-1')).find((m) => m.id === 'gpt-image-2')

  it("lets a user's connected account decide what is available when lean is off", async () => {
    stubEnv('OPENAI_API_KEY', 'server-key')
    vi.mocked(getAccounts).mockResolvedValue(connected)
    expect(await gptImage()).toMatchObject({ available: false })
  })

  it("uses only the server's keys when lean is on, whatever the user connected", async () => {
    stubEnv('DOOP_LEAN', '1')
    stubEnv('OPENAI_API_KEY', 'server-key')
    vi.mocked(getAccounts).mockResolvedValue(connected)
    expect(await gptImage()).toMatchObject({ available: true })
    expect(getAccounts).not.toHaveBeenCalled()
  })
})

describe('billingEnabled', () => {
  async function billingWith(lean: string | undefined) {
    vi.resetModules()
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_doop_fake')
    vi.stubEnv('DOOP_LEAN', lean)
    return import('../server/billing.ts')
  }

  it('follows the Stripe key when lean is off', async () => {
    expect((await billingWith(undefined)).billingEnabled()).toBe(true)
  })

  it('is off when lean is on, even with a Stripe key', async () => {
    expect((await billingWith('1')).billingEnabled()).toBe(false)
  })
})
