import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import {
  activeExtensions,
  isLeanDisabledPath,
  leanGate,
  leanMode,
  residentMention,
  unlessLean,
} from '../server/lean.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/**
 * Lean mode is one switch, DOOP_LEAN=1: the features it turns off answer as
 * routes that do not exist, and their background work never starts.
 */

afterEach(unstubAllEnvs)

describe('leanMode', () => {
  it('is on only for exactly 1', () => {
    stubEnv('DOOP_LEAN', '1')
    expect(leanMode()).toBe(true)
    for (const off of [undefined, '', '0', 'true', 'yes', ' 2']) {
      stubEnv('DOOP_LEAN', off)
      expect(leanMode()).toBe(false)
    }
  })
})

describe('isLeanDisabledPath', () => {
  const disabled = [
    '/relay',
    '/relay/e/',
    '/relay/static/array.js',
    '/stripe/webhook',
    '/webhooks/slack',
    '/webhooks/linear/events',
    '/local-agent/mcp/abc',
    '/gemini-cloud/mcp/abc',
    '/api/live-activities',
    '/api/live-activities/config',
    '/api/community',
    '/api/community/abc/copy',
    '/api/automations',
    '/api/automations/abc/run',
    '/api/integrations',
    '/api/integrations/meta',
    '/api/integrations/linear/callback',
    '/api/model-account',
    '/api/model-account/models',
    '/api/model-account/chatgpt/device',
    '/api/agent-runners',
    '/api/agent-runners/default',
    '/api/agent-allowance',
    '/api/local-agent',
    '/api/local-agent/poll',
    '/api/image-model',
    '/api/billing',
    '/api/billing/plans',
    '/api/github/app',
    '/api/github/app/setup',
    '/api/canvases/c1/github',
    '/api/canvases/c1/github/app/start',
    '/api/canvases/c1/github/conn/import',
    '/api/canvases/c1/cards',
    '/api/canvases/c1/cards/t1/retry',
    '/api/canvases/c1/publish',
    '/api/tasks/t1/feedback',
    '/api/feedback/f1/retry',
    '/api/comments/x1/retry',
    '/api/workspaces/w1/billing/checkout',
    '/api/workspaces/w1/billing/portal',
    '/api/workspaces/w1/billing/sync',
    /* express matches routes case-insensitively and ignores a trailing slash */
    '/API/Billing/plans',
    '/api/community/',
  ]
  const kept = [
    '/healthz',
    '/api/locale-config',
    '/api/workspaces',
    '/api/workspaces/w1',
    '/api/workspaces/w1/members',
    '/api/agent-keys',
    '/api/webhooks',
    '/api/webhooks/h1',
    '/api/canvases',
    '/api/canvases/c1',
    '/api/canvases/c1/comments',
    '/api/canvases/c1/fonts',
    '/api/canvases/c1/duplicate',
    '/api/canvases/c1/export.pdf',
    '/api/comments/x1/replies',
    '/api/comments/x1/resolve',
    '/api/frames/f1/comments',
    '/api/fonts',
    '/api/me',
    '/api/auth/sign-in/email',
    '/mcp',
    '/a/abc.png',
    '/i/abc.png',
    '/c/abc',
    '/api/canvases/c1/githubish',
    '/api/communityx',
    '/relayed',
  ]

  it.each(disabled)('disables %s', (path) => {
    expect(isLeanDisabledPath(path)).toBe(true)
  })

  it.each(kept)('keeps %s', (path) => {
    expect(isLeanDisabledPath(path)).toBe(false)
  })
})

describe('activeExtensions', () => {
  it('is the whole list when lean is off and empty when it is on', () => {
    const all = [{ id: 'linear' }, { id: 'slack' }]
    expect(activeExtensions(all)).toBe(all)
    stubEnv('DOOP_LEAN', '1')
    expect(activeExtensions(all)).toEqual([])
  })
})

describe('residentMention', () => {
  it('reads an @mention as a call to the resident agent only when lean is off', () => {
    expect(residentMention('@Doop make it blue')?.name).toBe('Doop')
    expect(residentMention('make it blue')).toBeUndefined()
    stubEnv('DOOP_LEAN', '1')
    expect(residentMention('@Doop make it blue')).toBeUndefined()
  })
})

describe('unlessLean', () => {
  it('starts background work only when lean is off', () => {
    const start = vi.fn()
    stubEnv('DOOP_LEAN', '1')
    unlessLean(start)
    expect(start).not.toHaveBeenCalled()
    stubEnv('DOOP_LEAN', undefined)
    unlessLean(start)
    expect(start).toHaveBeenCalledOnce()
  })
})

describe('leanGate', () => {
  /** An app shaped like the server's: the gate first, then a real route. */
  async function serve() {
    const app = express()
    app.use(leanGate)
    app.get('/api/billing/plans', (_req, res) => res.json({ plans: [] }))
    app.get('/api/locale-config', (_req, res) => res.json({ ok: true }))
    const server = app.listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return { base, close: () => new Promise((resolve) => server.close(resolve)) }
  }

  it('answers a disabled route exactly as a route that does not exist', async () => {
    stubEnv('DOOP_LEAN', '1')
    const { base, close } = await serve()
    try {
      const gated = await fetch(`${base}/api/billing/plans`)
      const missing = await fetch(`${base}/api/nothing-here`)
      expect(gated.status).toBe(404)
      expect(gated.headers.get('content-type')).toBe(missing.headers.get('content-type'))
      expect((await gated.text()).replace('/api/billing/plans', '<path>')).toBe(
        (await missing.text()).replace('/api/nothing-here', '<path>'),
      )
      expect((await fetch(`${base}/api/locale-config`)).status).toBe(200)
    } finally {
      await close()
    }
  })

  it('lets every route through when lean is off', async () => {
    const { base, close } = await serve()
    try {
      const res = await fetch(`${base}/api/billing/plans`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ plans: [] })
    } finally {
      await close()
    }
  })
})
