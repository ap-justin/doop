import { isLean } from './lean'

/** the SPA's one way to move: push the path and let App's popstate listener re-render */
export function navigate(path: string) {
  history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/* the pages of features lean mode turns off, matched as App's router matches them */
const LEAN_OFF_PATHS = ['/community', '/integrations', '/automations']

/** The address App routes on. In lean mode a turned-off page lands home and
 *  the address bar says so; lean is settled before the first render. */
export function currentRoute(): string {
  if (isLean() && LEAN_OFF_PATHS.some((off) => location.pathname.startsWith(off))) {
    history.replaceState(null, '', '/')
    return '/'
  }
  return location.pathname + location.search
}
