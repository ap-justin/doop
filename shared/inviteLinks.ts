/** What /invite/<token> shows before anyone commits to it. */
export interface InviteLinkInfo {
  kind: 'workspace' | 'canvas'
  /** the address the invite is for; the sign-up form cannot change it */
  email: string
  inviterName: string
  /** the workspace's or canvas's name */
  targetName: string
  /** someone already signed up with this address, so the page asks them to sign in */
  accountExists: boolean
}

/** The `error` an invite-link route answers with:
 *  - `invalid` (404): unknown, expired, used or revoked, one answer for all
 *  - `account-exists` (409): the address has an account, so the page asks it to sign in and join
 *  - `in-progress` (409): this link is being accepted by another request right now; retry */
export type InviteLinkError = 'invalid' | 'account-exists' | 'in-progress'

/** A canvas shared with an address that has no account yet. */
export interface PendingCanvasInvite {
  id: string
  email: string
  createdAt: number
  expiresAt: number
}
