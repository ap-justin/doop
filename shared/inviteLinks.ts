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

/** A canvas shared with an address that has no account yet. */
export interface PendingCanvasInvite {
  id: string
  email: string
  createdAt: number
  expiresAt: number
}
