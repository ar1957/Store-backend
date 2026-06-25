import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

// DELETE /admin/clinics/:id/product-mappings/:mappingId
export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pgConnection = req.scope.resolve("__pg_connection__") as any

    await pgConnection.raw(`
      DELETE FROM product_treatment_map WHERE id = ?
    `, [req.params.mappingId])

    return res.json({ success: true })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

// PATCH /admin/clinics/:id/product-mappings/:mappingId
// Updates editable fields on an existing mapping (e.g. rxvortex_preset_catalog_id)
export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pgConnection = req.scope.resolve("__pg_connection__") as any
    const body = req.body as any

    const fields: Record<string, any> = { updated_at: new Date() }
    if ("rxvortex_preset_catalog_id" in body) fields.rxvortex_preset_catalog_id = body.rxvortex_preset_catalog_id || null
    if ("rxvortex_instructions" in body) fields.rxvortex_instructions = body.rxvortex_instructions || null

    const setClauses = Object.keys(fields).filter(k => k !== "updated_at").map(k => `${k} = ?`).join(", ")
    const values = [...Object.keys(fields).filter(k => k !== "updated_at").map(k => fields[k]), req.params.mappingId]

    await pgConnection.raw(
      `UPDATE product_treatment_map SET ${setClauses}, updated_at = NOW() WHERE id = ?`,
      values
    )

    return res.json({ success: true })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
