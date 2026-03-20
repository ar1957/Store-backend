import { 
  defineMiddlewares, 
  MedusaNextFunction, 
  MedusaRequest, 
  MedusaResponse 
} from "@medusajs/framework/http"

// Routes to block ONLY for medical_director and pharmacist
const BLOCK_FOR_RESTRICTED = [
  "/admin/products",
  "/admin/inventory",
  "/admin/customers",
  "/admin/promotions",
  "/admin/price-lists",
  "/admin/collections",
  "/admin/categories",
]

const TRULY_RESTRICTED_ROLES = ["medical_director", "pharmacist"]

// ── Middleware 1: Block restricted roles from non-order routes ─────────────

async function rbacMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  try {
    if (req.method === "OPTIONS") return next()

    const fullPath = req.originalUrl || req.url || ""
    const isProductsPath = fullPath.startsWith("/admin/products")

    const shouldBlock = BLOCK_FOR_RESTRICTED.some(p => fullPath.startsWith(p))
    if (!shouldBlock) return next()

    const actorId = (req as any).session?.auth_context?.actor_id
    if (!actorId) return next()

    const pg = req.scope.resolve("__pg_connection__") as any

    const userResult = await pg.raw(
      `SELECT email FROM "user" WHERE id = ? LIMIT 1`,
      [actorId]
    )
    if (!userResult.rows.length) return next()

    const email = userResult.rows[0].email

    // Check role
    const staffResult = await pg.raw(
      `SELECT cs.role, c.sales_channel_id
       FROM clinic_staff cs
       JOIN clinic c ON cs.tenant_domain = ANY(c.domains)
       WHERE cs.email = ?
         AND cs.is_active = true
         AND cs.deleted_at IS NULL
       LIMIT 1`,
      [email]
    )

    if (!staffResult.rows.length) {
      // Super admin — not in clinic_staff at all, allow everything
      return next()
    }

    const role = staffResult.rows[0].role
    const salesChannelId = staffResult.rows[0].sales_channel_id

    // Block restricted roles entirely
    if (TRULY_RESTRICTED_ROLES.includes(role)) {
      return res.status(403).json({ message: "Access denied." })
    }

    // Clinic admin on products GET — filter by their sales channel
    if (role === "clinic_admin" && isProductsPath && req.method === "GET") {
      if (salesChannelId) {
        console.log("[ProductFilter] Filtering products for clinic_admin, salesChannelId:", salesChannelId)
        const query = req.query as any
        query["sales_channel_id[]"] = salesChannelId
        req.query = query
      }
    }

    return next()
  } catch {
    return next()
  }
}

export default defineMiddlewares({
  routes: [
    // RBAC — block restricted roles from non-order routes
    {
      matcher: "/admin/products*",
      middlewares: [rbacMiddleware],
    },
    {
      matcher: "/admin/inventory*",
      middlewares: [rbacMiddleware],
    },
    {
      matcher: "/admin/customers*",
      middlewares: [rbacMiddleware],
    },
    {
      matcher: "/admin/promotions*",
      middlewares: [rbacMiddleware],
    },
    {
      matcher: "/admin/price-lists*",
      middlewares: [rbacMiddleware],
    },
    {
      matcher: "/admin/collections*",
      middlewares: [rbacMiddleware],
    },

    // Store routes bypass
    { matcher: "/store/eligibility/check",             method: "GET",           middlewares: [] },
    { matcher: "/store/eligibility/states",            method: "GET",           middlewares: [] },
    { matcher: "/store/eligibility/submit",            method: "POST",          middlewares: [] },
    { matcher: "/store/carts/eligibility-metadata",    method: "POST",          middlewares: [] },
    { matcher: "/store/carts/current-id",              method: "GET",           middlewares: [] },
    { matcher: "/store/orders/lookup",                 method: "GET",           middlewares: [] },
    { matcher: "/store/orders/:gfeId/status",          method: ["GET", "POST"], middlewares: [] },
    { matcher: "/store/orders/:orderId/gfe-status",    method: "GET",           middlewares: [] },
    { matcher: "/store/clinics/stripe-config",         method: "GET",           middlewares: [] },
    { matcher: "/store/clinics/create-payment-intent", method: "POST",          middlewares: [] },
  ],
})