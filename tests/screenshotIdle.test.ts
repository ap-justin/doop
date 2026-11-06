import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const puppeteerMocks = vi.hoisted(() => ({ launch: vi.fn() }))
vi.mock('puppeteer-core', () => ({ default: { launch: puppeteerMocks.launch } }))

const IDLE_MS = 1000

interface FakeBrowser {
  connected: boolean
  close: ReturnType<typeof vi.fn>
  createBrowserContext: ReturnType<typeof vi.fn>
  contexts: Array<{ close: ReturnType<typeof vi.fn> }>
}

function fakeBrowser(): FakeBrowser {
  const browser: FakeBrowser = {
    connected: true,
    contexts: [],
    close: vi.fn(async () => {
      browser.connected = false
    }),
    createBrowserContext: vi.fn(async () => {
      const context = { close: vi.fn(async () => {}), newPage: vi.fn(async () => ({})) }
      browser.contexts.push(context)
      return context
    }),
  }
  return browser
}

let root: string
let screenshot: typeof import('../server/screenshot.ts')
let browsers: FakeBrowser[]

beforeEach(async () => {
  vi.useFakeTimers()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doop-idle-'))
  const chrome = path.join(root, 'chrome')
  fs.writeFileSync(chrome, '')
  fs.chmodSync(chrome, 0o755)
  vi.stubEnv('CHROME_PATH', chrome)
  vi.stubEnv('CHROME_IDLE_CLOSE_MS', String(IDLE_MS))
  browsers = []
  puppeteerMocks.launch.mockReset()
  puppeteerMocks.launch.mockImplementation(async () => {
    const browser = fakeBrowser()
    browsers.push(browser)
    return browser
  })
  vi.resetModules()
  screenshot = await import('../server/screenshot.ts')
})

