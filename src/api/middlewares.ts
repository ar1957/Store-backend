import { 
  defineMiddlewares, 
  MedusaNextFunction, 
  MedusaRequest, 
  MedusaResponse,
} from "@medusajs/framework/http"
import { maybeApplyLinkFilter } from "@medusajs/framework"
import { Pool } from "pg"

// ── Dynamic CORS ───────────────────────────────────────────────────────────
// Runs at request-time so new clinics are picked up within 60s, no restart.
// storeCors in medusa-config.ts is set to STORE_CORS env var only — this
// middleware handles the per-clinic domain allowlist dynamically.

const pgPool = new Pool({ connectionString: process.env.DATABASE_URL })

let corsCache: { origins: Set<string>; ts: number } = { origins: new Set(), ts: 0 }
const CORS_TTL = 60_000

async function getAllowedOrigins(): Promise<Set<string>> {
  if (Date.now() - corsCache.ts < CORS_TTL) return corsCache.origins
  try {
    // Safe during first deploy — table may not exist yet
    const tableCheck = await pgPool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='clinic'`
    )
    if (!tableCheck.rows.length) return corsCache.origins

    const result = await pgPool.query(
      `SELECT domains FROM clinic WHERE deleted_at IS NULL AND is_active = true`
    )
    const origins = new Set<string>()
    for (const row of result.rows) {
      for (const d of (row.domains || []) as string[]) {
        const clean = d.trim()
        if (!clean) continue
        if (clean.startsWith("http")) origins.add(clean)
        else if (clean.includes("localhost") || clean.includes(".local")) origins.add(`http://${clean}`)
        else {
          origins.add(`https://${clean}`)
          const noPort = clean.split(":")[0]
          if (noPort !== clean) origins.add(`https://${noPort}`)
        }
      }
    }
    corsCache = { origins, ts: Date.now() }
    return origins
  } catch {
    return corsCache.origins
  }
}

export function invalidateCorsCache() { corsCache = { origins: new Set(), ts: 0 } }

async function dynamicCorsMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const origin = req.headers["origin"] as string | undefined
  if (!origin) return next()

  const allowed = await getAllowedOrigins()
  if (allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
    res.setHeader("Access-Control-Allow-Credentials", "true")
    res.setHeader("Vary", "Origin")
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,PATCH,OPTIONS")
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-publishable-api-key,x-medusa-access-token")
      return res.status(204).end()
    }
  }
  return next()
}


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
// Promotions have no sales channel scope in Medusa v2 — block clinic_admin too
const BLOCK_PROMOTIONS_ROLES = ["medical_director", "pharmacist", "clinic_admin"]

// ── Middleware 1: Resolve role + sales_channel_id and store on request ─────

async function resolveClinicRole(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  try {
    if (req.method === "OPTIONS") return next()

    const actorId = (req as any).session?.auth_context?.actor_id
    if (!actorId) return next()

    const pg = req.scope.resolve("__pg_connection__") as any

    const userResult = await pg.raw(
      `SELECT email FROM "user" WHERE id = ? LIMIT 1`,
      [actorId]
    )
    if (!userResult.rows.length) return next()
    const email = userResult.rows[0].email

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
      // Super admin — register as such
      ;(req as any).clinicRole = "super_admin"
      return next()
    }

    const { role, sales_channel_id } = staffResult.rows[0]
    ;(req as any).clinicRole = role
    ;(req as any).clinicSalesChannelId = sales_channel_id

    return next()
  } catch {
    return next()
  }
}

// ── Middleware 2: Block restricted roles ───────────────────────────────────

async function rbacMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  try {
    if (req.method === "OPTIONS") return next()

    const fullPath = req.originalUrl || req.url || ""
    const shouldBlock = BLOCK_FOR_RESTRICTED.some(p => fullPath.startsWith(p))
    if (!shouldBlock) return next()

    const role = (req as any).clinicRole
    if (!role) return next()

    // Promotions are blocked for clinic_admin too — no sales channel scope in Medusa v2
    const isPromotions = fullPath.startsWith("/admin/promotions")
    if (isPromotions && BLOCK_PROMOTIONS_ROLES.includes(role)) {
      return res.status(403).json({ message: "Access denied." })
    }

    // All other blocked routes — only block restricted roles
    if (!isPromotions && TRULY_RESTRICTED_ROLES.includes(role)) {
      return res.status(403).json({ message: "Access denied." })
    }

    return next()
  } catch {
    return next()
  }
}

