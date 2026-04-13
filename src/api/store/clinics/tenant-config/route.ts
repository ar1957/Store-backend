/**
 * GET /store/clinics/tenant-config
 * File: src/api/store/clinics/tenant-config/route.ts
 * Returns full tenant config for the current domain — used by storefront middleware
 * Public endpoint — no publishable key required
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any
    const pg = req.scope.resolve("__pg_connection__") as any

    const host = (
      req.headers["x-forwarded-host"] ||
      req.headers["x-tenant-domain"] ||
      req.headers["host"] ||
      ""
    ) as string

    const domain = host.split(":")[0]

    // Find clinic by full host or domain without port
    let clinic = await clinicSvc.getClinicByDomain(host)
    if (!clinic) clinic = await clinicSvc.getClinicByDomain(domain)

    if (!clinic) {
      return res.json({ tenant: null })
    }

    // Get UI config for nav/footer links and logo
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
        ctaText:         uiConfig.get_started_url ? "Get Started" : "Get Started",
        phone:           "",
        hours:           "",
        email:           clinic.contact_email || "",
        // Extra fields for storefront use
        nav_links:       uiConfig.nav_links || [],
        footer_links:    uiConfig.footer_links || [],
        get_started_url: uiConfig.get_started_url || "/store",
        // Stripe key for client-side payment initialization
        stripe_publishable_key: clinic.stripe_publishable_key || "",
        // PayPal
        payment_provider: clinic.payment_provider || "stripe",
        paypal_client_id: clinic.paypal_client_id || "",
        paypal_mode: clinic.paypal_mode || "sandbox",
      }
    })
  } catch (err: unknown) {
    console.error("[Tenant Config] Error:", err)
    return res.status(500).json({ tenant: null })
  }
}