/**
 * POST /admin/clinics/:id/orders/:orderId/refund
 *
 * Issues a real payment refund via Medusa's refundPaymentWorkflow
 * (which calls Stripe / the payment provider), then updates the
 * order_workflow status to 'refund_issued'.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { refundPaymentWorkflow } from "@medusajs/core-flows"
import { Modules } from "@medusajs/framework/utils"
import { INotificationModuleService } from "@medusajs/framework/types"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId, orderId } = req.params
    const { reason } = req.body as any

    if (!reason?.trim()) {
      return res.status(400).json({ message: "Refund reason is required" })
    }

    // ── 1. Get the captured payment for this order ────────────────────────
    // order → order_payment_collection → payment_collection → payment
    const paymentResult = await pg.raw(
      `SELECT p.id AS payment_id, p.amount, p.currency_code, p.captured_at
       FROM order_payment_collection opc
       JOIN payment_collection pc ON pc.id = opc.payment_collection_id
       JOIN payment p ON p.payment_collection_id = pc.id
       WHERE opc.order_id = ?
         AND opc.deleted_at IS NULL
         AND pc.deleted_at IS NULL
         AND p.deleted_at IS NULL
         AND p.canceled_at IS NULL
       ORDER BY p.created_at DESC
       LIMIT 1`,
      [orderId]
    )

    if (!paymentResult.rows.length) {
      return res.status(404).json({ message: "No payment found for this order" })
    }

    const payment = paymentResult.rows[0]

    // ── 2. Get actor id for audit trail ───────────────────────────────────
    const actorId = (req.session as any)?.auth_context?.actor_id

    // ── 3. Run Medusa's refundPaymentWorkflow (calls Stripe) ──────────────
    await refundPaymentWorkflow(req.scope).run({
      input: {
        payment_id: payment.payment_id,
        created_by: actorId,
        note: reason.trim(),
        // no amount = full refund
      },
    })

    // ── 4. Update our workflow status to refund_issued ────────────────────
    await pg.raw(
      `UPDATE order_workflow
       SET status = 'refund_issued',
           refund_reason = ?,
           refund_issued_at = NOW(),
           updated_at = NOW()
       WHERE order_id = ? AND deleted_at IS NULL`,
      [reason.trim(), orderId]
    )

    // ── 5. Save refund reason as a comment ───────────────────────────────
    try {
      // Get the workflow id
      const wfResult = await pg.raw(
        `SELECT id FROM order_workflow WHERE order_id = ? AND deleted_at IS NULL LIMIT 1`,
        [orderId]
      )
      if (wfResult.rows.length) {
        // Get the actor's email + name for the comment
        let userEmail = ""
        let userName = "Admin"
        if (actorId) {
          const userRow = await pg.raw(
            `SELECT email, first_name, last_name FROM "user" WHERE id = ? LIMIT 1`,
            [actorId]
          )
          if (userRow.rows.length) {
            userEmail = userRow.rows[0].email || ""
            const fn = userRow.rows[0].first_name || ""
            const ln = userRow.rows[0].last_name || ""
            userName = `${fn} ${ln}`.trim() || userEmail || "Admin"
          }
        }
        const commentId = `cmt_${Date.now()}`
        await pg.raw(
          `INSERT INTO order_comment
           (id, order_workflow_id, user_id, user_email, user_name, role, comment, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            commentId,
            wfResult.rows[0].id,
            actorId || "system",
            userEmail,
            userName,
            "refund",
            `💸 Refund issued — ${reason.trim()}`,
          ]
        )
      }
    } catch (commentErr: any) {
      console.error("[Refund] Comment save error:", commentErr.message)
    }

    // ── 6. Send refund email to patient ───────────────────────────────────
    try {
      const orderResult = await pg.raw(
        `SELECT
          o.display_id,
          o.email,
          c.first_name  AS customer_first_name,
          c.last_name   AS customer_last_name,
          oa.first_name AS shipping_first_name,
          oa.last_name  AS shipping_last_name,
          sc.name       AS clinic_name,
          cl.from_email AS clinic_from_email,
          cl.from_name  AS clinic_from_name,
          cl.reply_to   AS clinic_reply_to
         FROM "order" o
         LEFT JOIN "customer" c       ON c.id  = o.customer_id
         LEFT JOIN "order_address" oa ON oa.id = o.shipping_address_id
         LEFT JOIN "sales_channel" sc ON sc.id = o.sales_channel_id
         LEFT JOIN "clinic" cl        ON cl.id = ?
         WHERE o.id = ? LIMIT 1`,
        [clinicId, orderId]
      )

      if (orderResult.rows.length && orderResult.rows[0].email) {
        const row = orderResult.rows[0]
        const firstName = row.shipping_first_name || row.customer_first_name || ""
        const lastName  = row.shipping_last_name  || row.customer_last_name  || ""
        const patientName = `${firstName} ${lastName}`.trim() || "Patient"

        const notificationService: INotificationModuleService =
          req.scope.resolve(Modules.NOTIFICATION)

        await notificationService.createNotifications({
          to: row.email,
          channel: "email",
          template: "order.refund_issued",
          data: {
            patient_name: patientName,
            order_display_id: row.display_id,
            clinic_name: row.clinic_name,
            refund_reason: reason.trim(),
            from_email: row.clinic_from_email || undefined,
            from_name: row.clinic_from_name || undefined,
            reply_to: row.clinic_reply_to || undefined,
          },
        })
      }
    } catch (emailErr: any) {
      console.error("[Refund] Email notification error:", emailErr.message)
    }

    return res.json({
      success: true,
      message: "Refund issued successfully",
    })
  } catch (err: any) {
    console.error("[Refund] Error:", err.message)
    return res.status(500).json({ message: err.message })
  }
}
