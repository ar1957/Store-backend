/**
 * GET /store/clinics/ui-config
 * File: src/api/store/clinics/ui-config/route.ts
 * Public endpoint — no publishable key required
 * Returns nav/footer config for the current clinic based on request domain
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any
    const pg = req.scope.resolve("__pg_connection__") as any

    // Get domain from host header — try multiple header variations
    const host = (
      req.headers["x-forwarded-host"] ||
      req.headers["x-tenant-domain"] ||
      req.headers["host"] ||
      ""
    ) as string

    const domain = host.split(":")[0] // strip port for matching

    console.log("[Store UI Config] host:", host, "domain:", domain)

    // Find clinic by domain (tries full host with port, then without port)
    let clinic = await clinicSvc.getClinicByDomain(host)
    if (!clinic) clinic = await clinicSvc.getClinicByDomain(domain)
    if (!clinic) {
      console.log("[Store UI Config] No clinic found for domain:", host)
      return res.json({ config: null })
    }

    console.log("[Store UI Config] Found clinic:", clinic.name, clinic.id)

    const result = await pg.raw(
      `SELECT nav_links, footer_links, bottom_links, logo_url, get_started_url,
              contact_phone, contact_email, contact_address, social_links, certification_image_url
       FROM clinic_ui_config
       WHERE clinic_id = ?
       LIMIT 1`,
      [clinic.id]
    )

    return res.json({ config: result.rows[0] || null })
  } catch (err: unknown) {
    console.error("[Store UI Config] Error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}