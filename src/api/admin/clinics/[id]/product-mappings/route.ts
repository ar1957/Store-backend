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

    // product_title is captured once at mapping-creation time and never
    // updated again — renaming the product in the core Products admin left
    // every existing mapping permanently showing the old name. Prefer the
    // live product title via a join, falling back to the stored snapshot
    // only if the product itself was since deleted.
    const result = await pgConnection.raw(`
      SELECT ptm.id, ptm.tenant_domain, ptm.product_id,
             COALESCE(p.title, ptm.product_title) AS product_title,
             ptm.variant_id,
             ptm.treatment_id, ptm.treatment_name, ptm.requires_eligibility,
             ptm.rxvortex_preset_catalog_id, ptm.rxvortex_instructions, ptm.order_split_count,
             ptm.rxvortex_medication_form, ptm.rxvortex_quantity_units, ptm.rxvortex_quantity,
             ptm.rxvortex_catalog_instruction, ptm.rxvortex_quantity_override,
             ptm.clinic_pharmacy_id, ptm.created_at
      FROM product_treatment_map ptm
      LEFT JOIN product p ON p.id = ptm.product_id AND p.deleted_at IS NULL
      WHERE ptm.tenant_domain = ?
      ORDER BY ptm.created_at DESC
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
        (id, tenant_domain, product_id, product_title, treatment_id, treatment_name, requires_eligibility, rxvortex_preset_catalog_id, rxvortex_instructions, order_split_count, clinic_pharmacy_id, rxvortex_medication_form, rxvortex_quantity_units, rxvortex_quantity, rxvortex_catalog_instruction, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `, [
      id,
      tenantDomain,
      body.product_id,
      body.product_title || "",
      body.treatment_id,
      body.treatment_name || "",
      body.requires_eligibility ?? true,
      body.rxvortex_preset_catalog_id || null,
      body.rxvortex_instructions || null,
      Number(body.order_split_count) || 0,
      body.clinic_pharmacy_id || null,
      body.rxvortex_medication_form || null,
      body.rxvortex_quantity_units || null,
      body.rxvortex_quantity != null ? String(body.rxvortex_quantity) : null,
      body.rxvortex_catalog_instruction || null,
    ])

    return res.json({ mapping: { id, tenant_domain: tenantDomain, ...body } })
  } catch (err: unknown) {
    console.error("Mappings POST error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}