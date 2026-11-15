import express from 'express'
import { and, eq } from 'drizzle-orm'
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
  acceptInvites,
  acceptWorkspaceInviteLink,
  workspaceInviteByToken,
  type WorkspaceInviteLink,
} from './workspaces.ts'
import { hashInviteToken, inviteLinkUrl, newInviteToken, withInviteSignup } from './inviteToken.ts'
import type { InviteLinkInfo, PendingCanvasInvite } from '../shared/inviteLinks.ts'

/**
 * Invite links. Sharing a canvas or workspace with an email that has no
 * account yet makes a pending invite carrying a single-use token; the link
 * to /invite/<token> shows the inviter the way in, and opening it lets the
 * invited address create its account. Workspace invites live in
 * `workspace_invites` (they predate links), canvas invites in
 * `canvas_invites`; this file is the canvas half plus the public accept
 * route both kinds share.
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

export async function listCanvasInvites(canvasId: string): Promise<PendingCanvasInvite[]> {
  const rows = await db.select().from(t.canvasInvites).where(eq(t.canvasInvites.canvasId, canvasId))
  const now = Date.now()
  return rows
    .filter((r) => r.expiresAt > now)
    .map((r) => ({ id: r.id, email: r.email, createdAt: r.createdAt, expiresAt: r.expiresAt }))
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function revokeCanvasInvite(canvasId: string, inviteId: string): Promise<void> {
  await db.delete(t.canvasInvites).where(and(eq(t.canvasInvites.canvasId, canvasId), eq(t.canvasInvites.id, inviteId)))
}

export function emailCanvasInvite(inviter: { name: string }, email: string, canvasName: string, link: string) {
  if (!mailerConfigured) return
  sendMail({
    to: email,
    subject: `${inviter.name} shared “${canvasName}” with you`,
    text: `${inviter.name} invited you to collaborate on “${canvasName}” on doop.\n\nOpen this link to create your account and join (it works once and expires in 7 days):\n\n${link}\n`,
  }).catch((err) => console.error('[invites] canvas invite email failed', err))
}

/** Canvas invites for an address whose ownership has been shown: all of them,
 *  since the proof is of the address, not of one link. */
async function acceptCanvasInvites(userId: string, email: string): Promise<void> {
  const rows = await db.select().from(t.canvasInvites).where(eq(t.canvasInvites.email, email))
  for (const row of rows) {
    store.addMember(row.canvasId, userId, row.invitedBy)
    await db.delete(t.canvasInvites).where(eq(t.canvasInvites.id, row.id))
  }
  if (rows.length) notifyUsers([userId], { type: 'canvases' })
}

/* ---- resolving a link ---- */

interface ResolvedInvite {
  kind: 'workspace' | 'canvas'
  email: string
  inviterId: string
  /** where the person lands once in */
  landing: string
  targetName: string
  /** the workspace's invite, when that is the kind */
  workspaceInvite?: WorkspaceInviteLink
  canvasInviteId?: string
  canvasId?: string
}

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
  const canvas = row && store.getCanvas(row.canvasId)
  if (!row || !canvas || row.expiresAt <= Date.now()) return null
  return {
    kind: 'canvas',
    email: row.email,
    inviterId: row.invitedBy,
    landing: `/c/${canvas.id}`,
    targetName: canvas.name,
    canvasInviteId: row.id,
    canvasId: canvas.id,
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

/** Few tries from one address: a token is unguessable, so this only blunts
 *  hammering, the same budget better-auth gives its sign-in route. */
const ATTEMPTS = 3
const WINDOW_MS = 10_000
const attempts = new Map<string, number[]>()

function rateLimited(key: string): boolean {
  const now = Date.now()
  const recent = (attempts.get(key) ?? []).filter((at) => now - at < WINDOW_MS)
  if (recent.length >= ATTEMPTS) {
    attempts.set(key, recent)
    return true
  }
  recent.push(now)
  attempts.set(key, recent)
  if (attempts.size > 5000) for (const [k, v] of attempts) if (!v.some((at) => now - at < WINDOW_MS)) attempts.delete(k)
  return false
}

/** Links being accepted right now, so two requests cannot both spend one. */
const inFlight = new Set<string>()

const INVALID = { error: 'invalid' }

export const inviteLinksRouter = express.Router()

inviteLinksRouter.get('/:token', async (req, res) => {
  const found = await resolve(req.params.token)
  if (!found) return res.status(404).json(INVALID)
  const info: InviteLinkInfo = {
    kind: found.kind,
    email: found.email,
    inviterName: await nameOf(found.inviterId),
    targetName: found.targetName,
    accountExists: !!(await accountFor(found.email)),
  }
  res.json(info)
})

/** Spend the invite for an account that exists and has shown it owns the address. */
async function honour(found: ResolvedInvite, userId: string): Promise<void> {
  if (found.workspaceInvite) await acceptWorkspaceInviteLink(found.workspaceInvite, userId)
  else await acceptCanvasInvites(userId, found.email)
}

inviteLinksRouter.post('/:token/accept', async (req, res) => {
  if (rateLimited(`accept:${req.ip}`)) return res.status(429).json({ error: 'too many attempts — try again shortly' })
  const token = req.params.token
  const hash = hashInviteToken(token)
  if (inFlight.has(hash)) return res.status(404).json(INVALID)
  inFlight.add(hash)
  try {
    const found = await resolve(token)
    if (!found) return res.status(404).json(INVALID)
    if (await accountFor(found.email)) return res.status(409).json({ error: 'account-exists' })
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    if (!name) return res.status(400).json({ error: 'a name is required' })
    try {
      /* better-auth's own sign-up hashes the password and writes the user and
         credential rows; the bypass covers this one request for this one address */
      await withInviteSignup(found.email, () =>
        auth.api.signUpEmail({ body: { email: found.email, password, name }, headers: fromNodeHeaders(req.headers) }),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'could not create the account'
      return res.status(400).json({ error: message })
    }
    const created = await accountFor(found.email)
    if (!created) return res.status(500).json({ error: 'could not create the account' })
    await db.update(authSchema.user).set({ emailVerified: true }).where(eq(authSchema.user.id, created.id))
    await acceptInvites(created.id, found.email)
    await acceptCanvasInvites(created.id, found.email)
    const signedIn = await auth.api.signInEmail({
      body: { email: found.email, password },
      headers: fromNodeHeaders(req.headers),
      returnHeaders: true,
    })
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
  if (rateLimited(`join:${req.ip}`)) return res.status(429).json({ error: 'too many attempts — try again shortly' })
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null)
  if (!session) return res.status(401).json({ error: 'unauthorized' })
  const found = await resolve(req.params.token)
  if (!found || found.email !== session.user.email.trim().toLowerCase()) return res.status(404).json(INVALID)
  try {
    await honour(found, session.user.id)
  } catch (err) {
    console.error('[invites] join failed', err)
    return res.status(500).json({ error: 'could not accept the invite' })
  }
  res.json({ landing: found.landing })
})
