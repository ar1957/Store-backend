/**
 * Injected into the admin login page.
 *
 * When a session expires Medusa does a React Router soft-nav to /login, leaving
 * React Query's cache full of stale 401 entries.  On re-login those stale
 * queries fire immediately, Medusa SDK throws "vz: Unauthorized", and the
 * React tree crashes back to /login.
 *
 * Fix: stamp a timestamp in sessionStorage on first load.  On every subsequent
 * mount we check two things before hard-reloading:
 *
 *   1. useRef guard — React 18 StrictMode re-runs each useEffect on the SAME
 *      component instance (ref is preserved).  If didSetKey.current is true, we
 *      set the key ourselves this load and this is just StrictMode's second
 *      invoke → skip.
 *
 *   2. Timestamp guard — after a hard reload Medusa's own auth guard fires a
 *      soft-nav back to /login within milliseconds, creating a new component
 *      instance (fresh ref = false) that would otherwise trigger another reload.
 *      A genuine session-expiry soft-nav always has a key that is many minutes
 *      or hours old.  We only reload when age > 5 s; rapid re-mounts (< 5 s)
 *      just refresh the timestamp and bail.
 */
import { useEffect, useRef } from "react"
import { defineWidgetConfig } from "@medusajs/admin-sdk"

const VISITED_KEY = "_mhc_login_visited"
const MAX_FRESH_MS = 5000

function LoginReloadWidget() {
  const didSetKey = useRef(false)

  useEffect(() => {
    const stored = sessionStorage.getItem(VISITED_KEY)

    if (stored) {
      // Guard 1: StrictMode second invoke on the same instance.
      if (didSetKey.current) return

      // Guard 2: key was stamped very recently — Medusa's auth-guard re-nav
      // or another rapid remount.  Refresh the timestamp and bail.
      const age = Date.now() - Number(stored)
      if (!isNaN(age) && age < MAX_FRESH_MS) {
        sessionStorage.setItem(VISITED_KEY, String(Date.now()))
        return
      }

      // Key is old (genuine session expiry) or unparseable (legacy "1" value).
      // Hard-reload to wipe React Query cache so re-login works first time.
      sessionStorage.clear()
      window.location.reload()
      return
    }

    // No key yet — first visit this load.
    didSetKey.current = true
    sessionStorage.setItem(VISITED_KEY, String(Date.now()))
  }, [])

  return null
}

export const config = defineWidgetConfig({ zone: "login.before" })
export default LoginReloadWidget
