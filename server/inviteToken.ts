import { createHash, randomBytes } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ORIGIN } from './links.ts'

/**
 * Invite links: the token in `${ORIGIN}/invite/<token>` is the proof that its
 * holder owns the invited address. Like agent keys, only its sha256 is stored;
 * 192 random bits make a plain hash preimage-proof.
 */

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function newInviteToken(now = Date.now()): { token: string; hash: string; expiresAt: number } {
  const token = randomBytes(24).toString('base64url')
  return { token, hash: hashInviteToken(token), expiresAt: now + INVITE_TTL_MS }
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export const inviteLinkUrl = (token: string) => `${ORIGIN}/invite/${token}`

/** The one request that may create an account for the invited address without
 *  the sign-up allowlist or email verification: server/auth.ts asks here. */
const signupBypass = new AsyncLocalStorage<{ email: string }>()

export function withInviteSignup<T>(email: string, run: () => Promise<T>): Promise<T> {
  return signupBypass.run({ email: email.trim().toLowerCase() }, run)
}

export function inviteSignupAllows(email: string): boolean {
  return signupBypass.getStore()?.email === email.trim().toLowerCase()
}
