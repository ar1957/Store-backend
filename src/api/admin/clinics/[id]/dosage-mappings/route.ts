import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"

// GET /admin/clinics/:id/dosage-mappings
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any
    const pgConnection = req.scope.resolve("__pg_connection__") as any

    const clinic = await clinicSvc.getClinicById(req.params.id)
    if (!clinic) return res.status(404).json({ message: "Clinic not found" })

    const tenantDomain = clinic.domains?.[0] || clinic.slug

    const result = await pgConnection.raw(`
      SELECT id, tenant_domain, treatment_id, treatment_name, dosage, dosage_key,
             rxvortex_preset_catalog_id, rxvortex_instructions,
             rxvortex_medication_form, rxvortex_quantity_units, rxvortex_quantity, created_at
      FROM treatment_dosage_catalog_map
      WHERE tenant_domain = ? AND deleted_at IS NULL
      ORDER BY treatment_id, created_at
    `, [tenantDomain])

    return res.json({ mappings: result.rows })
  } catch (err: unknown) {
    console.error("Dosage mappings GET error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

// POST /admin/clinics/:id/dosage-mappings
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any
    const pgConnection = req.scope.resolve("__pg_connection__") as any

    const clinic = await clinicSvc.getClinicById(req.params.id)
    if (!clinic) return res.status(404).json({ message: "Clinic not found" })

    const tenantDomain = clinic.domains?.[0] || clinic.slug
    const body = req.body as any

    if (!body.treatment_id || !body.dosage || !body.rxvortex_preset_catalog_id) {
      return res.status(400).json({ message: "treatment_id, dosage, and rxvortex_preset_catalog_id are required" })
    }

    const id = `tdcm_${Date.now()}`

    await pgConnection.raw(`
      INSERT INTO treatment_dosage_catalog_map
        (id, tenant_domain, treatment_id, treatment_name, dosage, dosage_key, rxvortex_preset_catalog_id, rxvortex_instructions, rxvortex_medication_form, rxvortex_quantity_units, rxvortex_quantity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      ON CONFLICT (tenant_domain, treatment_id, dosage)
      DO UPDATE SET
        rxvortex_preset_catalog_id = EXCLUDED.rxvortex_preset_catalog_id,
        rxvortex_instructions = EXCLUDED.rxvortex_instructions,
        treatment_name = EXCLUDED.treatment_name,
        dosage_key = EXCLUDED.dosage_key,
        rxvortex_medication_form = EXCLUDED.rxvortex_medication_form,
        rxvortex_quantity_units = EXCLUDED.rxvortex_quantity_units,
        rxvortex_quantity = EXCLUDED.rxvortex_quantity,
        deleted_at = NULL,
        updated_at = NOW()
    `, [
      id,
      tenantDomain,
      body.treatment_id,
      body.treatment_name || "",
      body.dosage,
      body.dosage_key || null,
      body.rxvortex_preset_catalog_id,
      body.rxvortex_instructions || null,
      body.rxvortex_medication_form || null,
      body.rxvortex_quantity_units || null,
      body.rxvortex_quantity != null ? String(body.rxvortex_quantity) : null,
    ])

    return res.json({ mapping: { id, tenant_domain: tenantDomain, ...body } })
  } catch (err: unknown) {
    console.error("Dosage mappings POST error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
