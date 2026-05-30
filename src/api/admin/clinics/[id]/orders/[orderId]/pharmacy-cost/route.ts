import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * GET /admin/clinics/:id/orders/:orderId/pharmacy-cost
 * Returns per-line-item pharmacy costs for an order.
 * Shows default costs from product_payout_cost and any overrides from order_item_pharmacy_cost.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId, orderId } = req.params

    // Get order line items with their default costs and any existing overrides
    const itemsRes = await pg.raw(`
      SELECT DISTINCT ON (oli.id)
        oli.id AS line_item_id,
        oli.product_id,
        oli.title AS product_title,
        oi.quantity,
        COALESCE(ppc.pharmacy_cost, 0) AS default_cost,
        oipc.actual_cost AS override_cost,
        oipc.id AS override_id
      FROM order_item oi
      JOIN order_line_item oli ON oli.id = oi.item_id
      LEFT JOIN product_payout_cost ppc
        ON ppc.clinic_id = ? AND ppc.product_id = oli.product_id
      LEFT JOIN order_item_pharmacy_cost oipc
        ON oipc.order_id = ? AND oipc.line_item_id = oli.id
      WHERE oi.order_id = ?
      ORDER BY oli.id, oi.created_at DESC
    `, [clinicId, orderId, orderId])

    const items = itemsRes.rows.map((row: any) => ({
      line_item_id: row.line_item_id,
      product_id: row.product_id,
      product_title: row.product_title,
      quantity: Number(row.quantity),
      default_cost: Number(row.default_cost),
      actual_cost: row.override_cost != null ? Number(row.override_cost) : Number(row.default_cost),
      is_overridden: row.override_cost != null,
    }))

    const total_cost = items.reduce((sum: number, item: any) => sum + item.actual_cost * item.quantity, 0)

    return res.json({ items, total_cost: Number(total_cost.toFixed(2)) })
  } catch (err: any) {
    console.error("[pharmacy-cost GET]", err)
    return res.status(500).json({ message: err.message })
  }
}
