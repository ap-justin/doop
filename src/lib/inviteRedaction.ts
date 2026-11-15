/* An invite token creates an account until it is spent, so it must never
   leave the browser in analytics: `/invite/<token>` (the page), the API's
   `/invite-links/<token>`, and either one percent-encoded in a query such as
   the sign-in hop's `redirect_to`. Tokens are base64url (server/inviteToken.ts). */
const INVITE_TOKEN = /((?:\/|%2F)invite(?:-links)?(?:\/|%2F))[\w-]+/gi

export const redactInviteTokens = (text: string) => text.replace(INVITE_TOKEN, '$1:token')

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactInviteTokens(value)
  if (Array.isArray(value)) value.forEach((item, index) => (value[index] = redactValue(item)))
  else if (isPlainObject(value)) for (const key of Object.keys(value)) value[key] = redactValue(value[key])
  return value
}

/** Rewrites every invite token in the strings of a JSON-shaped value, in place
 *  for arrays and plain objects (a PostHog event, replay snapshots included). */
export const redactInviteTokensDeep = <T extends object>(value: T): T => redactValue(value) as T
