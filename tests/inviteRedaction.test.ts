import { expect, it } from 'vitest'
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
