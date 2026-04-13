import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * DELETE /admin/clinics/:id/promotions/:promotionId — remove promotion from clinic
 */
export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId, promotionId } = req.params

    await pg.raw(
      `DELETE FROM clinic_promotion WHERE clinic_id = ? AND promotion_id = ?`,
      [clinicId, promotionId]
    )

    return res.json({ success: true })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
