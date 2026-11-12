import type { Canvas } from '../shared/types.ts'
import { getWorkspace, isWorkspaceMember } from './workspaces.ts'

/**
 * The limit an agent key or account webhook can carry: the workspaces whose
 * canvases it may reach, or null for every canvas its owner can reach. A
 * canvas is inside a limit only when it lives in one of the listed
 * workspaces and the owner is still a member there, so a personal canvas, a
 * canvas reached by invite or share link, and a workspace the owner has left
 * are outside every limit.
 */
export type WorkspaceLimit = readonly string[] | null

export interface LimitWorkspace {
  id: string
  name: string
}

/** The one predicate every limit check shares: the workspace still exists
 *  and the owner is still a member there. */
function reachable(workspaceId: string, userId: string | undefined) {
  const ws = getWorkspace(workspaceId)
  return ws && isWorkspaceMember(workspaceId, userId) ? ws : undefined
}

/** Reads a requested limit: absent or null is no limit; a list must name at
 *  least one workspace, each one the caller belongs to. An unknown id and a
 *  workspace of someone else's get the same answer, so the check reveals
 *  nothing about workspaces the caller cannot see; an id in `current` (the
 *  limit being replaced, which the caller already holds) that the caller has
 *  since left is named as such. */
export function parseWorkspaceLimit(
  userId: string,
  value: unknown,
  current: WorkspaceLimit = null,
): { ok: true; limit: string[] | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, limit: null }
  if (!Array.isArray(value) || !value.every((id): id is string => typeof id === 'string'))
    return { ok: false, error: 'workspaceIds must be a list of workspace ids' }
  const ids = [...new Set(value)]
  if (!ids.length) return { ok: false, error: 'pick at least one workspace, or leave the limit off' }
  const unreachable = ids.find((id) => !reachable(id, userId))
  if (unreachable === undefined) return { ok: true, limit: ids }
  if (current?.includes(unreachable) && getWorkspace(unreachable))
    return { ok: false, error: `this account is no longer a member of workspace ${unreachable}` }
  return { ok: false, error: `no workspace with id ${unreachable}` }
}

export function withinWorkspaceLimit(
  limit: WorkspaceLimit,
  userId: string | undefined,
  canvas: Pick<Canvas, 'workspaceId'>,
): boolean {
  if (!limit) return true
  const ws = canvas.workspaceId
  return !!ws && limit.includes(ws) && !!reachable(ws, userId)
}

/** A limit as the settings pages and agents see it: only the workspaces the
 *  owner can still reach, so one deleted or left since drops out. null is no
 *  limit; [] is a limit that reaches nothing any more. */
export function describeWorkspaceLimit(limit: WorkspaceLimit, userId: string | undefined): LimitWorkspace[] | null {
  if (!limit) return null
  return limit.flatMap((id) => {
    const ws = reachable(id, userId)
    return ws ? [{ id, name: ws.name }] : []
  })
}
