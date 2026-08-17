/**
 * GET /admin/clinics/:id/orders/:orderId/pharmacy-sub-orders
 * Lists every pharmacy order actually submitted for this Medusa order — one
 * row for a normal (non-split) order, N rows for a split product. Each has
 * its own status/tracking, since the pharmacy ships each split independently.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any

    const wfResult = await pg.raw(
      `SELECT id FROM order_workflow WHERE order_id = ? AND deleted_at IS NULL LIMIT 1`,
      [req.params.orderId]
    )
    if (!wfResult.rows.length) {
      return res.status(404).json({ message: "Order workflow not found" })
    }

    const result = await pg.raw(
      `SELECT pso.id, pso.split_index, pso.split_count, pso.treatment_id, pso.product_id, pso.dosage, pso.dosage_key,
              pso.rxvortex_preset_catalog_id, pso.pharmacy_queue_id, pso.pharmacy_status,
              pso.pharmacy_submitted_at, pso.tracking_number, pso.carrier, pso.shipped_at,
              ptm.product_title
       FROM pharmacy_sub_order pso
       LEFT JOIN LATERAL (
         SELECT product_title FROM product_treatment_map
         WHERE product_id = pso.product_id AND product_title IS NOT NULL AND product_title != ''
         LIMIT 1
       ) ptm ON true
       WHERE pso.order_workflow_id = ?
       ORDER BY pso.split_index`,
      [wfResult.rows[0].id]
    )

    return res.json({ subOrders: result.rows })
  } catch (err: any) {
    return res.status(500).json({ message: err.message })
  }
}
