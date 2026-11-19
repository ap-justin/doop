import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CustomFont } from '../shared/fonts'
import { fontFaceRule } from '../shared/fonts'

/* The swap that follows a replacing upload runs after the upload is stored, so nothing it
   hits may fail the upload or stop the canvases after it. In process: the store is real,
   persistence is stubbed, and the announcement is the one the library module makes. */

const stored = vi.hoisted(() => ({
  rows: new Map<string, { id: string; html: string }[]>(),
  failLoad: new Set<string>(),
}))
const holding = vi.hoisted(() => ({
  find: vi.fn<(ids: readonly string[], texts: readonly string[]) => Promise<string[]>>(),
}))

vi.mock('../server/db/persist.ts', () => ({
  saveToken: () => {},
  deleteToken: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveFrameVersion: () => {},
  saveComponent: () => {},
  saveLibraryComponent: () => {},
  frameWritePending: () => false,
  retryFrameWrite: () => {},
  loadFrameHtml: async (canvasId: string) => {
    if (stored.failLoad.has(canvasId)) throw new Error('the read failed')
    return stored.rows.get(canvasId) ?? []
  },
  canvasesWithFrameText: (ids: readonly string[], texts: readonly string[]) => holding.find(ids, texts),
}))

vi.mock('../server/thumbs.ts', () => ({ purge: () => {} }))

const NEXT: CustomFont = {
  id: 'next',
  family: 'Fail Sans',
  weight: '400',
  style: 'normal',
  format: 'woff2',
  url: 'https://doop.test/a/next.woff2',
  fileName: 'next.woff2',
  size: 1,
  createdAt: 2,
}
vi.mock('../server/fonts.ts', () => ({ fontsForCanvas: () => [NEXT] }))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { announceFacesReplaced } = await import('../server/fontReplaced.ts')

actions.wire(
  () => {},
  () => {},
)

let counter = 0
/** a face of the family under its own file, so each test's canvases are its own */
function oldFace(): CustomFont {
  const n = ++counter
  return {
    ...NEXT,
    id: `old-${n}`,
    url: `https://doop.test/a/old-${n}.woff2`,
    fileName: `old-${n}.woff2`,
    createdAt: 1,
  }
}

/** a workspace canvas whose one frame's font block names `face`; written as an annotation so the
 *  library's covering face is not added at creation */
function canvasNaming(workspaceId: string, face: CustomFont) {
  const canvas = store.createCanvas(`c${++counter}`, 'owner', workspaceId)
  const frame = actions.createFrame(
    canvas.id,
    { name: 'F', html: '<!doctype html><html><head></head><body><p>Hi</p></body></html>' },
    { name: 'Tester', kind: 'user', color: '#000' },
  )!
  const html = `<!doctype html><html><head><style data-doop-fonts>\n${fontFaceRule(face)}\n</style></head><body><p style="font-family:'Fail Sans'">Hi</p></body></html>`
  store.updateFrame(frame.id, { html }, 'Tester', { annotation: true })
  stored.rows.set(canvas.id, [{ id: frame.id, html }])
  return { canvasId: canvas.id, frameId: frame.id }
}

const announce = (workspaceId: string, from: CustomFont) =>
  announceFacesReplaced({ scope: { workspaceId }, userId: 'owner', replaced: [{ from: from.url, to: NEXT }] })

afterEach(() => {
  vi.restoreAllMocks()
  holding.find.mockReset()
  stored.failLoad.clear()
})

describe('a swap that fails somewhere', () => {
  it('lets the next loaded canvas swap when one canvas’s write throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const face = oldFace()
    const first = canvasNaming('ws-loaded', face)
    const second = canvasNaming('ws-loaded', face)
    const real = store.updateFrame.bind(store)
    vi.spyOn(store, 'updateFrame').mockImplementation((id, ...rest) => {
      if (id === first.frameId) throw new Error('write refused')
      return real(id, ...rest)
    })

    expect(() => announce('ws-loaded', face)).not.toThrow()

    expect(store.getFrame(second.frameId)!.html).toContain(NEXT.url)
    expect(store.getFrame(second.frameId)!.html).not.toContain(face.url)
    expect(store.getFrame(first.frameId)!.html).toContain(face.url)
    expect(error).toHaveBeenCalledWith(expect.stringContaining(first.canvasId), expect.any(Error))
  })

  describe('on canvases that went idle', () => {
    function idle(...canvasIds: string[]) {
      store.evictIdle(0, Date.now() + 1)
      for (const id of canvasIds) expect(store.isLoaded(id)).toBe(false)
    }

    it('swaps the canvases the lookup names, once they are read back', async () => {
      const face = oldFace()
      const only = canvasNaming('ws-idle-live', face)
      idle(only.canvasId)
      holding.find.mockResolvedValue([only.canvasId])

      announce('ws-idle-live', face)

      await expect.poll(() => store.getFrame(only.frameId)!.html.includes(NEXT.url), { timeout: 5000 }).toBe(true)
      expect(holding.find).toHaveBeenCalledWith([only.canvasId], [face.url])
    })

    it('logs and swaps nothing when the lookup of canvases rejects, and the announcement still returns', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const face = oldFace()
      const only = canvasNaming('ws-idle-lookup', face)
      idle(only.canvasId)
      holding.find.mockRejectedValue(new Error('database unreachable'))

      expect(() => announce('ws-idle-lookup', face)).not.toThrow()

      await expect.poll(() => error.mock.calls.length, { timeout: 5000 }).toBe(1)
      expect(String(error.mock.calls[0]![0])).toContain('finding the canvases that use it failed')
      expect(store.isLoaded(only.canvasId)).toBe(false)
    })

    it('lets the next canvas swap when reading one back fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const face = oldFace()
      const broken = canvasNaming('ws-idle-read', face)
      const fine = canvasNaming('ws-idle-read', face)
      idle(broken.canvasId, fine.canvasId)
      stored.failLoad.add(broken.canvasId)
      holding.find.mockResolvedValue([broken.canvasId, fine.canvasId])

      announce('ws-idle-read', face)

      await expect.poll(() => store.getFrame(fine.frameId)!.html.includes(NEXT.url), { timeout: 5000 }).toBe(true)
      expect(error).toHaveBeenCalledWith(expect.stringContaining(broken.canvasId), expect.any(Error))
    })
  })
})
