/**
 * GET /admin/clinics/:id/orders/:orderId/pharmacy-submission
 * Returns the payload sent to the pharmacy API and the raw response
 * received, for research/debugging. Not included in the bulk orders list
 * response since these JSONB blobs would bloat every list-page load.
 *
 * A split order submits as multiple independent pharmacy orders — each
 * split's payload/response lives on its own pharmacy_sub_order row, not on
 * order_workflow (which only ever holds the bundled/non-split submission).
 * subOrderSubmissions is the source of truth whenever it's non-empty; the
 * top-level pharmacy_submission_payload/response fields are a legacy
 * fallback for orders submitted before pharmacy_sub_order existed.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any

    const result = await pg.raw(
      `SELECT id, pharmacy_submission_payload, pharmacy_submission_response,
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

    const workflow = result.rows[0]

    const subResult = await pg.raw(
      `SELECT split_index, split_count, dosage, pharmacy_queue_id,
              pharmacy_submission_payload, pharmacy_submission_response,
              pharmacy_status_check_response, pharmacy_status_check_source, pharmacy_status_checked_at
       FROM pharmacy_sub_order
       WHERE order_workflow_id = ?
         AND (pharmacy_submission_payload IS NOT NULL OR pharmacy_status_check_response IS NOT NULL)
       ORDER BY split_index`,
      [workflow.id]
    )

    return res.json({
      ...workflow,
      subOrderSubmissions: subResult.rows,
    })
  } catch (err: any) {
    return res.status(500).json({ message: err.message })
  }
}
