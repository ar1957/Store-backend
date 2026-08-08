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
      `SELECT id, split_index, split_count, treatment_id, product_id, dosage, dosage_key,
              rxvortex_preset_catalog_id, pharmacy_queue_id, pharmacy_status,
              pharmacy_submitted_at, tracking_number, carrier, shipped_at
       FROM pharmacy_sub_order
       WHERE order_workflow_id = ?
       ORDER BY split_index`,
      [wfResult.rows[0].id]
    )

    return res.json({ subOrders: result.rows })
  } catch (err: any) {
    return res.status(500).json({ message: err.message })
  }
}