// ── Middleware 3: Filter products by sales channel for clinic_admin ────────

async function clinicCustomerFilter(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  try {
    const role = (req as any).clinicRole
    const salesChannelId = (req as any).clinicSalesChannelId

    if (role !== "clinic_admin" || !salesChannelId) return next()

    // Get customer IDs who have orders through this clinic's sales channel
    const pg = req.scope.resolve("__pg_connection__") as any
    const result = await pg.raw(
      `SELECT DISTINCT customer_id
       FROM "order"
       WHERE sales_channel_id = ?
         AND customer_id IS NOT NULL
         AND deleted_at IS NULL`,
      [salesChannelId]
    )

    const customerIds = (result.rows || []).map((r: any) => r.customer_id)

    if (customerIds.length === 0) {
      // No customers yet — return empty by using impossible filter
      customerIds.push("no_customers_yet")
    }

    // Inject id filter so only clinic's customers are returned
    if (!req.filterableFields) req.filterableFields = {}
    req.filterableFields["id"] = customerIds

    return next()
  } catch {
    return next()
  }
}

// ── Middleware 4: Filter products by sales channel for clinic_admin ────────

async function clinicProductFilter(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  try {
    const role = (req as any).clinicRole
    const salesChannelId = (req as any).clinicSalesChannelId

    if (role === "clinic_admin" && salesChannelId) {
      if (!req.filterableFields) {
        req.filterableFields = {}
      }
      req.filterableFields["sales_channel_id"] = salesChannelId
    }

    return next()
  } catch {
    return next()
  }
}

export default defineMiddlewares({
  routes: [
    // ── DYNAMIC CORS — runs on all store routes ──────────────────────
    {
      matcher: "/store/*",
      middlewares: [dynamicCorsMiddleware],
    },

    // ── PUBLIC BOOTSTRAP ROUTES ──────────────────────────────────────
    { 
      matcher: "/store/clinics/tenant-config", 
      method: "GET", 
      middlewares: [] 
    },
    { 
      matcher: "/store/clinics/ui-config", 
      method: "GET", 
      middlewares: [] 
    },

    // ── ADMIN ROLE RESOLUTION ────────────────────────────────────────
    {
      matcher: "/admin/*",
      method: ["GET"],
      middlewares: [resolveClinicRole],
    },

    // ── RBAC & FILTERS ───────────────────────────────────────────────
    { matcher: "/admin/products*",    middlewares: [rbacMiddleware] },
    { matcher: "/admin/inventory*",   middlewares: [rbacMiddleware] },
    { matcher: "/admin/customers*",   middlewares: [rbacMiddleware] },
    { matcher: "/admin/promotions*",  middlewares: [rbacMiddleware] },
    { matcher: "/admin/price-lists*", middlewares: [rbacMiddleware] },
    { matcher: "/admin/collections*", middlewares: [rbacMiddleware] },

    {
      matcher: "/admin/products",
      method: ["GET"],
      middlewares: [
        clinicProductFilter,
        maybeApplyLinkFilter({
          entryPoint: "product_sales_channel",
          resourceId: "product_id",
          filterableField: "sales_channel_id",
        }),
      ],
    },
    {
      matcher: "/admin/customers*",
      method: ["GET"],
      middlewares: [clinicCustomerFilter],
    },

    // ── OTHER STORE BYPASSES ────────────────────────────────────────
    { matcher: "/store/eligibility/*",                 method: ["GET", "POST"], middlewares: [] },
    { matcher: "/store/carts/eligibility-metadata",    method: "POST",          middlewares: [] },
    { matcher: "/store/carts/current-id",              method: "GET",           middlewares: [] },
    { matcher: "/store/orders/lookup",                 method: "GET",           middlewares: [] },
    { matcher: "/store/orders/:gfeId/status",          method: ["GET", "POST"], middlewares: [] },
    { matcher: "/store/orders/:orderId/gfe-status",    method: "GET",           middlewares: [] },
    { matcher: "/store/clinics/stripe-config",         method: "GET",           middlewares: [] },
    { matcher: "/store/clinics/create-payment-intent",   method: "POST",          middlewares: [] },
    { matcher: "/store/clinics/mark-payment-authorized", method: "POST",          middlewares: [] },
  ],
})