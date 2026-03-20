import { defineRouteConfig } from "@medusajs/admin-sdk"
import { ShoppingCart } from "@medusajs/icons"

export const config = defineRouteConfig({
  label: "Clinic Orders",
  icon: ShoppingCart,
})