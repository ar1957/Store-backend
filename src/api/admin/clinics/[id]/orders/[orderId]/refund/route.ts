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

    // ── 1. Get the captured payment + session provider ────────────────────
    const paymentResult = await pg.raw(
      `SELECT p.id AS payment_id, p.amount, p.raw_amount, p.currency_code, p.captured_at, p.data,
              ps.provider_id
       FROM order_payment_collection opc
       JOIN payment_collection pc ON pc.id = opc.payment_collection_id
       JOIN payment p ON p.payment_collection_id = pc.id
       LEFT JOIN payment_session ps ON ps.id = p.payment_session_id
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

    // ── 2. Parse payment data to determine gateway ───────────────────────
    let paymentData: any = {}
    try {
      paymentData = typeof payment.data === "string" ? JSON.parse(payment.data) : (payment.data || {})
    } catch {}

    const transactionId: string = paymentData?.id || ""
    const isPaypal = payment.provider_id?.startsWith("pp_paypal") || paymentData?.provider === "paypal"
    const isAuthorizenet = !isPaypal && (paymentData?.provider === "authorizenet" || (!!transactionId && !transactionId.startsWith("pi_")))
    // pp_system_default bypasses all gateways — no real charge exists to refund
    const isNoGateway = !isPaypal && !isAuthorizenet && (
      payment.provider_id === "pp_system_default" || (!transactionId && !paymentData?.provider)
    )

    // ── 3. Get clinic credentials ────────────────────────────────────────
    const clinicResult = await pg.raw(
      `SELECT stripe_secret_key,
              authorizenet_api_login_id, authorizenet_transaction_key, authorizenet_mode,
              paypal_client_id, paypal_client_secret, paypal_mode
       FROM clinic WHERE id = ? LIMIT 1`,
      [clinicId]
    )
    const clinic = clinicResult.rows[0]

    let gatewayRefundId: string
    let gatewayLabel: string

    if (isPaypal) {
      // ── 4a. PayPal refund ───────────────────────────────────────────────
      if (!clinic?.paypal_client_id || !clinic?.paypal_client_secret) {
        return res.status(400).json({ message: "PayPal not configured for this clinic" })
      }

      const isLive = clinic.paypal_mode === "live"
      const paypalBase = isLive ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com"

      // Get access token
      const tokenRes = await fetch(`${paypalBase}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": `Basic ${Buffer.from(`${clinic.paypal_client_id}:${clinic.paypal_client_secret}`).toString("base64")}`,
        },
        body: "grant_type=client_credentials",
      })
      const tokenData = await tokenRes.json() as any
      if (!tokenData.access_token) {
        return res.status(500).json({ message: "Failed to authenticate with PayPal" })
      }
      const accessToken = tokenData.access_token

      // Find the capture ID — PayPal stores it in purchase_units[0].payments.captures[0].id
      // or directly as the top-level id depending on plugin version
      let captureId: string | null = null
      try {
        captureId =
          paymentData?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
          paymentData?.captureId ||
          paymentData?.capture_id ||
          null

        // If not in local data, fetch the PayPal order to get the capture ID
        if (!captureId && transactionId) {
          const orderRes = await fetch(`${paypalBase}/v2/checkout/orders/${transactionId}`, {
            headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
          })
          const orderData = await orderRes.json() as any
          captureId = orderData?.purchase_units?.[0]?.payments?.captures?.[0]?.id || null
        }
      } catch {}

      if (!captureId) {
        return res.status(400).json({ message: "Cannot refund — PayPal capture ID not found. The order may not have been captured yet." })
      }

      const refundRes = await fetch(`${paypalBase}/v2/payments/captures/${captureId}/refund`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          note_to_payer: reason.trim().slice(0, 255),
        }),
      })
      const refundData = await refundRes.json() as any

      if (!refundRes.ok || (refundData.status !== "COMPLETED" && refundData.status !== "PENDING")) {
        const errMsg = refundData?.message || refundData?.details?.[0]?.description || "PayPal refund failed"
        console.error("[Refund] PayPal refund error:", JSON.stringify(refundData))
        return res.status(400).json({ message: errMsg })
      }

      gatewayRefundId = refundData.id
      gatewayLabel = `PayPal: ${refundData.id}`
      console.log(`[Refund] PayPal refund successful: ${refundData.id} status: ${refundData.status}`)

    } else if (isAuthorizenet) {
      // ── 4a. Authorize.net refund ────────────────────────────────────────
      if (!clinic?.authorizenet_api_login_id || !clinic?.authorizenet_transaction_key) {
        return res.status(400).json({ message: "Authorize.net not configured for this clinic" })
      }
      if (!transactionId) {
        return res.status(400).json({ message: "Cannot refund — no Authorize.net transaction ID found in payment record" })
      }

      const isSandbox = clinic.authorizenet_mode !== "production"
      const apiUrl = isSandbox
        ? "https://apitest.authorize.net/xml/v1/request.api"
        : "https://api.authorize.net/xml/v1/request.api"

      // amountUnit:"dollars" is stamped on payments created after the dollars-storage fix.
      // Older payments stored amount in cents, so divide by 100.
      const amountDollars = paymentData?.amountUnit === "dollars"
        ? payment.amount.toFixed(2)
        : (payment.amount / 100).toFixed(2)
      const last4 = paymentData?.last4 || "0000"

      // Try void first (works if transaction not yet settled), then refund
      const voidPayload = {
        createTransactionRequest: {
          merchantAuthentication: {
            name: clinic.authorizenet_api_login_id,
            transactionKey: clinic.authorizenet_transaction_key,
          },
          transactionRequest: {
            transactionType: "voidTransaction",
            refTransId: transactionId,
          },
        },
      }

      const voidRes = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(voidPayload),
      })
      const voidData = await voidRes.json() as any
      const voidOk = voidData?.messages?.resultCode === "Ok" && voidData?.transactionResponse?.responseCode === "1"

      if (voidOk) {
        gatewayRefundId = voidData.transactionResponse.transId || transactionId
        gatewayLabel = `Authorize.net void: ${gatewayRefundId}`
        console.log(`[Refund] Authorize.net void successful: ${gatewayRefundId}`)
      } else {
        // Transaction already settled — issue a credit (refund)
        const refundPayload = {
          createTransactionRequest: {
            merchantAuthentication: {
              name: clinic.authorizenet_api_login_id,
              transactionKey: clinic.authorizenet_transaction_key,
            },
            transactionRequest: {
              transactionType: "refundTransaction",
              amount: amountDollars,
              payment: { creditCard: { cardNumber: last4, expirationDate: "XXXX" } },
              refTransId: transactionId,
            },
          },
        }

        const refundRes = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(refundPayload),
        })
        const refundData = await refundRes.json() as any

        if (refundData?.messages?.resultCode !== "Ok" || refundData?.transactionResponse?.responseCode !== "1") {
          const errMsg = refundData?.transactionResponse?.errors?.[0]?.errorText
            || refundData?.messages?.message?.[0]?.text
            || "Authorize.net refund failed"
          console.error("[Refund] Authorize.net refund error:", JSON.stringify(refundData))
          return res.status(400).json({ message: errMsg })
        }

        gatewayRefundId = refundData.transactionResponse.transId || transactionId
        gatewayLabel = `Authorize.net refund: ${gatewayRefundId}`
        console.log(`[Refund] Authorize.net refund successful: ${gatewayRefundId}`)
      }
    } else if (isNoGateway) {
      // ── 4c. No gateway charge (pp_system_default) ────────────────────────
      // Payment was auto-authorized without going through a real gateway — nothing to refund externally.
      gatewayRefundId = `internal_${Date.now()}`
      gatewayLabel = "Internal (no gateway charge)"
      console.log(`[Refund] Order ${orderId} — no gateway charge on file, recording internal refund only`)

    } else {
      // ── 4d. Stripe refund ───────────────────────────────────────────────
      if (!clinic?.stripe_secret_key) {
        return res.status(400).json({ message: "Stripe not configured for this clinic" })
      }
      if (!transactionId || !transactionId.startsWith("pi_")) {
        return res.status(400).json({
          message: `Cannot refund — no PaymentIntent ID found in payment record. Payment data: ${JSON.stringify(payment.data)}`
        })
      }

      const stripe = new Stripe(clinic.stripe_secret_key, { apiVersion: "2024-06-20" as any })
      const stripeRefund = await stripe.refunds.create({
        payment_intent: transactionId,
        reason: "requested_by_customer",
        metadata: { order_id: orderId, clinic_id: clinicId, internal_reason: reason.trim() },
      })
      gatewayRefundId = stripeRefund.id
      gatewayLabel = `Stripe: ${stripeRefund.id}`
      console.log(`[Refund] Stripe refund created: ${stripeRefund.id} status: ${stripeRefund.status}`)
    }

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
            `💸 Refund issued (${gatewayLabel}) — ${reason.trim()}`,
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
      refund_id: gatewayRefundId,
    })
  } catch (err: any) {
    console.error("[Refund] Error:", err.message)
    return res.status(500).json({ message: err.message })
  }
}
