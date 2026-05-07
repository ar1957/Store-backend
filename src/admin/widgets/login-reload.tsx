/**
 * Injected into the admin login page.
 *
 * When a session expires, Medusa does a React Router soft-nav to /login which
 * leaves the React Query cache holding stale 401 auth data.  The auth-monitor
 * fetch interceptor (installed by other widgets) sets _mhc_auth_stale in
 * sessionStorage when it detects a 401 on any admin endpoint.  This widget
 * reads that flag and triggers a hard browser reload before the user sees the
 * login form, which clears all React state and the React Query cache so the
 * subsequent login works on the first attempt.
 */
import { useEffect } from "react"
import { defineWidgetConfig } from "@medusajs/admin-sdk"

function LoginReloadWidget() {
  useEffect(() => {
    if (!sessionStorage.getItem("_mhc_auth_stale")) return

    // Clear stale role caches so the next session starts fresh
    for (const key of [...Object.keys(sessionStorage)]) {
      if (key.startsWith("mhc_role_")) sessionStorage.removeItem(key)
    }
    sessionStorage.removeItem("_mhc_auth_stale")

    // Hard reload clears React Query cache and any stale auth interceptors
    window.location.reload()
  }, [])

  return null
}

export const config = defineWidgetConfig({ zone: "login.before" })
export default LoginReloadWidget
