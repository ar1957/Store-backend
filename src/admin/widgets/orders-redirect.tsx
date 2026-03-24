/**
 * Widget injected into the orders list page.
 * - Redirects ALL roles to /clinic-orders (everyone uses clinic-orders)
 * - Applies nav restrictions based on role
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

function applyNavForRole(role: string) {
  document.getElementById("mhc-nav-restrictions")?.remove()
  document.getElementById("mhc-search-hide")?.remove()
  const s = document.createElement("style")
  s.id = "mhc-nav-restrictions"

  // Hide search bar for all non-super-admin roles
  if (role !== "super_admin") {
    const sh = document.createElement("style")
    sh.id = "mhc-search-hide"
    sh.textContent = `
      button.bg-ui-bg-subtle.gap-x-2\\.5 { display: none !important; }
    `
    document.head.appendChild(sh)
  }

  if (role === "medical_director" || role === "pharmacist") {
    s.textContent = `
      a[href="/app/orders"],
      a[href="/app/products"],
      a[href="/app/inventory"],
      a[href="/app/customers"],
      a[href="/app/promotions"],
      a[href="/app/price-lists"],
      a[href="/app/reservations"],
      a[href="/app/settings"],
      a[href^="/app/settings/"],
      a[href="/app/provider-settings"] { display: none !important; }
    `
  } else if (role === "clinic_admin") {
    s.textContent = `
      a[href="/app/orders"],
      a[href="/app/customers"],
      a[href="/app/promotions"],
      a[href="/app/settings"],
      a[href^="/app/settings/"] { display: none !important; }
    `
  } else {
    // super_admin: hide only the standard orders nav item
    s.textContent = `a[href="/app/orders"] { display: none !important; }`
  }

  document.head.appendChild(s)
}

function OrdersRedirectWidget() {
  const navigate = useNavigate()

  useEffect(() => {
    resolveMyRole().then(role => {
      applyNavForRole(role)
      // Everyone uses clinic-orders — redirect away from the standard orders page
      navigate("/clinic-orders", { replace: true })
    })
  }, [])

  return null
}

export const config = defineWidgetConfig({
  zone: "order.list.before",
})

export default OrdersRedirectWidget