/** screenshot.ts holds the env.ts instance this file's resetModules gave it, so reload that one. */
async function setIdleCloseMs(value: string): Promise<void> {
  vi.stubEnv('CHROME_IDLE_CLOSE_MS', value)
  ;(await import('../server/env.ts')).reloadEnv()
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('closing the browser when idle', () => {
  it('closes the browser once the last page has been idle for the set time', async () => {
    const isolated = await screenshot.openIsolatedPage()
    await isolated.close()

    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(browsers[0]?.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(browsers[0]?.close).toHaveBeenCalledOnce()
  })

  it('waits for every open page, not just the first to finish', async () => {
    const first = await screenshot.openIsolatedPage()
    const second = await screenshot.openIsolatedPage()
    await first.close()

    await vi.advanceTimersByTimeAsync(IDLE_MS * 5)
    expect(browsers[0]?.close).not.toHaveBeenCalled()

    await second.close()
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(browsers[0]?.close).toHaveBeenCalledOnce()
  })

  it('restarts the idle period when a page opens before it runs out', async () => {
    const first = await screenshot.openIsolatedPage()
    await first.close()
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)

    const second = await screenshot.openIsolatedPage()
    await vi.advanceTimersByTimeAsync(IDLE_MS * 5)
    expect(browsers[0]?.close).not.toHaveBeenCalled()

    await second.close()
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(browsers[0]?.close).toHaveBeenCalledOnce()
    expect(puppeteerMocks.launch).toHaveBeenCalledOnce()
  })

  it('counts a page once however many times it is closed', async () => {
    const first = await screenshot.openIsolatedPage()
    const second = await screenshot.openIsolatedPage()
    await first.close()
    await first.close()

    await vi.advanceTimersByTimeAsync(IDLE_MS * 5)
    expect(browsers[0]?.close).not.toHaveBeenCalled()
    await second.close()
  })

  it('does not close the browser while a launch is still in flight', async () => {
    let finishLaunch: (browser: FakeBrowser) => void = () => {}
    puppeteerMocks.launch.mockImplementationOnce(
      () =>
        new Promise<FakeBrowser>((resolve) => {
          finishLaunch = (browser) => {
            browsers.push(browser)
            resolve(browser)
          }
        }),
    )

    const opening = screenshot.openIsolatedPage()
    await vi.advanceTimersByTimeAsync(IDLE_MS * 5)
    const browser = fakeBrowser()
    finishLaunch(browser)

    const isolated = await opening
    await vi.advanceTimersByTimeAsync(IDLE_MS * 5)
    expect(browser.close).not.toHaveBeenCalled()

    await isolated.close()
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it('releases the lease when the page cannot be opened', async () => {
    const browser = fakeBrowser()
    browser.createBrowserContext.mockRejectedValueOnce(new Error('context refused'))
    puppeteerMocks.launch.mockResolvedValueOnce(browser)
    browsers.push(browser)

    await expect(screenshot.openIsolatedPage()).rejects.toThrow('context refused')
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it('launches again on the next request after an idle close', async () => {
    const first = await screenshot.openIsolatedPage()
    await first.close()
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(puppeteerMocks.launch).toHaveBeenCalledOnce()

    const second = await screenshot.openIsolatedPage()
    expect(puppeteerMocks.launch).toHaveBeenCalledTimes(2)
    expect(browsers[1]?.contexts).toHaveLength(1)
    expect(browsers[1]?.close).not.toHaveBeenCalled()
    await second.close()
  })

  it('starts a fresh browser for a page that opens while the old one shuts down', async () => {
    const first = await screenshot.openIsolatedPage()
    let finishClose: () => void = () => {}
    const old = browsers[0]!
    old.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = () => {
            old.connected = false
            resolve()
          }
        }),
    )
    await first.close()
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(old.close).toHaveBeenCalledOnce()

    const second = await screenshot.openIsolatedPage()
    expect(browsers).toHaveLength(2)
    finishClose()
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(browsers[1]?.close).not.toHaveBeenCalled()
    await second.close()
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(browsers[1]?.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(browsers[1]?.close).toHaveBeenCalledOnce()
    expect(old.close).toHaveBeenCalledOnce()
  })

  it('keeps the browser for good when the idle time is 0', async () => {
    await setIdleCloseMs('0')
    const isolated = await screenshot.openIsolatedPage()
    await isolated.close()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(browsers[0]?.close).not.toHaveBeenCalled()
  })

  it.each(['', '  ', '-5', '0.5', 'Infinity', 'soon'])(
    'falls back to two minutes when the setting is %j',
    async (value) => {
      await setIdleCloseMs(value)
      const isolated = await screenshot.openIsolatedPage()
      await isolated.close()
      await vi.advanceTimersByTimeAsync(119_999)
      expect(browsers[0]?.close).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(browsers[0]?.close).toHaveBeenCalledOnce()
    },
  )
})

describe('failures and concurrency', () => {
  it('launches again after a failed launch, and the new browser still idle-closes', async () => {
    puppeteerMocks.launch.mockRejectedValueOnce(new Error('cold start timed out'))
    await expect(screenshot.openIsolatedPage()).rejects.toThrow('cold start timed out')

    const isolated = await screenshot.openIsolatedPage()
    expect(puppeteerMocks.launch).toHaveBeenCalledTimes(2)
    await isolated.close()
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(browsers).toHaveLength(1)
    expect(browsers[0]?.close).toHaveBeenCalledOnce()
  })

  it('shares one launch between concurrent cold-start opens and counts both leases', async () => {
    const [first, second] = await Promise.all([screenshot.openIsolatedPage(), screenshot.openIsolatedPage()])
    expect(puppeteerMocks.launch).toHaveBeenCalledOnce()
    expect(browsers[0]?.contexts).toHaveLength(2)

    await first.close()
    await vi.advanceTimersByTimeAsync(IDLE_MS * 5)
    expect(browsers[0]?.close).not.toHaveBeenCalled()
    await second.close()
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(browsers[0]?.close).toHaveBeenCalledOnce()
  })

  it('relaunches a browser that disconnected between requests, and closes the new one when idle', async () => {
    const first = await screenshot.openIsolatedPage()
    await first.close()
    browsers[0]!.connected = false

    const second = await screenshot.openIsolatedPage()
    expect(puppeteerMocks.launch).toHaveBeenCalledTimes(2)
    expect(browsers[1]?.contexts).toHaveLength(1)
    await second.close()
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(browsers[1]?.close).toHaveBeenCalledOnce()
  })

  it('shares one relaunch between concurrent opens that find the browser dead', async () => {
    const held = await screenshot.openIsolatedPage()
    browsers[0]!.connected = false

    const [first, second] = await Promise.all([screenshot.openIsolatedPage(), screenshot.openIsolatedPage()])
    expect(puppeteerMocks.launch).toHaveBeenCalledTimes(2)
    expect(browsers[1]?.contexts).toHaveLength(2)

    await Promise.all([held.close(), first.close()])
    await vi.advanceTimersByTimeAsync(IDLE_MS * 5)
    expect(browsers[1]?.close).not.toHaveBeenCalled()
    await second.close()
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(browsers[1]?.close).toHaveBeenCalledOnce()
  })

  it('survives browser.close() rejecting and launches fresh on the next open', async () => {
    const first = await screenshot.openIsolatedPage()
    await first.close()
    browsers[0]!.close.mockRejectedValueOnce(new Error('chrome already gone'))
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(browsers[0]?.close).toHaveBeenCalledOnce()

    const second = await screenshot.openIsolatedPage()
    expect(puppeteerMocks.launch).toHaveBeenCalledTimes(2)
    await second.close()
  })

  it('closes the context and releases the lease when newPage rejects', async () => {
    const browser = fakeBrowser()
    const context = { close: vi.fn(async () => {}), newPage: vi.fn().mockRejectedValue(new Error('no page')) }
    browser.createBrowserContext.mockResolvedValueOnce(context)
    browsers.push(browser)
    puppeteerMocks.launch.mockResolvedValueOnce(browser)

    await expect(screenshot.openIsolatedPage()).rejects.toThrow('no page')
    expect(context.close).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it('releases the lease even when closing the page context rejects', async () => {
    const isolated = await screenshot.openIsolatedPage()
    browsers[0]!.contexts[0]!.close.mockRejectedValueOnce(new Error('context already gone'))

    await isolated.close()
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(browsers[0]?.close).toHaveBeenCalledOnce()
  })
})

describe('launch options', () => {
  it('leaves SIGINT, SIGTERM and SIGHUP to the server', async () => {
    const isolated = await screenshot.openIsolatedPage()
    await isolated.close()

    expect(puppeteerMocks.launch.mock.calls[0]?.[0]).toMatchObject({
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    })
  })
})
