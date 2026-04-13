import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * GET  /admin/clinics/:id/promotions  — list promotions for a clinic
 * POST /admin/clinics/:id/promotions  — assign a promotion to a clinic
 */

// GET — list promotions assigned to this clinic (joined with Medusa promotions table)
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId } = req.params

    // Join clinic_promotion with Medusa's promotion table
    const result = await pg.raw(`
      SELECT
        cp.id AS assignment_id,
        cp.clinic_id,
        cp.promotion_id,
        cp.created_at AS assigned_at,
        p.code,
        p.type,
        p.status,
        p.is_automatic,
        p.used AS usage_count,
        p.created_at AS promotion_created_at,
        COALESCE(cb.limit, p.limit) AS usage_limit,
        COALESCE(c.starts_at) AS starts_at,
        COALESCE(c.ends_at) AS ends_at
      FROM clinic_promotion cp
      LEFT JOIN promotion p ON p.id = cp.promotion_id
      LEFT JOIN promotion_campaign c ON c.id = p.campaign_id
      LEFT JOIN promotion_campaign_budget cb ON cb.campaign_id = c.id AND cb.type = 'usage'
      WHERE cp.clinic_id = ?
      ORDER BY cp.created_at DESC
    `, [clinicId])

    return res.json({ promotions: result.rows })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

// POST — assign an existing Medusa promotion to this clinic
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId } = req.params
    const { promotion_id } = req.body as any

    if (!promotion_id) {
      return res.status(400).json({ message: "promotion_id is required" })
    }

    // Verify promotion exists
    const promoCheck = await pg.raw(`SELECT id FROM promotion WHERE id = ? AND deleted_at IS NULL LIMIT 1`, [promotion_id])
    if (!promoCheck.rows.length) {
      return res.status(404).json({ message: "Promotion not found" })
    }

    const id = `cprom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    await pg.raw(`
      INSERT INTO clinic_promotion (id, clinic_id, promotion_id)
      VALUES (?, ?, ?)
      ON CONFLICT (clinic_id, promotion_id) DO NOTHING
    `, [id, clinicId, promotion_id])

    return res.json({ success: true })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
