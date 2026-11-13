import type { RequestHandler } from 'express'
import { mentionedRole, type AgentRole } from '../shared/agents.ts'
import { env } from './env.ts'

/**
 * Lean mode (DOOP_LEAN=1): Doop as a shared canvas for MCP agents, without
 * the in-app Doop Agent and model accounts, in-app image generation, billing,
 * Slack and Linear, automations, GitHub and Meta import, Community, the
 * desktop connect relay, iOS live activities, Gemini cloud workers, the
 * welcome canvas and demo, and PostHog. Off, the server is unchanged.
 *
 * The features stay in the code: their routes are refused here, and their
 * background work and boot steps are skipped at the points that start them.
 */

/** Read per call, so a test can flip it (tests/envStub.ts). */
export function leanMode(): boolean {
  return env.DOOP_LEAN === '1'
}

/* Express routes match case-insensitively and with or without a trailing
   slash, so every pattern does too. */
const LEAN_DISABLED_PATHS: readonly RegExp[] = [
  /^\/relay(\/|$)/i,
  /^\/stripe\/webhook\/?$/i,
  /^\/webhooks\//i,
  /^\/(local-agent|gemini-cloud)\/mcp\//i,
  /^\/api\/(live-activities|community|automations|integrations|local-agent|agent-allowance|image-model|billing)(\/|$)/i,
  /^\/api\/(model-account|agent-runners|github)(\/|$)/i,
  /^\/api\/canvases\/[^/]+\/(github|cards)(\/|$)/i,
  /^\/api\/canvases\/[^/]+\/publish\/?$/i,
  /^\/api\/tasks\/[^/]+\/feedback\/?$/i,
  /^\/api\/(feedback|comments)\/[^/]+\/retry\/?$/i,
  /^\/api\/workspaces\/[^/]+\/billing\//i,
]

export function isLeanDisabledPath(path: string): boolean {
  return LEAN_DISABLED_PATHS.some((pattern) => pattern.test(path))
}

/** In lean mode, a disabled feature's route leaves the app's router, so
 *  Express answers it as it answers a route that does not exist. Mounted
 *  ahead of every route it covers. */
export const leanGate: RequestHandler = (req, _res, next) => {
  if (leanMode() && isLeanDisabledPath(req.path)) return next('router')
  next()
}

/** The server extensions the core offers its hooks to: none in lean mode. */
export function activeExtensions<T>(all: readonly T[]): readonly T[] {
  return leanMode() ? [] : all
}

/** The resident agent an @mention calls on. In lean mode there is none to
 *  call: a mention is plain text, so it queues no task and spends no meter. */
export function residentMention(text: string): AgentRole | undefined {
  return leanMode() ? undefined : mentionedRole(text)
}

/** Starts background work that lean mode leaves off. */
export function unlessLean(start: () => void): void {
  if (!leanMode()) start()
}
