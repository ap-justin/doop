// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importSources } from '../src/components/importSourceList'
import { SourcePicker } from '../src/components/ImportSources'
import { Modal } from '../src/components/ui/modal'
import { setLean, useLean } from '../src/lib/lean'

/* The import picker as Home and the canvas page mount it: sources from
   importSources(undefined, useLean()). Lean keeps the website and the live app. */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Picker() {
  const lean = useLean()
  return (
    <Modal onClose={() => {}}>
      <SourcePicker sources={importSources(undefined, lean)} onPick={() => {}} />
    </Modal>
  )
}

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<Picker />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  setLean(false)
})

describe('the import picker', () => {
  it('offers the website, live app and GitHub sources when lean is off', () => {
    expect(document.body.textContent).toContain('Website')
    expect(document.body.textContent).toContain('Live app')
    expect(document.body.textContent).toContain('GitHub repo')
  })

  it('drops GitHub as soon as a late lean answer arrives, keeping the website and live app', async () => {
    await act(async () => setLean(true))
    expect(document.body.textContent).not.toContain('GitHub repo')
    expect(document.body.textContent).toContain('Website')
    expect(document.body.textContent).toContain('Live app')
  })

  it('brings the sources back when lean goes off again', async () => {
    await act(async () => setLean(true))
    await act(async () => setLean(false))
    expect(document.body.textContent).toContain('GitHub repo')
  })
})
