import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * GET /admin/clinics/:id/product-costs
 * Returns all configured pharmacy costs for this clinic's products.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id } = req.params

    const result = await pg.raw(
      `SELECT id, product_id, product_title, pharmacy_cost, updated_at
       FROM product_payout_cost
       WHERE clinic_id = ?
       ORDER BY product_title ASC`,
      [id]
    )
    return res.json({ costs: result.rows })
  } catch (err: unknown) {
    console.error("[product-costs GET]", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

/**
 * POST /admin/clinics/:id/product-costs
 * Bulk upsert pharmacy costs for multiple products.
 * Body: { costs: [{ product_id, product_title, pharmacy_cost }] }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id } = req.params
    const { costs } = req.body as any

    if (!Array.isArray(costs) || costs.length === 0) {
      return res.status(400).json({ message: "costs array is required" })
    }

    for (const item of costs) {
      const cost = Number(item.pharmacy_cost)
      if (isNaN(cost) || cost < 0) {
        return res.status(400).json({ message: `Invalid pharmacy_cost for product ${item.product_id}` })
      }
      const rowId = `ppc_${id}_${item.product_id}`
      await pg.raw(`
        INSERT INTO product_payout_cost (id, clinic_id, product_id, product_title, pharmacy_cost, updated_at)
        VALUES (?, ?, ?, ?, ?, NOW())
        ON CONFLICT (clinic_id, product_id) DO UPDATE SET
          pharmacy_cost = EXCLUDED.pharmacy_cost,
          product_title = EXCLUDED.product_title,
          updated_at    = NOW()
      `, [rowId, id, item.product_id, item.product_title || "", cost])
    }

    const saved = await pg.raw(
      `SELECT id, product_id, product_title, pharmacy_cost FROM product_payout_cost
       WHERE clinic_id = ? ORDER BY product_title ASC`,
      [id]
    )
    return res.json({ costs: saved.rows })
  } catch (err: unknown) {
    console.error("[product-costs POST]", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
