/**
 * GET /store/clinics/tenant-config
 * Returns full tenant config for the current domain — used by storefront middleware.
 * Uses raw pg queries (not MikroORM) + in-memory cache to avoid connection pool pressure.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Pool } from "pg"

// Dedicated raw pg pool — completely separate from Medusa's Knex/MikroORM pool.
// This prevents the every-13-second Next.js middleware poll from competing with
// Medusa's internal connection pool.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  min: 1,
  max: 5,
})

interface TenantConfigEntry {
  data: object
  ts: number
}

const cache = new Map<string, TenantConfigEntry>()
const CACHE_TTL = 60_000 // 60 seconds

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const host = (
      req.headers["x-forwarded-host"] ||
      req.headers["x-tenant-domain"] ||
      req.headers["host"] ||
      ""
    ) as string

    const domain = host.split(":")[0]
    const cacheKey = domain || host

    const cached = cache.get(cacheKey)
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return res.json(cached.data)
    }

    const clinicResult = await pool.query(
      `SELECT id, name, logo_url, brand_color, contact_email,
              publishable_api_key, stripe_publishable_key,
              payment_provider, paypal_client_id, paypal_mode
       FROM clinic
       WHERE ($1 = ANY(domains) OR $2 = ANY(domains))
         AND deleted_at IS NULL
       LIMIT 1`,
      [host, domain]
    )

    const clinic = clinicResult.rows[0]

    if (!clinic) {
      const empty = { tenant: null }
      cache.set(cacheKey, { data: empty, ts: Date.now() })
      return res.json(empty)
    }

    const uiResult = await pool.query(
      `SELECT nav_links, footer_links, logo_url, get_started_url
       FROM clinic_ui_config WHERE clinic_id = $1 LIMIT 1`,
      [clinic.id]
    )
    const uiConfig = uiResult.rows[0] || {}

    const response = {
      tenant: {
        name:            clinic.name,
        logo:            uiConfig.logo_url || clinic.logo_url || "",
        apiKey:          clinic.publishable_api_key || "",
        domain:          host,
        colors: {
          primary:       clinic.brand_color || "#111111",
          background:    "#ffffff",
          backgroundAlt: "#f9fafb",
          accent:        clinic.brand_color || "#111111",
          text:          "#111111",
        },
        nav:             (uiConfig.nav_links || []).map((l: any) => l.label),
        ctaText:         "Get Started",
        phone:           "",
        hours:           "",
        email:           clinic.contact_email || "",
        nav_links:       uiConfig.nav_links || [],
        footer_links:    uiConfig.footer_links || [],
        get_started_url: uiConfig.get_started_url || "/store",
        stripe_publishable_key: clinic.stripe_publishable_key || "",
        payment_provider: clinic.payment_provider || "stripe",
        paypal_client_id: clinic.paypal_client_id || "",
        paypal_mode: clinic.paypal_mode || "sandbox",
      }
    }

    cache.set(cacheKey, { data: response, ts: Date.now() })
    return res.json(response)
  } catch (err: unknown) {
    console.error("[Tenant Config] Error:", err)
    return res.status(500).json({ tenant: null })
  }
}
