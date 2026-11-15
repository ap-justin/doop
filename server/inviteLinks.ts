import express from 'express'
import { and, eq, lte, type SQL } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { fromNodeHeaders } from 'better-auth/node'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import * as authSchema from './db/auth-schema.ts'
import { auth } from './auth.ts'
import { store } from './store.ts'
import { notifyUsers } from './userEvents.ts'
import { mailerConfigured, sendMail } from './mailer.ts'
import {
  acceptWorkspaceInviteLink,
  isWorkspaceMember,
  workspaceInviteByToken,
  type WorkspaceInviteLink,
} from './workspaces.ts'
import { hashInviteToken, inviteLinkUrl, newInviteToken, withInviteSignup } from './inviteToken.ts'
import type { InviteLinkError, InviteLinkInfo, PendingCanvasInvite } from '../shared/inviteLinks.ts'

/**
 * Invite links. Sharing a canvas or workspace with an email that has no
 * account yet makes a pending invite carrying a single-use token. The link,
 * /invite/<token>, goes by email when a mailer is configured, so only the
 * address's owner holds it; without a mailer the inviter gets it instead.
 * Opening it lets the invited address create its account, or an account it
 * already has join. Workspace
 * invites live in `workspace_invites` (they predate links), canvas invites
 * in `canvas_invites`; this file is the canvas half plus the public routes
 * both kinds share.
 */

/* ---- canvas invites ---- */

/** One pending invite per canvas and address; inviting again re-issues the link. */
export async function createCanvasInvite(canvasId: string, email: string, invitedBy: string) {
  const { token, hash, expiresAt } = newInviteToken()
  const createdAt = Date.now()
  const [saved] = await db
    .insert(t.canvasInvites)
    .values({ id: nanoid(12), canvasId, email, invitedBy, createdAt, tokenHash: hash, expiresAt })
    .onConflictDoUpdate({
      target: [t.canvasInvites.canvasId, t.canvasInvites.email],
      set: { invitedBy, createdAt, tokenHash: hash, expiresAt },
    })
    .returning({ id: t.canvasInvites.id })
  const invite: PendingCanvasInvite = { id: saved!.id, email, createdAt, expiresAt }
  return { invite, link: inviteLinkUrl(token) }
}

/** An expired invite is not pending: it is deleted the first time anything
 *  lists or resolves it, as workspace invites are (`dropExpiredInvites`). */
async function dropExpiredCanvasInvites(scope: SQL): Promise<void> {
  await db.delete(t.canvasInvites).where(and(scope, lte(t.canvasInvites.expiresAt, Date.now())))
}

