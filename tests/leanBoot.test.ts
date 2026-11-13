import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/**
 * What lean mode keeps from starting. The boot steps live inside
 * server/index.ts, which only runs as a whole server, and the resident kicks
 * inside actions.ts's mutations, so the guard at each call site is read from
 * the source: every start of that work is wrapped, and a call added bare or
 * a wrapper deleted turns a line here red. server/lean.ts's own helpers are
 * exercised in lean.test.ts.
 */

function source(file: string): string {
  return readFileSync(path.join(process.cwd(), 'server', file), 'utf8')
}

/** The code lines (imports and comments left out) that mention `token`. */
function linesUsing(src: string, token: string): string[] {
  return src
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(token) && !line.startsWith('import ') && !/^(\/\*|\*|\/\/)/.test(line))
}

describe('server/index.ts boot', () => {
  const index = source('index.ts')

  it('starts the automation scheduler and live-activity delivery only unless lean', () => {
    expect(linesUsing(index, 'startScheduler')).toEqual(['unlessLean(startScheduler)'])
    expect(linesUsing(index, 'startLiveActivityDelivery')).toEqual(['unlessLean(startLiveActivityDelivery)'])
  })

  it('starts extension workers only for the extensions lean leaves active', () => {
    expect(linesUsing(index, '.startWorker')).toEqual([
      'for (const extension of activeExtensions(extensions)) extension.startWorker?.()',
    ])
  })

  it('imports the local agent, and with it the resident agent, only unless lean', () => {
    expect(index).toMatch(/\}\s*=\s*leanMode\(\)\s*\?[^]*?:\s*await import\('\.\/localAgent\.ts'\)/)
    expect(linesUsing(index, "'./localAgent.ts'")).toEqual([": await import('./localAgent.ts')"])
  })

  it('kicks the resident agent after boot and on a join only unless lean', () => {
    expect(linesUsing(index, "import('./resident.ts')")).toHaveLength(2)
    expect(index).toMatch(/if \(!leanMode\(\)\) \{\s*const pending = [^]*?import\('\.\/resident\.ts'\)/)
    expect(index).toMatch(/if \(!leanMode\(\) && actions\.getTasks\(msg\.canvasId\)[^]*?import\('\.\/resident\.ts'\)/)
  })

  it('seeds the welcome canvas and plays the demo only unless lean', () => {
    expect(linesUsing(index, 'seed()')).toEqual(['if (!leanMode()) seed()'])
    expect(linesUsing(index, 'demo.maybePlay')).toEqual([
      'if (!leanMode()) demo.maybePlay(msg.canvasId) // first visit to a fresh signup canvas: the demo agent performs',
    ])
  })
})

describe('the resident kicks of server/actions.ts', () => {
  it('start the resident agent only unless lean, at every mutation that does', () => {
    const kicks = linesUsing(source('actions.ts'), "import('./resident.ts')")
    expect(kicks.length).toBeGreaterThan(0)
    for (const kick of kicks) expect(kick).toMatch(/^if \(!leanMode\(\)\) import\('\.\/resident\.ts'\)/)
  })
})

describe('an automation step that queues a card', () => {
  it('leaves the resident agent alone in lean mode', () => {
    expect(source('automations.ts')).toMatch(
      /if \(leanMode\(\)\) return\s+const \{ onFeedback \} = await import\('\.\/resident\.ts'\)/,
    )
  })
})

describe('the local-run expiry timer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
  })
  afterEach(() => {
    vi.useRealTimers()
    unstubAllEnvs()
  })

  /* import-time work: a fresh module is the only way to observe it */
  async function timersAfterImport(lean: string | undefined): Promise<number> {
    stubEnv('DOOP_LEAN', lean)
    await import('../server/localAgentRuns.ts')
    return vi.getTimerCount()
  }

  it('ticks with lean off', async () => {
    expect(await timersAfterImport(undefined)).toBe(1)
  })

  it('is cleared in lean mode', async () => {
    expect(await timersAfterImport('1')).toBe(0)
  })
})
