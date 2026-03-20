/**
 * File: src/admin/widgets/restrict-nav.tsx
 * Zone: order.list.before
 * Simple redirect — when anyone hits /app/orders, send to /app/clinic-orders.
 * Nav restriction logic lives in clinic-orders/page.tsx itself.
 */
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { useEffect } from "react"

function RestrictNavWidget() {
  useEffect(() => {
    if (window.location.pathname === "/app/orders") {
      window.location.replace("/app/clinic-orders")
    }
  }, [])
  return null
}

export const config = defineWidgetConfig({
  zone: "order.list.before",
})

export default RestrictNavWidget