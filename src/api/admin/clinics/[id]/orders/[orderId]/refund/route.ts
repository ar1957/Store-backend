/**
 * POST /admin/clinics/:id/orders/:orderId/refund
 *
 * Issues a real Stripe refund using the clinic's own stripe_secret_key
 * (since payments go through pp_system_default, Medusa's refundPaymentWorkflow
 * won't call Stripe — we must do it directly).
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { INotificationModuleService } from "@medusajs/framework/types"
import { generateEntityId } from "@medusajs/utils"
import Stripe from "stripe"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId, orderId } = req.params
    const { reason } = req.body as any

    if (!reason?.trim()) {
      return res.status(400).json({ message: "Refund reason is required" })
    }

    // ── 1. Get the captured payment + its Stripe PaymentIntent ID ─────────
    const paymentResult = await pg.raw(
      `SELECT p.id AS payment_id, p.amount, p.raw_amount, p.currency_code, p.captured_at, p.data
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

    // ── 2. Get clinic's Stripe secret key ────────────────────────────────
    const clinicResult = await pg.raw(
      `SELECT stripe_secret_key FROM clinic WHERE id = ? LIMIT 1`,
      [clinicId]
    )
    if (!clinicResult.rows[0]?.stripe_secret_key) {
      return res.status(400).json({ message: "Stripe not configured for this clinic" })
    }
    const stripeKey = clinicResult.rows[0].stripe_secret_key

    // ── 3. Extract PaymentIntent ID from payment.data ─────────────────────
    // payment.data stores { id: "pi_xxx", status: "succeeded", ... }
    let paymentIntentId: string | null = null
    try {
      const data = typeof payment.data === "string" ? JSON.parse(payment.data) : payment.data
      paymentIntentId = data?.id || null
    } catch {}

    if (!paymentIntentId || !paymentIntentId.startsWith("pi_")) {
      return res.status(400).json({
        message: `Cannot refund — no Stripe PaymentIntent ID found in payment record. Payment data: ${JSON.stringify(payment.data)}`
      })
    }

    // ── 4. Call Stripe to issue the actual refund ─────────────────────────
    const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" as any })
    const stripeRefund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      reason: "requested_by_customer",
      metadata: { order_id: orderId, clinic_id: clinicId, internal_reason: reason.trim() },
    })
    console.log(`[Refund] Stripe refund created: ${stripeRefund.id} status: ${stripeRefund.status}`)

    // ── 5. Create refund record in Medusa DB ──────────────────────────────
    const amount = payment.amount
    const rawAmount = JSON.stringify({ value: String(amount), precision: 20 })
    const refundId = generateEntityId("", "ref")
    const actorId = (req.session as any)?.auth_context?.actor_id

    await pg.raw(`
      INSERT INTO refund (id, amount, raw_amount, payment_id, created_by, note, created_at, updated_at)
      VALUES (?, ?, ?::jsonb, ?, ?, ?, NOW(), NOW())
      ON CONFLICT DO NOTHING
    `, [refundId, amount, rawAmount, payment.payment_id, actorId || null, reason.trim()])

    // ── 7. Update payment_collection status ──────────────────────────────
    const payColResult = await pg.raw(
      `SELECT pc.id FROM order_payment_collection opc
       JOIN payment_collection pc ON pc.id = opc.payment_collection_id
       WHERE opc.order_id = ? AND opc.deleted_at IS NULL LIMIT 1`,
      [orderId]
    )
    if (payColResult.rows.length) {
      await pg.raw(
        `UPDATE payment_collection SET status = 'canceled', updated_at = NOW() WHERE id = ?`,
        [payColResult.rows[0].id]
      )
    }

    // ── 8. Update our workflow status to refund_issued ────────────────────
    await pg.raw(
      `UPDATE order_workflow
       SET status = 'refund_issued',
           refund_reason = ?,
           refund_issued_at = NOW(),
           updated_at = NOW()
       WHERE order_id = ? AND deleted_at IS NULL`,
      [reason.trim(), orderId]
    )

    // ── 9. Save refund reason as a comment ───────────────────────────────
    try {
      const wfResult = await pg.raw(
        `SELECT id FROM order_workflow WHERE order_id = ? AND deleted_at IS NULL LIMIT 1`,
        [orderId]
      )
      if (wfResult.rows.length) {
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
            `💸 Refund issued (Stripe: ${stripeRefund.id}) — ${reason.trim()}`,
          ]
        )
      }
    } catch (commentErr: any) {
      console.error("[Refund] Comment save error:", commentErr.message)
    }

    // ── 10. Send refund email to patient ──────────────────────────────────
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
      stripe_refund_id: stripeRefund.id,
    })
  } catch (err: any) {
    console.error("[Refund] Error:", err.message)
    return res.status(500).json({ message: err.message })
  }
}
