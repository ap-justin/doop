import type { RequestHandler } from 'express'
import { env } from './env.ts'
import { mentionedRole, type AgentRole } from '../shared/agents.ts'

/**
 * Lean mode (DOOP_LEAN=1 or true, any case): Doop as a shared canvas for MCP
 * agents, without the in-app Doop Agent and model accounts, new billing, Slack
 * and Linear, automations, GitHub and Meta import, Community, the desktop
 * connect relay, iOS live activities, Gemini cloud workers and the PostHog
 * relay. Image generation draws on the server's own keys only, and Stripe
 * subscriptions already on file are still cancelled and seat-synced. Off, the
 * server is unchanged.
 *
 * The features stay in the code: their routes are refused here, and their
 * background workers are skipped at the points that start them.
 */

const LEAN_ON = /^(1|true)$/i
const LEAN_OFF = /^(0|false)?$/i

function leanValue(): string {
  return (env.DOOP_LEAN ?? '').trim()
}

/** Read per call, so a test can flip it (tests/envStub.ts). */
export function leanMode(): boolean {
  return LEAN_ON.test(leanValue())
}

/** DOOP_LEAN as set, when it is neither an on nor an off spelling (`yes`, `on`), which leaves lean off. */
export function unrecognisedLeanValue(): string | undefined {
  const value = leanValue()
  return LEAN_ON.test(value) || LEAN_OFF.test(value) ? undefined : env.DOOP_LEAN
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

/** The resident role a comment @mentions: none in lean mode, where the in-app
 *  agent is off, so an @mention is plain text — not queued, metered or refused. */
export function residentMention(text: string): AgentRole | undefined {
  return leanMode() ? undefined : mentionedRole(text)
}

/** Starts background work that lean mode leaves off. */
export function unlessLean(start: () => void): void {
  if (!leanMode()) start()
}
