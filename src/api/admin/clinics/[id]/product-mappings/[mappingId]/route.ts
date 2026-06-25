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

    await pgConnection.raw(`
      UPDATE product_treatment_map
      SET rxvortex_preset_catalog_id = ?,
          updated_at = NOW()
      WHERE id = ?
    `, [
      body.rxvortex_preset_catalog_id || null,
      req.params.mappingId,
    ])

    return res.json({ success: true })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
