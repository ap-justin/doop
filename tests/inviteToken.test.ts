import { describe, expect, it } from 'vitest'
import {
  hashInviteToken,
  inviteSignupAllows,
  newInviteToken,
  withInviteSignup,
  INVITE_TTL_MS,
} from '../server/inviteToken.ts'

describe('invite token', () => {
  it('hashes with sha256 (known vector) and expires seven days after issue', () => {
    expect(hashInviteToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    const { token, hash, expiresAt } = newInviteToken(1_000)
    expect(hash).toBe(hashInviteToken(token))
    expect(hash).not.toBe(token)
    expect(expiresAt).toBe(1_000 + 7 * 24 * 60 * 60 * 1000)
    expect(INVITE_TTL_MS).toBe(604_800_000)
  })
})

describe('invite sign-up bypass', () => {
  it('admits only the invited address, case and spacing aside, and only inside its own call', async () => {
    expect(inviteSignupAllows('ada@example.com')).toBe(false)
    await withInviteSignup('Ada@Example.com ', async () => {
      expect(inviteSignupAllows('ada@example.com')).toBe(true)
      expect(inviteSignupAllows(' ADA@example.com')).toBe(true)
      expect(inviteSignupAllows('eve@example.com')).toBe(false)
      await Promise.resolve()
      expect(inviteSignupAllows('eve@example.com')).toBe(false)
    })
    expect(inviteSignupAllows('ada@example.com')).toBe(false)
  })
})
