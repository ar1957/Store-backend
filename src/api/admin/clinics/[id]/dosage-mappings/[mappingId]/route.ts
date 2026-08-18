import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

// DELETE /admin/clinics/:id/dosage-mappings/:mappingId
export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pgConnection = req.scope.resolve("__pg_connection__") as any

    await pgConnection.raw(`
      UPDATE treatment_dosage_catalog_map SET deleted_at = NOW(), updated_at = NOW() WHERE id = ?
    `, [req.params.mappingId])

    return res.json({ success: true })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

// PATCH /admin/clinics/:id/dosage-mappings/:mappingId
export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pgConnection = req.scope.resolve("__pg_connection__") as any
    const body = req.body as any

    const fields: Record<string, any> = {}
    if ("rxvortex_preset_catalog_id" in body) fields.rxvortex_preset_catalog_id = body.rxvortex_preset_catalog_id || null
    if ("rxvortex_instructions" in body) fields.rxvortex_instructions = body.rxvortex_instructions || null
    if ("rxvortex_medication_form" in body) fields.rxvortex_medication_form = body.rxvortex_medication_form || null
    if ("rxvortex_quantity_units" in body) fields.rxvortex_quantity_units = body.rxvortex_quantity_units || null
    if ("rxvortex_quantity" in body) fields.rxvortex_quantity = body.rxvortex_quantity != null ? String(body.rxvortex_quantity) : null

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ message: "No editable fields provided" })
    }

    const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(", ")
    const values = [...Object.values(fields), req.params.mappingId]

    await pgConnection.raw(
      `UPDATE treatment_dosage_catalog_map SET ${setClauses}, updated_at = NOW() WHERE id = ?`,
      values
    )

    return res.json({ success: true })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
