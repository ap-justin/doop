// Preloaded into a test server (NODE_OPTIONS=--import): Date.now() runs ahead by the
// milliseconds written in CLOCK_SHIFT_FILE, so a test crosses a rate-limit window without waiting.
// Read on every call: a cached shift can miss a write made just before the next request.
import { readFileSync } from 'node:fs'
import process from 'node:process'

const file = process.env.CLOCK_SHIFT_FILE
if (file) {
  const real = Date.now.bind(Date)
  Date.now = () => {
    let shift = 0
    try {
      shift = Number(readFileSync(file, 'utf8')) || 0
    } catch {
      /* no file, no shift */
    }
    return real() + shift
  }
}
