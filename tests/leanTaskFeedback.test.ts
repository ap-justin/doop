import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/* Who a human reply to a task is addressed to. Lean runs no resident agent, so
   a reply addressed to a resident role would wait for a claim that never comes. */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
}))

// addTaskFeedback fires an unawaited import of the resident; without this it can run a real sweep after the env stub is gone
vi.mock('../server/resident.ts', () => ({ onFeedback: vi.fn() }))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')

let canvasId: string

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  canvasId = store.createCanvas('lean feedback', 'alice').id
})

afterEach(() => {
  unstubAllEnvs()
})

/** A reply to a task run by an agent that called itself after a resident role. */
function replyToCopywriterTask() {
  actions.setAgentStatus(canvasId, { name: 'copywriter', kind: 'agent', color: '#000000' }, 'Writing the hero')
  const task = actions.getTasks(canvasId)[0]!
  return actions.addTaskFeedback(task.id, 'alice', 'warmer headline', 'alice')!
}

describe('a reply to a task whose agent shares a resident role name', () => {
  it('is left unaddressed when lean is on, so any MCP agent can claim it', () => {
    stubEnv('DOOP_LEAN', '1')
    const fb = replyToCopywriterTask()
    expect(fb.targetAgent).toBeUndefined()
    expect(actions.takeFeedbackFor(canvasId, 'Claude Code').map((f) => f.id)).toEqual([fb.id])
  })

  it('goes to the resident role when lean is off', () => {
    stubEnv('DOOP_LEAN', '')
    const fb = replyToCopywriterTask()
    expect(fb.targetAgent).toBe('Copywriter')
    expect(actions.takeFeedbackFor(canvasId, 'Claude Code')).toEqual([])
  })
})
