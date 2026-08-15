/**
 * POST /admin/clinics/:id/orders/:orderId/pharmacy-submit
 * Manually submits an order to the clinic's configured pharmacy API.
 *
 * Delegates to submitToPharmacyIfEnabled — the same function the automated
 * pharmacy-poll job uses — so this button and the cron job can never drift
 * apart again (this route used to have its own independent RMM/DigitalRX-only
 * logic that never learned about RxVortex or split orders).
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { submitToPharmacyIfEnabled } from "../../../../../utils/pharmacy-submit"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId, orderId } = req.params

    // 1. Confirm this clinic has at least one pharmacy configured — checked
    // here first so a misconfigured clinic gives the admin a clear error
    // instead of a silent no-op. Per-pharmacy credential/enabled validation
    // is submitToPharmacyIfEnabled's job below, since different products on
    // the same order can resolve to different pharmacies with different
    // credential states.
    const pharmacyCountResult = await pg.raw(
      `SELECT COUNT(*) AS count FROM clinic_pharmacy WHERE clinic_id = ? AND deleted_at IS NULL`,
      [clinicId]
    )
    if (Number(pharmacyCountResult.rows[0]?.count || 0) === 0) {
      return res.status(400).json({ message: "No pharmacy is configured for this clinic" })
    }

    // 2. Get order + workflow
    const orderResult = await pg.raw(
      `SELECT o.id, ow.id AS workflow_id, ow.treatment_dosages, ow.pharmacy_queue_id
       FROM "order" o
       LEFT JOIN order_workflow ow ON ow.order_id = o.id AND ow.deleted_at IS NULL
       WHERE o.id = ? LIMIT 1`,
      [orderId]
    )
    if (!orderResult.rows.length || !orderResult.rows[0].workflow_id) {
      return res.status(404).json({ message: "Order not found" })
    }
    const order = orderResult.rows[0]

    if (order.pharmacy_queue_id) {
      return res.json({ success: true, queueId: order.pharmacy_queue_id, message: "Already submitted" })
    }

    const dosages = typeof order.treatment_dosages === "string"
      ? JSON.parse(order.treatment_dosages || "[]")
      : (order.treatment_dosages || [])

    // 3. Submit — same logic path (incl. dosage-specific catalog mapping and
    // split orders) as the automated pharmacy-poll job.
    await submitToPharmacyIfEnabled(pg, clinicId, orderId, order.workflow_id, dosages)

    // 4. Report back what actually happened
    const resultCheck = await pg.raw(
      `SELECT pharmacy_queue_id FROM order_workflow WHERE id = ? LIMIT 1`,
      [order.workflow_id]
    )
    const queueId = resultCheck.rows[0]?.pharmacy_queue_id
    if (!queueId) {
      return res.status(500).json({ message: "Submission did not complete — check server logs for details." })
    }

    return res.json({ success: true, queueId, message: "Submitted successfully" })
  } catch (err: any) {
    console.error("[PharmacySubmit] Error:", err.message)
    return res.status(500).json({ message: err.message })
  }
}
