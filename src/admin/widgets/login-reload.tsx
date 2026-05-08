/**
 * Injected into the admin login page.
 *
 * When a session expires Medusa does a React Router soft-nav to /login, leaving
 * React Query's cache full of stale 401 entries.  On re-login those stale
 * queries fire immediately, Medusa SDK throws "vz: Unauthorized", and the
 * React tree crashes back to /login.
 *
 * Fix: stamp sessionStorage on first load.  On every subsequent mount we detect
 * whether we arrived via soft-nav (session expiry) and hard-reload to wipe the
 * React Query cache so re-login succeeds.
 *
 * StrictMode safety: React 18 StrictMode runs each useEffect twice but PRESERVES
 * useRef values across its simulated remount.  A genuine React Router navigation
 * away-and-back creates a brand-new component instance with a fresh ref.  We use
 * that difference — didSetKey.current — to tell StrictMode's second invoke apart
 * from a real soft-nav without any timers or window globals.
 */
import { useEffect, useRef } from "react"
import { defineWidgetConfig } from "@medusajs/admin-sdk"

const VISITED_KEY = "_mhc_login_visited"

function LoginReloadWidget() {
  const didSetKey = useRef(false)

  useEffect(() => {
    if (sessionStorage.getItem(VISITED_KEY)) {
      if (didSetKey.current) {
        // StrictMode second invoke — we set the key ourselves this mount.
        // React preserved the ref, so we know this isn't a real soft-nav.
        return
      }
      // Key exists but ref is fresh → genuine soft-nav back to login.
      // Hard-reload wipes React Query cache so re-login works first time.
      sessionStorage.clear()
      window.location.reload()
      return
    }
    didSetKey.current = true
    sessionStorage.setItem(VISITED_KEY, "1")
  }, [])

  return null
}

export const config = defineWidgetConfig({ zone: "login.before" })
export default LoginReloadWidget
