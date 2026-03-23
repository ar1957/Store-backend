/**
 * Resolves the current admin user's role.
 * Uses /admin/my-role (fast single query) with fallback to the N+1 approach.
 * Cache is scoped to the user's email so it never bleeds between logins.
 */
export async function resolveMyRole(): Promise<string> {
  try {
    // Step 1: get current user's email (always needed for cache key)
    const meRes = await fetch("/admin/users/me", { credentials: "include" })
    if (!meRes.ok) return "super_admin"
    const { user } = await meRes.json()
    if (!user?.email) return "super_admin"

    // Step 2: check email-scoped cache
    const cacheKey = `mhc_role_${user.email}`
    const cached = sessionStorage.getItem(cacheKey)
    if (cached) return cached

    // Step 3: try fast single-query endpoint
    const roleRes = await fetch("/admin/my-role", { credentials: "include" })
    if (roleRes.ok) {
      const data = await roleRes.json()
      const role = data.role || "super_admin"
      sessionStorage.setItem(cacheKey, role)
      return role
    }

    // Step 4: fallback — N+1 clinic/staff lookup (works without backend restart)
    const { clinics } = await fetch("/admin/clinics", { credentials: "include" }).then(r => r.json())
    for (const clinic of (clinics || [])) {
      const { staff } = await fetch(`/admin/clinics/${clinic.id}/staff`, { credentials: "include" }).then(r => r.json())
      const match = (staff || []).find((s: any) => s.email === user.email)
      if (match?.role) {
        sessionStorage.setItem(cacheKey, match.role)
        return match.role
      }
    }

    sessionStorage.setItem(cacheKey, "super_admin")
    return "super_admin"
  } catch {
    return "super_admin"
  }
}

export function clearRoleCache() {
  const keys = Object.keys(sessionStorage).filter(k => k.startsWith("mhc_role_"))
  keys.forEach(k => sessionStorage.removeItem(k))
}
