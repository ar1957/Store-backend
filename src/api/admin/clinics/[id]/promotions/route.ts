import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId } = req.params

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
        p.created_at AS promotion_created_at,
        am.id AS application_method_id,
        am.value AS discount_value,
        am.type AS discount_type,
        pc.starts_at,
        pc.ends_at,
        pcb.limit AS usage_limit,
        pcb.used AS usage_count
      FROM clinic_promotion cp
      LEFT JOIN promotion p ON p.id = cp.promotion_id AND p.deleted_at IS NULL
      LEFT JOIN promotion_application_method am ON am.promotion_id = p.id AND am.deleted_at IS NULL
      LEFT JOIN promotion_campaign pc ON pc.id = p.campaign_id AND pc.deleted_at IS NULL
      LEFT JOIN promotion_campaign_budget pcb ON pcb.campaign_id = pc.id AND pcb.deleted_at IS NULL
      WHERE cp.clinic_id = ?
      ORDER BY cp.created_at DESC
    `, [clinicId])

    return res.json({ promotions: result.rows })
  } catch (err: unknown) {
    console.error("[GET clinic promotions] error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId } = req.params
    const { promotion_id } = req.body as any

    if (!promotion_id) {
      return res.status(400).json({ message: "promotion_id is required" })
    }

    const promoCheck = await pg.raw(
      `SELECT id FROM promotion WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [promotion_id]
    )
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
    console.error("[POST clinic promotions] error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
