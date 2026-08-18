/**
 * GET  /admin/clinics/:id/orders
 * DELETE /admin/clinics/:id/orders/:orderId
 * File: src/api/admin/clinics/[id]/orders/route.ts
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { issueRefund } from "../../../../utils/issue-refund"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId } = req.params
    const { status, limit = 50, offset = 0 } = req.query as any

    // Get clinic domains
    const clinicResult = await pg.raw(
      `SELECT domains FROM clinic WHERE id = ? LIMIT 1`,
      [clinicId]
    )
    if (!clinicResult.rows.length) {
      return res.status(404).json({ message: "Clinic not found" })
    }

    const domains = clinicResult.rows[0].domains || []

    let query = `
      SELECT 
        ow.id,
        ow.order_id,
        ow.status,
        ow.patient_id,
        ow.provider_name,
        ow.provider_status,
        ow.tracking_number,
        ow.carrier,
        ow.shipped_at,
        ow.md_decision,
        ow.md_notes,
        ow.treatment_dosages,
        ow.created_at,
        ow.updated_at,
        o.email as customer_email
      FROM order_workflow ow
      LEFT JOIN "order" o ON o.id = ow.order_id
      WHERE ow.tenant_domain = ANY(?)
    `
    const params: any[] = [domains]

    if (status) {
      query += ` AND ow.status = ?`
      params.push(status)
    }

    query += ` ORDER BY ow.created_at DESC LIMIT ? OFFSET ?`
    params.push(Number(limit), Number(offset))

    const result = await pg.raw(query, params)

    return res.json({ 
      orders: result.rows,
      count: result.rows.length
    })
  } catch (err: any) {
    console.error("[Orders GET] Error:", err)
    return res.status(500).json({ message: err.message })
  }
}

// Deleting the workflow now also cancels the underlying order — a stray
// order_workflow row for a live, un-refunded order was the exact hazard
// this was added to close (see [[project-order-delete-vs-cancel]]). Blocked
// entirely if the order has already shipped (refunding/canceling a
// physically-fulfilled order is a decision that shouldn't happen via a
// single delete-icon click), and blocked if there's nothing left to refund
// on an order that isn't already canceled (rather than silently skipping
// the refund step) — an already-canceled order's leftover workflow row is
// the one case allowed straight through, since there's nothing left to cancel.
export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId, orderId } = req.params

    const wfResult = await pg.raw(
      `SELECT shipped_at FROM order_workflow WHERE order_id = ? LIMIT 1`,
      [orderId]
    )
    if (wfResult.rows[0]?.shipped_at) {
      return res.status(400).json({
        message: "Cannot delete — this order has already shipped. Shipped orders must be handled manually (refund/cancel separately).",
      })
    }

    const orderResult = await pg.raw(`SELECT status FROM "order" WHERE id = ? LIMIT 1`, [orderId])
    const alreadyCanceled = orderResult.rows[0]?.status === "canceled"

    if (!alreadyCanceled) {
      const refundResult = await issueRefund(req, pg, clinicId, orderId, "Order canceled and deleted by staff")
      if (!refundResult.success) {
        return res.status(refundResult.status).json({
          message: `Cannot delete — refund failed: ${refundResult.message}`,
        })
      }
      await pg.raw(`UPDATE "order" SET status = 'canceled', updated_at = NOW() WHERE id = ?`, [orderId])
    }

    await pg.raw(
      `DELETE FROM order_workflow WHERE order_id = ?`,
      [orderId]
    )

    return res.json({ success: true, order_canceled: !alreadyCanceled })
  } catch (err: any) {
    console.error("[Orders DELETE] Error:", err)
    return res.status(500).json({ message: err.message })
  }
}