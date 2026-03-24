import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

// DELETE /admin/clinics/:id/staff/:staffId
export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    await pg.raw(
      `UPDATE clinic_staff SET is_active = false, deleted_at = NOW(), updated_at = NOW() WHERE id = ?`,
      [req.params.staffId]
    )
    return res.json({ success: true })
  } catch (err: unknown) {
    console.error("Staff DELETE error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
