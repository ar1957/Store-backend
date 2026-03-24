/**
 * Widget injected into the customers list page.
 * Redirects clinic staff (non-super-admin) away — they should not see all customers.
 */
import { useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { defineWidgetConfig } from "@medusajs/admin-sdk"

async function resolveMyRole(): Promise<string> {
  try {
    const { user } = await fetch("/admin/users/me", { credentials: "include" }).then(r => r.json())
    if (!user?.email) return "super_admin"
    const cacheKey = `mhc_role_${user.email}`
    const cached = sessionStorage.getItem(cacheKey)
    if (cached) return cached
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
  } catch {}
  return "super_admin"
}

function CustomersGuardWidget() {
  const navigate = useNavigate()

  useEffect(() => {
    resolveMyRole().then(role => {
      if (role !== "super_admin") {
        // Clinic staff must not see all customers — send them to their clinic orders
        navigate("/clinic-orders", { replace: true })
      }
    })
  }, [])

  return null
}

export const config = defineWidgetConfig({
  zone: "customer.list.before",
})

export default CustomersGuardWidget
