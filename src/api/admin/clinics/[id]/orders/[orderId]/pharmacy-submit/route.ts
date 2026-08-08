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

    // 1. Get clinic pharmacy config — same gate submitToPharmacyIfEnabled uses
    // internally, but checked here first so a misconfigured clinic gives the
    // admin a clear error instead of a silent no-op.
    const clinicResult = await pg.raw(
      `SELECT pharmacy_type, pharmacy_enabled, pharmacy_api_key, pharmacy_store_id,
              pharmacy_username, pharmacy_password, pharmacy_client_id, pharmacy_client_secret
       FROM clinic WHERE id = ? LIMIT 1`,
      [clinicId]
    )
    const clinic = clinicResult.rows[0]
    if (!clinic?.pharmacy_enabled) {
      return res.status(400).json({ message: "Pharmacy integration is not enabled for this clinic" })
    }

    const isRmm = clinic.pharmacy_type === "rmm"
    const isRxVortex = clinic.pharmacy_type === "rxvortex"

    if (isRmm && (!clinic.pharmacy_username || !clinic.pharmacy_password)) {
      return res.status(400).json({ message: "No RMM credentials configured for this clinic" })
    }
    if (isRxVortex && (!clinic.pharmacy_client_id || !clinic.pharmacy_client_secret)) {
      return res.status(400).json({ message: "No RxVortex credentials configured for this clinic" })
    }
    if (!isRmm && !isRxVortex && (!clinic.pharmacy_api_key || !clinic.pharmacy_store_id)) {
      return res.status(400).json({ message: "No pharmacy API configured for this clinic" })
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
