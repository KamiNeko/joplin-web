import * as React from "react"

const MOBILE_BREAKPOINT = 768

/** True below `breakpoint` px (default: the md breakpoint, where the layout switches to one pane). */
export function useIsMobile(breakpoint = MOBILE_BREAKPOINT) {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    },
    [breakpoint]
  )
  return React.useSyncExternalStore(
    subscribe,
    () => window.innerWidth < breakpoint,
    () => false
  )
}
