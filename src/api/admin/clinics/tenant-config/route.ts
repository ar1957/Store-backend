/**
 * GET /store/clinics/tenant-config
 * File: src/api/store/clinics/tenant-config/route.ts
 * 
 * NOTE: This route is registered as a bypass in middlewares.ts
 * with empty middlewares: [] to skip auth entirely.
 * However Medusa's core store middleware still runs before custom middlewares.
 * 
 * To truly bypass auth, we accept ANY publishable key or none at all
 * by overriding the behavior here.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any
    const pg = req.scope.resolve("__pg_connection__") as any

    const host = (
      req.headers["x-forwarded-host"] ||
      req.headers["host"] ||
      ""
    ) as string

    const domain = host.split(":")[0]

    let clinic = await clinicSvc.getClinicByDomain(host)
    if (!clinic) clinic = await clinicSvc.getClinicByDomain(domain)

    if (!clinic) {
      return res.json({ tenant: null })
    }

    const uiResult = await pg.raw(
      `SELECT nav_links, footer_links, logo_url, get_started_url
       FROM clinic_ui_config WHERE clinic_id = ? LIMIT 1`,
      [clinic.id]
    )
    const uiConfig = uiResult.rows[0] || {}

    return res.json({
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
      }
    })
  } catch (err: unknown) {
    console.error("[Tenant Config] Error:", err)
    return res.status(500).json({ tenant: null })
  }
}