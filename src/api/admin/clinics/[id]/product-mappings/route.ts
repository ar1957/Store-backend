import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"

// GET /admin/clinics/:id/product-mappings
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any
    const pgConnection = req.scope.resolve("__pg_connection__") as any

    const clinic = await clinicSvc.getClinicById(req.params.id)
    if (!clinic) return res.status(404).json({ message: "Clinic not found" })

    const tenantDomain = clinic.domains?.[0] || clinic.slug

    const result = await pgConnection.raw(`
      SELECT id, tenant_domain, product_id, product_title, variant_id,
             treatment_id, treatment_name, requires_eligibility, created_at
      FROM product_treatment_map
      WHERE tenant_domain = ?
      ORDER BY created_at DESC
    `, [tenantDomain])

    return res.json({ mappings: result.rows })
  } catch (err: unknown) {
    console.error("Mappings GET error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

// POST /admin/clinics/:id/product-mappings
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any
    const pgConnection = req.scope.resolve("__pg_connection__") as any

    const clinic = await clinicSvc.getClinicById(req.params.id)
    if (!clinic) return res.status(404).json({ message: "Clinic not found" })

    const tenantDomain = clinic.domains?.[0] || clinic.slug
    const body = req.body as any
    const id = `ptm_${Date.now()}`

    await pgConnection.raw(`
      INSERT INTO product_treatment_map
        (id, tenant_domain, product_id, product_title, treatment_id, treatment_name, requires_eligibility, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `, [
      id,
      tenantDomain,
      body.product_id,
      body.product_title || "",
      body.treatment_id,
      body.treatment_name || "",
      body.requires_eligibility ?? true,
    ])

    return res.json({ mapping: { id, tenant_domain: tenantDomain, ...body } })
  } catch (err: unknown) {
    console.error("Mappings POST error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}