export async function listCanvasInvites(canvasId: string): Promise<PendingCanvasInvite[]> {
  await dropExpiredCanvasInvites(eq(t.canvasInvites.canvasId, canvasId))
  const rows = await db.select().from(t.canvasInvites).where(eq(t.canvasInvites.canvasId, canvasId))
  return rows
    .map((r) => ({ id: r.id, email: r.email, createdAt: r.createdAt, expiresAt: r.expiresAt }))
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function revokeCanvasInvite(canvasId: string, inviteId: string): Promise<void> {
  await db.delete(t.canvasInvites).where(and(eq(t.canvasInvites.canvasId, canvasId), eq(t.canvasInvites.id, inviteId)))
}

/** Rejects when the mail cannot be sent; does nothing without a mailer. */
export async function emailCanvasInvite(inviter: { name: string }, email: string, canvasName: string, link: string) {
  if (!mailerConfigured) return
  await sendMail({
    to: email,
    subject: `${inviter.name} shared “${canvasName}” with you`,
    text: `${inviter.name} invited you to collaborate on “${canvasName}” on doop.\n\nOpen this link to create your account and join (it works once and expires in 7 days):\n\n${link}\n`,
  })
}

interface CanvasInviteRef {
  id: string
  canvasId: string
  invitedBy: string
}

/** Turn one canvas invite into a membership: the member row and the invite's
 *  deletion land in one transaction, so a failed write keeps the invite for a
 *  retry rather than spending it on nothing. */
async function acceptCanvasInvite(invite: CanvasInviteRef, userId: string): Promise<void> {
  const canvas = store.getCanvas(invite.canvasId)
  if (!canvas) return
  await db.transaction(async (tx) => {
    if (canvas.ownerId !== userId)
      await tx
        .insert(t.canvasMembers)
        .values({ canvasId: canvas.id, userId, addedBy: invite.invitedBy, addedAt: Date.now() })
        .onConflictDoNothing()
    await tx.delete(t.canvasInvites).where(eq(t.canvasInvites.id, invite.id))
  })
  /* the row is committed; this brings memory up to date (its own insert is a no-op) */
  store.addMember(canvas.id, userId, invite.invitedBy)
  notifyUsers([userId], { type: 'canvases' })
}

/* ---- resolving a link ---- */

type ResolvedInvite = {
  email: string
  inviterId: string
  /** where the person lands once in */
  landing: string
  targetName: string
} & ({ kind: 'workspace'; workspaceInvite: WorkspaceInviteLink } | { kind: 'canvas'; canvasInvite: CanvasInviteRef })

async function resolve(token: string): Promise<ResolvedInvite | null> {
  if (!token || token.length > 200) return null
  const hash = hashInviteToken(token)
  const link = await workspaceInviteByToken(hash)
  if (link)
    return {
      kind: 'workspace',
      email: link.email,
      inviterId: link.invitedBy,
      landing: `/w/${link.workspaceId}`,
      targetName: link.workspaceName,
      workspaceInvite: link,
    }
  const [row] = await db.select().from(t.canvasInvites).where(eq(t.canvasInvites.tokenHash, hash))
  const expired = !!row && row.expiresAt <= Date.now()
  if (row && expired) await dropExpiredCanvasInvites(eq(t.canvasInvites.id, row.id))
  const canvas = row && store.getCanvas(row.canvasId)
  if (!row || !canvas || expired) return null
  return {
    kind: 'canvas',
    email: row.email,
    inviterId: row.invitedBy,
    landing: `/c/${canvas.id}`,
    targetName: canvas.name,
    canvasInvite: { id: row.id, canvasId: canvas.id, invitedBy: row.invitedBy },
  }
}

async function nameOf(userId: string): Promise<string> {
  const [row] = await db
    .select({ name: authSchema.user.name })
    .from(authSchema.user)
    .where(eq(authSchema.user.id, userId))
  return row?.name ?? 'Someone'
}

async function accountFor(email: string) {
  const [row] = await db
    .select({ id: authSchema.user.id })
    .from(authSchema.user)
    .where(eq(authSchema.user.email, email))
  return row
}

/* ---- the public routes ---- */

/** Few tries per invited address, shared by accept and join: a token is
 *  unguessable, so this only blunts hammering, the same budget better-auth
 *  gives its sign-in route. Keyed by the address rather than req.ip, which
 *  behind the edge is its PoP and on a bare port whatever X-Forwarded-For says. */
const ATTEMPTS = 3
const WINDOW_MS = 10_000
const attempts = new Map<string, number[]>()

function rateLimited(email: string): boolean {
  const now = Date.now()
  const recent = (attempts.get(email) ?? []).filter((at) => now - at < WINDOW_MS)
  if (recent.length >= ATTEMPTS) {
    attempts.set(email, recent)
    return true
  }
  recent.push(now)
  attempts.set(email, recent)
  if (attempts.size > 5000) for (const [k, v] of attempts) if (!v.some((at) => now - at < WINDOW_MS)) attempts.delete(k)
  return false
}

/** Links being accepted right now, so two requests cannot both spend one. */
const inFlight = new Set<string>()

/** Links spent in this process, by token hash, so the account that spent one
 *  can present it again (a retry after a lost response) and still land where
 *  it leads. Only in memory: after a restart such a retry reads as `invalid`. */
interface SpentLink {
  userId: string
  landing: string
  spentAt: number
  stillMember: () => boolean
}
const SPENT_MEMORY_MS = 60 * 60 * 1000
const spent = new Map<string, SpentLink>()

function rememberSpent(hash: string, found: ResolvedInvite, userId: string): void {
  const stillMember =
    found.kind === 'workspace'
      ? () => isWorkspaceMember(found.workspaceInvite.workspaceId, userId)
      : () => !!store.getCanvas(found.canvasInvite.canvasId)?.memberIds?.includes(userId)
  const now = Date.now()
  spent.set(hash, { userId, landing: found.landing, spentAt: now, stillMember })
  if (spent.size > 5000) for (const [k, v] of spent) if (now - v.spentAt > SPENT_MEMORY_MS) spent.delete(k)
}

function refuse(res: express.Response, status: number, error: InviteLinkError) {
  return res.status(status).json({ error })
}

const TOO_MANY = { error: 'too many attempts — try again shortly' }

export const inviteLinksRouter = express.Router()

inviteLinksRouter.get('/:token', async (req, res) => {
  const found = await resolve(req.params.token)
  if (!found) return refuse(res, 404, 'invalid')
  const info: InviteLinkInfo = {
    kind: found.kind,
    email: found.email,
    inviterName: await nameOf(found.inviterId),
    targetName: found.targetName,
    accountExists: !!(await accountFor(found.email)),
  }
  res.json(info)
})

/** Spend this link's invite, and only it, for the invited address's account. */
async function honour(hash: string, found: ResolvedInvite, userId: string): Promise<void> {
  if (found.kind === 'workspace') await acceptWorkspaceInviteLink(found.workspaceInvite, userId)
  else await acceptCanvasInvite(found.canvasInvite, userId)
  rememberSpent(hash, found, userId)
}

/** The account better-auth just created. When verification is required it
 *  answers an address that already has an account with a generic success and
 *  a made-up user id, so the id must name a real row for this address before
 *  anything trusts it. */
async function createdAccount(userId: string, email: string) {
  const [row] = await db
    .select({ id: authSchema.user.id })
    .from(authSchema.user)
    .where(and(eq(authSchema.user.id, userId), eq(authSchema.user.email, email)))
  return row
}

inviteLinksRouter.post('/:token/accept', async (req, res) => {
  const token = req.params.token
  const hash = hashInviteToken(token)
  if (inFlight.has(hash)) return refuse(res, 409, 'in-progress')
  inFlight.add(hash)
  try {
    const found = await resolve(token)
    if (!found) return refuse(res, 404, 'invalid')
    if (rateLimited(found.email)) return res.status(429).json(TOO_MANY)
    if (await accountFor(found.email)) return refuse(res, 409, 'account-exists')
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    if (!name) return res.status(400).json({ error: 'a name is required' })
    let signedUp
    try {
      /* better-auth's own sign-up hashes the password and writes the user and
         credential rows; the bypass covers this one request for this one address */
      signedUp = await withInviteSignup(found.email, () =>
        auth.api.signUpEmail({
          body: { email: found.email, password, name },
          headers: fromNodeHeaders(req.headers),
        }),
      )
    } catch (err) {
      /* when verification isn't required, an account made for the address since the check above throws here */
      if (await accountFor(found.email)) return refuse(res, 409, 'account-exists')
      const message = err instanceof Error ? err.message : 'could not create the account'
      return res.status(400).json({ error: message })
    }
    const created = await createdAccount(signedUp.user.id, found.email)
    if (!created) return refuse(res, 409, 'account-exists')
    /* With a mailer the link went to the address by email alone (the inviter
       never held it), so opening it proves the address. Without one the inviter
       holds the link too, so it proves nothing and the account stays unverified. */
    if (mailerConfigured)
      await db.update(authSchema.user).set({ emailVerified: true }).where(eq(authSchema.user.id, created.id))
    /* sign in before spending the invite: a failed sign-in leaves it for the
       join route, which the page offers once the account exists */
    const signedIn = await auth.api.signInEmail({
      body: { email: found.email, password },
      headers: fromNodeHeaders(req.headers),
      returnHeaders: true,
    })
    await honour(hash, found, created.id)
    for (const cookie of signedIn.headers.getSetCookie()) res.append('Set-Cookie', cookie)
    res.json({ landing: found.landing })
  } catch (err) {
    console.error('[invites] accept failed', err)
    res.status(500).json({ error: 'could not accept the invite' })
  } finally {
    inFlight.delete(hash)
  }
})

/** An account that already exists joins by signing in as the invited address
 *  and presenting the link. */
inviteLinksRouter.post('/:token/join', async (req, res) => {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null)
  if (!session) return res.status(401).json({ error: 'unauthorized' })
  const email = session.user.email.trim().toLowerCase()
  if (rateLimited(email)) return res.status(429).json(TOO_MANY)
  const token = req.params.token
  const hash = hashInviteToken(token)
  const found = await resolve(token)
  if (!found) {
    const prior = spent.get(hash)
    if (prior?.userId === session.user.id && prior.stillMember()) return res.json({ landing: prior.landing })
    return refuse(res, 404, 'invalid')
  }
  if (found.email !== email) return refuse(res, 404, 'invalid')
  try {
    await honour(hash, found, session.user.id)
  } catch (err) {
    console.error('[invites] join failed', err)
    return res.status(500).json({ error: 'could not accept the invite' })
  }
  res.json({ landing: found.landing })
})
