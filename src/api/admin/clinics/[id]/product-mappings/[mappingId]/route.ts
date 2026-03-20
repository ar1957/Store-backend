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