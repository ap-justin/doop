// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { redactInviteTokens, redactInviteTokensDeep } from '../src/lib/inviteRedaction'

const TOKEN = 'aB3_-xYz09aB3_-xYz09aB3_-xYz09ab'

it('strips the token from the page, the API and an encoded redirect', () => {
  expect(redactInviteTokens(`https://doop.design/invite/${TOKEN}`)).toBe('https://doop.design/invite/:token')
  expect(redactInviteTokens(`/api/invite-links/${TOKEN}/accept`)).toBe('/api/invite-links/:token/accept')
  expect(redactInviteTokens(`/?redirect_to=%2Finvite%2F${TOKEN}`)).toBe('/?redirect_to=%2Finvite%2F:token')
  expect(redactInviteTokens('/api/workspaces/w1/invites/i1')).toBe('/api/workspaces/w1/invites/i1')
})

it('walks a whole event, replay snapshots included', () => {
  const at = new Date()
  const event = {
    event: '$snapshot',
    timestamp: at,
    properties: {
      $current_url: `https://doop.design/invite/${TOKEN}`,
      $snapshot_data: [{ type: 4, data: { href: `https://doop.design/invite/${TOKEN}` } }],
    },
    $set_once: { $initial_referrer: `https://doop.design/?redirect_to=%2Finvite%2F${TOKEN}` },
  }
  expect(JSON.stringify(redactInviteTokensDeep(event))).not.toContain(TOKEN)
  expect(event.timestamp).toBe(at)
})

/* The real filter: src/lib/posthog.ts handed to posthog.init as `before_send`.
   Only the SDK is stubbed, so removing that line (or what it calls) fails here. */
it('is installed as PostHog before_send, so no event leaves with a live token', async () => {
  const init = vi.fn()
  vi.resetModules()
  vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test')
  for (const path of [
    'posthog-js/dist/posthog-recorder',
    'posthog-js/dist/exception-autocapture',
    'posthog-js/dist/web-vitals',
    'posthog-js/dist/conversations',
  ])
    vi.doMock(path, () => ({}))
  vi.doMock('posthog-js/dist/module.no-external', () => ({
    default: { init, register: vi.fn(), identify: vi.fn(), reset: vi.fn(), capture: vi.fn() },
  }))
  vi.doMock('../src/lib/frameReplay', () => ({ installFrameReplay: vi.fn() }))
  await import('../src/lib/posthog')

  const config = init.mock.calls[0]?.[1] as { before_send?: (event: object | null) => object | null }
  expect(config.before_send).toBeTypeOf('function')
  const sent = config.before_send!({
    event: '$pageview',
    properties: {
      $current_url: `https://doop.design/invite/${TOKEN}`,
      $referrer: `/?redirect_to=%2Finvite%2F${TOKEN}`,
    },
  })
  expect(JSON.stringify(sent)).not.toContain(TOKEN)
  expect(JSON.stringify(sent)).toContain('/invite/:token')
  expect(config.before_send!(null)).toBeNull()
  vi.unstubAllEnvs()
})
