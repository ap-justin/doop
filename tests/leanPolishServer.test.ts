import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/* What lean mode changes in image generation and billing. */

vi.mock('../server/modelAccounts.ts', () => ({
  getAccounts: vi.fn(),
  withFreshToken: vi.fn((account: unknown) => Promise.resolve(account)),
}))
vi.mock('../server/imagePrefs.ts', () => ({ getImagePref: vi.fn(() => Promise.resolve(undefined)) }))

import { getAccounts } from '../server/modelAccounts.ts'
import { getImagePref } from '../server/imagePrefs.ts'
import { generatorFor, imageModelAvailability } from '../server/imageGen.ts'
import { doopGuide } from '../server/guide.ts'

afterEach(() => {
  vi.mocked(getAccounts).mockReset()
  vi.mocked(getImagePref).mockResolvedValue(undefined)
  unstubAllEnvs()
})

/** Only the server's OpenAI key is set: GPT Image runs, Nano Banana and Seedream cannot. */
function onlyServerOpenAiKey() {
  stubEnv('OPENAI_API_KEY', 'server-key')
  stubEnv('GEMINI_API_KEY', '')
  stubEnv('ARK_API_KEY', '')
}

function noServerImageKeys() {
  stubEnv('OPENAI_API_KEY', '')
  stubEnv('GEMINI_API_KEY', '')
  stubEnv('ARK_API_KEY', '')
}

describe('a saved image-model pick', () => {
  it('still decides the model when lean is off, refusing when it cannot run', async () => {
    onlyServerOpenAiKey()
    vi.mocked(getAccounts).mockResolvedValue([])
    vi.mocked(getImagePref).mockResolvedValue('gemini-3.1-flash-image')
    expect(await generatorFor('user-1')).toMatchObject({ ok: false })
  })

  it('is ignored when lean is on, so a model the server keys run is used', async () => {
    stubEnv('DOOP_LEAN', '1')
    onlyServerOpenAiKey()
    vi.mocked(getImagePref).mockResolvedValue('gemini-3.1-flash-image')
    expect(await generatorFor('user-1')).toMatchObject({ ok: true, label: 'server' })
  })
})

describe('lean image refusals', () => {
  it('name the server operator, not Settings or a connected account', async () => {
    stubEnv('DOOP_LEAN', '1')
    noServerImageKeys()
    vi.mocked(getImagePref).mockResolvedValue('gpt-image-2')
    const generator = await generatorFor('user-1')
    expect(generator.ok).toBe(false)
    const reason = generator.ok ? '' : generator.reason
    expect(reason).toContain('operator')
    expect(reason).not.toMatch(/Settings|connect/i)
  })
})

describe('lean image generation with no server key', () => {
  it('refuses even when the user connected an account of their own, and never reaches for it', async () => {
    stubEnv('DOOP_LEAN', '1')
    noServerImageKeys()
    vi.mocked(getAccounts).mockResolvedValue([{ kind: 'gemini-key', apiKey: 'g-key', enabled: true }] as never)
    const generator = await generatorFor('user-1')
    expect(generator.ok).toBe(false)
    expect(generator.ok ? '' : generator.reason).toContain('operator')
    const models = await imageModelAvailability('user-1')
    expect(models.filter((m) => m.available)).toEqual([])
  })

  it('lets the same connected account generate when lean is off', async () => {
    noServerImageKeys()
    vi.mocked(getAccounts).mockResolvedValue([{ kind: 'gemini-key', apiKey: 'g-key', enabled: true }] as never)
    expect(await generatorFor('user-1')).toMatchObject({ ok: true })
  })
})

describe('lean image model with only a Gemini server key', () => {
  it('falls past the default model, which the server keys cannot run, to the Gemini one', async () => {
    stubEnv('DOOP_LEAN', '1')
    stubEnv('OPENAI_API_KEY', '')
    stubEnv('GEMINI_API_KEY', 'server-gemini-key')
    stubEnv('ARK_API_KEY', '')
    /* the default (gpt-image-2) is not runnable here: the first runnable model is the only candidate */
    expect(await generatorFor('user-1')).toMatchObject({ ok: true, label: 'server', authHint: 'GEMINI_API_KEY' })
    expect(getAccounts).not.toHaveBeenCalled()
  })
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

/** One `## ` section of the guide, heading included. */
function guideSection(heading: string): string {
  const text = doopGuide()
  const start = text.indexOf(`## ${heading}`)
  return start < 0 ? '' : text.slice(start, text.indexOf('\n## ', start + 1))
}

describe('the agent guide', () => {
  it('keeps the resident-agent reason a comment reply inherits its anchor when lean is off', () => {
    expect(doopGuide()).toContain(
      "reply inherits the root's element anchor, so an @mention reaches the resident agent with\nthe same context the conversation is about.",
    )
  })

  it('says a human reply is an open request for any MCP agent when lean is on, not one routed to the task’s agent', () => {
    stubEnv('DOOP_LEAN', '1')
    const feedback = guideSection('Human feedback')
    expect(feedback).toContain('not mail for one agent')
    expect(feedback).not.toContain('reaches the MCP agent that ran the task')
  })

  it('sends nobody to Settings or a connected account for generated images when lean is on', () => {
    stubEnv('DOOP_LEAN', '1')
    const images = doopGuide().slice(doopGuide().indexOf('**Generated imagery'), doopGuide().indexOf('**Your own file'))
    expect(images).toContain('generate_image')
    expect(images).not.toMatch(/Settings|connected account/)
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
