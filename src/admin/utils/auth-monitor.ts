/**
 * Installs a one-time fetch interceptor that detects when any admin API
 * request returns 401 and sets a sessionStorage flag.  The login-reload
 * widget reads this flag and triggers a hard page reload so React Query's
 * stale auth cache is cleared before the user attempts to log in again.
 */
export function installAuthMonitor(): void {
  if (typeof window === "undefined" || (window as any).__mhcAuthMonitor) return
  ;(window as any).__mhcAuthMonitor = true

  const orig = window.fetch
  window.fetch = async (...args): Promise<Response> => {
    const response = await orig.apply(window, args)
    if (response.status === 401) {
      const url =
        typeof args[0] === "string"
          ? args[0]
          : args[0] instanceof URL
          ? args[0].href
          : (args[0] as Request).url
      if (url.includes("/admin/")) {
        sessionStorage.setItem("_mhc_auth_stale", "1")
      }
    }
    return response
  }
}
