/**
 * Injected into the admin login page.
 *
 * When a session expires Medusa does a React Router soft-nav to /login, which
 * leaves the React Query cache holding stale (failed) query entries.  When the
 * user logs in again, React Query immediately re-fires all those stale queries
 * before the new auth token has propagated — several return 401, Medusa SDK
 * throws "vz: Unauthorized", and the React tree crashes back to /login.
 *
 * Fix: detect soft-nav vs hard-nav by whether we've already stamped
 * _mhc_login_visited in sessionStorage for this tab.
 *   - First (hard-nav) landing: stamp the key, do nothing.
 *   - Subsequent landing (soft-nav from session expiry): clear all session
 *     storage and force a full page reload so React Query cache is pristine
 *     before the user authenticates.
 */
import { useEffect } from "react"
import { defineWidgetConfig } from "@medusajs/admin-sdk"

const VISITED_KEY = "_mhc_login_visited"

function LoginReloadWidget() {
  useEffect(() => {
    if (sessionStorage.getItem(VISITED_KEY)) {
      // Soft-nav back to login — session expired while the app was open.
      // Hard-reload to wipe React Query cache so re-login works first time.
      sessionStorage.clear()
      window.location.reload()
      return
    }
    // First visit in this tab: stamp so we can detect the next soft-nav.
    sessionStorage.setItem(VISITED_KEY, "1")
  }, [])

  return null
}

export const config = defineWidgetConfig({ zone: "login.before" })
export default LoginReloadWidget
