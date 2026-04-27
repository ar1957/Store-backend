import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * DELETE /admin/clinics/:id/promotions/:promotionId — remove from clinic
 * PATCH  /admin/clinics/:id/promotions/:promotionId — update promotion + application method
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

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { promotionId } = req.params
    const {
      status,
      is_automatic,
      discount_value,
      application_method_id,
      ends_at,
      usage_limit,
    } = req.body as any

    // 1. Update promotion status / is_automatic
    const promoUpdates: string[] = []
    const promoValues: any[] = []
    if (status !== undefined) { promoUpdates.push("status = ?"); promoValues.push(status) }
    if (is_automatic !== undefined) { promoUpdates.push("is_automatic = ?"); promoValues.push(is_automatic) }
    promoUpdates.push("updated_at = NOW()")

    if (promoUpdates.length > 1) {
      await pg.raw(
        `UPDATE promotion SET ${promoUpdates.join(", ")} WHERE id = ?`,
        [...promoValues, promotionId]
      )
    }

    // 2. Update application method value (discount amount)
    if (discount_value !== undefined && application_method_id) {
      const numVal = Number(discount_value)
      const rawVal = JSON.stringify({ value: String(numVal), precision: 20 })
      await pg.raw(
        `UPDATE promotion_application_method SET value = ?, raw_value = ?::jsonb, updated_at = NOW() WHERE id = ?`,
        [numVal, rawVal, application_method_id]
      )
    }

    // 3. Update campaign ends_at if provided
    if (ends_at !== undefined) {
      const campaignResult = await pg.raw(
        `SELECT campaign_id FROM promotion WHERE id = ? LIMIT 1`,
        [promotionId]
      )
      const campaignId = campaignResult.rows[0]?.campaign_id
      if (campaignId) {
        await pg.raw(
          `UPDATE promotion_campaign SET ends_at = ?, updated_at = NOW() WHERE id = ?`,
          [ends_at ? new Date(ends_at).toISOString() : null, campaignId]
        )
        // Update budget usage limit
        if (usage_limit !== undefined) {
          await pg.raw(
            `UPDATE promotion_campaign_budget SET "limit" = ?, updated_at = NOW() WHERE campaign_id = ? AND type = 'usage'`,
            [usage_limit ? Number(usage_limit) : null, campaignId]
          )
        }
      }
    }

    return res.json({ success: true })
  } catch (err: unknown) {
    console.error("[PATCH promotion] error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
