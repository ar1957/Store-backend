/**
 * GET/POST /admin/clinics/:id/ui-config
 * File: src/api/admin/clinics/[id]/ui-config/route.ts
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any
    const pg = req.scope.resolve("__pg_connection__") as any
    const clinicId = req.params.id

    const clinic = await clinicSvc.getClinicById(clinicId)
    if (!clinic) return res.status(404).json({ message: "Clinic not found" })

    const tenantDomain = clinic.domains?.[0] || clinic.slug

    // Try by clinic_id first, fallback to tenant_domain for old records
    const result = await pg.raw(
      `SELECT * FROM clinic_ui_config 
       WHERE clinic_id = ? OR tenant_domain = ?
       ORDER BY clinic_id NULLS LAST
       LIMIT 1`,
      [clinicId, tenantDomain]
    )

    return res.json({ config: result.rows[0] || null })
  } catch (err: unknown) {
    console.error("[UI Config GET] Error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any
    const pg = req.scope.resolve("__pg_connection__") as any
    const clinicId = req.params.id

    const clinic = await clinicSvc.getClinicById(clinicId)
    if (!clinic) return res.status(404).json({ message: "Clinic not found" })

    const tenantDomain = clinic.domains?.[0] || clinic.slug
    const body = req.body as any

    const navLinks = JSON.stringify(body.nav_links || [])
    const footerLinks = JSON.stringify(body.footer_links || [])
    const logoUrl = body.logo_url || null
    const getStartedUrl = body.get_started_url || null

    // Check by clinic_id OR tenant_domain to catch old records
    const existing = await pg.raw(
      `SELECT id FROM clinic_ui_config 
       WHERE clinic_id = ? OR tenant_domain = ?
       LIMIT 1`,
      [clinicId, tenantDomain]
    )

    let result
    if (existing.rows.length > 0) {
      // Update and set clinic_id to fix old records
      result = await pg.raw(
        `UPDATE clinic_ui_config
         SET clinic_id = ?,
             nav_links = ?::jsonb,
             footer_links = ?::jsonb,
             logo_url = ?,
             get_started_url = ?,
             tenant_domain = ?,
             updated_at = NOW()
         WHERE id = ?
         RETURNING *`,
        [clinicId, navLinks, footerLinks, logoUrl, getStartedUrl, tenantDomain, existing.rows[0].id]
      )
    } else {
      const id = `cuicfg_${Date.now()}`
      result = await pg.raw(
        `INSERT INTO clinic_ui_config
           (id, clinic_id, tenant_domain, nav_links, footer_links, logo_url, get_started_url, created_at, updated_at)
         VALUES (?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, NOW(), NOW())
         RETURNING *`,
        [id, clinicId, tenantDomain, navLinks, footerLinks, logoUrl, getStartedUrl]
      )
    }

    return res.json({ config: result.rows[0] })
  } catch (err: unknown) {
    console.error("[UI Config POST] Error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}