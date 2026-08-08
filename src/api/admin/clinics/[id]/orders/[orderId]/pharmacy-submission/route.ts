/**
 * GET /admin/clinics/:id/orders/:orderId/pharmacy-submission
 * Returns the payload sent to the pharmacy API and the raw response
 * received, for research/debugging. Not included in the bulk orders list
 * response since these JSONB blobs would bloat every list-page load.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any

    const result = await pg.raw(
      `SELECT pharmacy_submission_payload, pharmacy_submission_response,
              pharmacy_submitted_at, pharmacy_queue_id, pharmacy_status,
              pharmacy_status_check_response, pharmacy_status_check_source, pharmacy_status_checked_at
       FROM order_workflow
       WHERE order_id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [req.params.orderId]
    )

    if (!result.rows.length) {
      return res.status(404).json({ message: "Order workflow not found" })
    }

    return res.json(result.rows[0])
  } catch (err: any) {
    return res.status(500).json({ message: err.message })
  }
}
