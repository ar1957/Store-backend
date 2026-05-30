import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * GET /admin/clinics/:id/orders/:orderId/pharmacy-cost
 * Returns the default pharmacy cost for an order based on product_payout_cost,
 * and the current override if one has been set.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId, orderId } = req.params

    // Get the current override (if any) and the default calculated cost
    const [overrideRes, defaultCostRes] = await Promise.all([
      pg.raw(
        `SELECT pharmacy_cost_override FROM order_workflow WHERE order_id = ? LIMIT 1`,
        [orderId]
      ),
      pg.raw(`
        SELECT COALESCE(SUM(cost_calc.line_cost), 0) AS pharmacy_cost
        FROM (
          SELECT DISTINCT ON (oli.id)
            ppc.pharmacy_cost * oi.quantity AS line_cost
          FROM order_item oi
          JOIN order_line_item oli ON oli.id = oi.item_id
          JOIN product_payout_cost ppc
            ON ppc.clinic_id = ? AND ppc.product_id = oli.product_id
          WHERE oi.order_id = ?
          ORDER BY oli.id, oi.created_at DESC
        ) cost_calc
      `, [clinicId, orderId]),
    ])

    const defaultCost = Number(defaultCostRes.rows[0]?.pharmacy_cost || 0)
    const override = overrideRes.rows[0]?.pharmacy_cost_override

    return res.json({
      pharmacy_cost: override != null ? Number(override) : defaultCost,
      default_cost: defaultCost,
      is_overridden: override != null,
    })
  } catch (err: any) {
    console.error("[pharmacy-cost GET]", err)
    return res.status(500).json({ message: err.message })
  }
}
