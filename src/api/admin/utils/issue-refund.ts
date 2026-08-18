/**
 * Shared refund-issuing logic, extracted from the original inline POST handler
 * in orders/[orderId]/refund/route.ts so the "delete order" cancel-and-refund
 * flow (orders/[orderId]/route.ts DELETE) can issue a real gateway refund
 * through the exact same code path — never a re-implementation that could
 * drift out of sync with gateway-specific quirks (PayPal capture-id lookup,
 * Authorize.net void-vs-credit, Stripe PaymentIntent detection, etc).
 *
 * Issues a real Stripe/PayPal/Authorize.net refund using the clinic's own
 * gateway credentials (since payments go through pp_system_default, Medusa's
 * refundPaymentWorkflow won't call the gateway — this must be done directly).
 */
import { Modules } from "@medusajs/framework/utils"
import { INotificationModuleService } from "@medusajs/framework/types"
import { generateEntityId } from "@medusajs/utils"
import Stripe from "stripe"

// Medusa v2 core stores payment.amount in dollars (major currency unit)
// natively — that's true for Stripe (pp_stripe_stripe), PayPal, and the
// no-gateway (pp_system_default) path, all of which go through Medusa's own
// payment workflows. The ONE exception is this codebase's custom Authorize.net
// integration (create-authorizenet-charge/route.ts), which historically wrote
// raw cents and only stamps amountUnit: "dollars" on payments created after
// that was fixed — so "assume cents" must apply ONLY to unstamped Authorize.net
// records, not to every payment that lacks the stamp.
export async function getRefundableAmount(pg: any, orderId: string) {
  const paymentResult = await pg.raw(
    `SELECT p.id AS payment_id, p.amount, p.currency_code, p.captured_at, p.data,
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

  if (!paymentResult.rows.length) return null
  const payment = paymentResult.rows[0]

  let paymentData: any = {}
  try {
    paymentData = typeof payment.data === "string" ? JSON.parse(payment.data) : (payment.data || {})
  } catch {}

  const transactionId: string = paymentData?.id || ""
  const isPaypal = payment.provider_id?.startsWith("pp_paypal") || paymentData?.provider === "paypal"
  const isAuthorizenet = !isPaypal && (paymentData?.provider === "authorizenet" || (!!transactionId && !transactionId.startsWith("pi_")))
  // IMPORTANT: pp_system_default is the standard provider_id for every payment
  // made through this app's custom clinic-Stripe integration — it does NOT
  // mean "no real charge." A pp_system_default payment can still carry a real
  // Stripe PaymentIntent id (pi_...) in its data, in which case it must fall
  // through to the Stripe refund branch below, not be treated as no-gateway.
  // Only classify as no-gateway when there's genuinely no transaction id at all.
  const isNoGateway = !isPaypal && !isAuthorizenet && !transactionId

  const isDollars = !isAuthorizenet || paymentData?.amountUnit === "dollars"
  const capturedNative = Number(payment.amount)

  const refundedResult = await pg.raw(
    `SELECT COALESCE(SUM(amount), 0) AS refunded FROM refund WHERE payment_id = ?`,
    [payment.payment_id]
  )
  const refundedNative = Number(refundedResult.rows[0]?.refunded || 0)

  const remainingNative = capturedNative - refundedNative
  const capturedDollars = isDollars ? capturedNative : capturedNative / 100
  const refundedDollars = isDollars ? refundedNative : refundedNative / 100
  const remainingDollars = isDollars ? remainingNative : remainingNative / 100

  return {
    payment, paymentData, isDollars,
    transactionId, isPaypal, isAuthorizenet, isNoGateway,
    capturedNative, refundedNative, remainingNative,
    capturedDollars, refundedDollars, remainingDollars,
    currency: (payment.currency_code || "usd").toUpperCase(),
  }
}

export type IssueRefundResult =
  | {
      success: true
      message: string
      refund_id: string
      amount_refunded: number
      is_full_refund: boolean
      remaining_after: number
    }
  | { success: false; status: number; message: string }

/**
 * Issues a refund (full remaining amount if `amount` is omitted) through the
 * correct gateway for this payment, then updates DB bookkeeping (refund
 * record, payment_collection/order_workflow status, comment log, patient
 * email) exactly as the refund admin route always has. Returns a result
 * object instead of writing to `res` directly so callers (the refund route,
 * and the delete/cancel-order route) can each decide how to respond.
 */
export async function issueRefund(
  req: { scope: any; session?: any },
  pg: any,
  clinicId: string,
  orderId: string,
  reason: string,
  amount?: number | null
): Promise<IssueRefundResult> {
  // ── 1. Get the captured payment + already-refunded amount ─────────────
  const info = await getRefundableAmount(pg, orderId)
  if (!info) return { success: false, status: 404, message: "No payment found for this order" }

  const { payment, paymentData, isDollars, remainingDollars, currency, transactionId, isPaypal, isAuthorizenet, isNoGateway } = info

  if (remainingDollars <= 0.005) {
    return { success: false, status: 400, message: "This payment has already been fully refunded." }
  }

  // ── 2. Resolve + validate requested amount (defaults to full remaining) ──
  const requestedDollars = amount !== undefined && amount !== null && (amount as any) !== ""
    ? Number(amount)
    : remainingDollars

  if (!Number.isFinite(requestedDollars) || requestedDollars <= 0) {
    return { success: false, status: 400, message: "Refund amount must be greater than $0." }
  }
  if (requestedDollars > remainingDollars + 0.01) {
    return {
      success: false, status: 400,
      message: `Refund amount cannot exceed the remaining refundable amount ($${remainingDollars.toFixed(2)}).`,
    }
  }

  const isFullRefund = Math.abs(requestedDollars - remainingDollars) < 0.01

  // ── 4. Get clinic credentials ────────────────────────────────────────
  const clinicResult = await pg.raw(
    `SELECT stripe_secret_key,
            authorizenet_api_login_id, authorizenet_transaction_key, authorizenet_mode,
            paypal_client_id, paypal_client_secret, paypal_mode
     FROM clinic WHERE id = ? LIMIT 1`,
    [clinicId]
  )
  const clinic = clinicResult.rows[0]

  let gatewayRefundId: string = ""
  let gatewayLabel: string = ""

  if (isPaypal) {
    // ── 5a. PayPal refund ───────────────────────────────────────────────
    if (!clinic?.paypal_client_id || !clinic?.paypal_client_secret) {
      return { success: false, status: 400, message: "PayPal not configured for this clinic" }
    }

    const isLive = clinic.paypal_mode === "live"
    const paypalBase = isLive ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com"

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
      return { success: false, status: 500, message: "Failed to authenticate with PayPal" }
    }
    const accessToken = tokenData.access_token

    let captureId: string | null = null
    try {
      captureId =
        paymentData?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
        paymentData?.captureId ||
        paymentData?.capture_id ||
        null

      if (!captureId && transactionId) {
        const orderRes = await fetch(`${paypalBase}/v2/checkout/orders/${transactionId}`, {
          headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        })
        const orderData = await orderRes.json() as any
        captureId = orderData?.purchase_units?.[0]?.payments?.captures?.[0]?.id || null
      }
    } catch {}

    if (!captureId) {
      return { success: false, status: 400, message: "Cannot refund — PayPal capture ID not found. The order may not have been captured yet." }
    }

    const refundRes = await fetch(`${paypalBase}/v2/payments/captures/${captureId}/refund`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        note_to_payer: reason.trim().slice(0, 255),
        // Omitting `amount` means "refund the full remaining captured amount" per PayPal's API.
        ...(isFullRefund ? {} : { amount: { value: requestedDollars.toFixed(2), currency_code: currency } }),
      }),
    })
    const refundData = await refundRes.json() as any

    if (!refundRes.ok || (refundData.status !== "COMPLETED" && refundData.status !== "PENDING")) {
      const errMsg = refundData?.message || refundData?.details?.[0]?.description || "PayPal refund failed"
      console.error("[Refund] PayPal refund error:", JSON.stringify(refundData))
      return { success: false, status: 400, message: errMsg }
    }

    gatewayRefundId = refundData.id
    gatewayLabel = `PayPal: ${refundData.id}`
    console.log(`[Refund] PayPal refund successful: ${refundData.id} status: ${refundData.status}`)

  } else if (isAuthorizenet) {
    // ── 5b. Authorize.net refund ────────────────────────────────────────
    if (!clinic?.authorizenet_api_login_id || !clinic?.authorizenet_transaction_key) {
      return { success: false, status: 400, message: "Authorize.net not configured for this clinic" }
    }
    if (!transactionId) {
      return { success: false, status: 400, message: "Cannot refund — no Authorize.net transaction ID found in payment record" }
    }

    const isSandbox = clinic.authorizenet_mode !== "production"
    const apiUrl = isSandbox
      ? "https://apitest.authorize.net/xml/v1/request.api"
      : "https://api.authorize.net/xml/v1/request.api"

    const last4 = paymentData?.last4 || "0000"

    // Void only works for a FULL refund of an unsettled transaction — it
    // can't cancel part of a charge. Partial refunds always go straight to
    // the refundTransaction (credit) path below.
    let voidOk = false
    if (isFullRefund) {
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
      voidOk = voidData?.messages?.resultCode === "Ok" && voidData?.transactionResponse?.responseCode === "1"

      if (voidOk) {
        gatewayRefundId = voidData.transactionResponse.transId || transactionId
        gatewayLabel = `Authorize.net void: ${gatewayRefundId}`
        console.log(`[Refund] Authorize.net void successful: ${gatewayRefundId}`)
      }
    }

    if (!voidOk) {
      // Transaction already settled, or this is a partial refund — issue a credit.
      const refundPayload = {
        createTransactionRequest: {
          merchantAuthentication: {
            name: clinic.authorizenet_api_login_id,
            transactionKey: clinic.authorizenet_transaction_key,
          },
          transactionRequest: {
            transactionType: "refundTransaction",
            amount: requestedDollars.toFixed(2),
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
        return { success: false, status: 400, message: errMsg }
      }

      gatewayRefundId = refundData.transactionResponse.transId || transactionId
      gatewayLabel = `Authorize.net refund: ${gatewayRefundId}`
      console.log(`[Refund] Authorize.net refund successful: ${gatewayRefundId}`)
    }
  } else if (isNoGateway) {
    // ── 5c. No gateway charge (pp_system_default) ────────────────────────
    gatewayRefundId = `internal_${Date.now()}`
    gatewayLabel = "Internal (no gateway charge)"
    console.log(`[Refund] Order ${orderId} — no gateway charge on file, recording internal refund only`)

  } else {
    // ── 5d. Stripe refund ───────────────────────────────────────────────
    if (!clinic?.stripe_secret_key) {
      return { success: false, status: 400, message: "Stripe not configured for this clinic" }
    }
    if (!transactionId || !transactionId.startsWith("pi_")) {
      return {
        success: false, status: 400,
        message: `Cannot refund — no PaymentIntent ID found in payment record. Payment data: ${JSON.stringify(payment.data)}`,
      }
    }

    const stripe = new Stripe(clinic.stripe_secret_key, { apiVersion: "2024-06-20" as any })
    const stripeRefund = await stripe.refunds.create({
      payment_intent: transactionId,
      amount: Math.round(requestedDollars * 100),
      reason: "requested_by_customer",
      metadata: { order_id: orderId, clinic_id: clinicId, internal_reason: reason.trim() },
    })
    gatewayRefundId = stripeRefund.id
    gatewayLabel = `Stripe: ${stripeRefund.id}`
    console.log(`[Refund] Stripe refund created: ${stripeRefund.id} status: ${stripeRefund.status}`)
  }

  // ── 6. Create refund record in Medusa DB (native unit, same as payment.amount) ──
  const refundNative = isDollars ? requestedDollars : Math.round(requestedDollars * 100)
  const rawAmount = JSON.stringify({ value: String(refundNative), precision: 20 })
  const refundId = generateEntityId("", "ref")
  const actorId = (req.session as any)?.auth_context?.actor_id

  await pg.raw(`
    INSERT INTO refund (id, amount, raw_amount, payment_id, created_by, note, created_at, updated_at)
    VALUES (?, ?, ?::jsonb, ?, ?, ?, NOW(), NOW())
    ON CONFLICT DO NOTHING
  `, [refundId, refundNative, rawAmount, payment.payment_id, actorId || null, reason.trim()])

  // ── 7. Update payment_collection / order_workflow status. Medusa's
  // payment_collection status enum has no "partially_refunded" value, so
  // that's only touched on a full refund. order_workflow.status, however,
  // DOES need to move for a partial refund too — jobs like the GFE poll,
  // the provider-reminder email, and pharmacy auto-submit all filter on
  // an exact status match (e.g. WHERE status = 'pending_provider'), so
  // leaving status untouched would let the patient keep connecting with a
  // provider / the order keep auto-advancing after a partial refund that
  // was meant to stop it (e.g. refunding minus a GFE fee to decline the visit).
  // Skipped only when the order is already past the point where those jobs
  // matter (shipped) or already in a refund-terminal status.
  if (isFullRefund) {
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

    await pg.raw(
      `UPDATE order_workflow
       SET status = 'refund_issued',
           refund_reason = ?,
           refund_issued_at = NOW(),
           updated_at = NOW()
       WHERE order_id = ? AND deleted_at IS NULL`,
      [reason.trim(), orderId]
    )
  } else {
    const wfStatusResult = await pg.raw(
      `SELECT status FROM order_workflow WHERE order_id = ? AND deleted_at IS NULL LIMIT 1`,
      [orderId]
    )
    const currentStatus = wfStatusResult.rows[0]?.status
    const shouldAdvanceStatus = !!currentStatus
      && !["shipped", "refund_issued", "partial_refund_issued"].includes(currentStatus)

    await pg.raw(
      `UPDATE order_workflow
       SET refund_reason = ?,
           refund_issued_at = NOW(),
           updated_at = NOW()
           ${shouldAdvanceStatus ? ", status = 'partial_refund_issued'" : ""}
       WHERE order_id = ? AND deleted_at IS NULL`,
      [reason.trim(), orderId]
    )
  }

  // ── 8. Save refund reason as a comment ───────────────────────────────
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
      const amountLabel = `$${requestedDollars.toFixed(2)}${isFullRefund ? "" : ` of $${(info.remainingDollars).toFixed(2)} remaining`}`
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
          `💸 ${isFullRefund ? "Refund" : "Partial refund"} issued (${gatewayLabel}) — ${amountLabel} — ${reason.trim()}`,
        ]
      )
    }
  } catch (commentErr: any) {
    console.error("[Refund] Comment save error:", commentErr.message)
  }

  // ── 9. Send refund email to patient ──────────────────────────────────
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
          refund_amount: `$${requestedDollars.toFixed(2)}`,
          is_partial_refund: !isFullRefund,
          from_email: row.clinic_from_email || undefined,
          from_name: row.clinic_from_name || undefined,
          reply_to: row.clinic_reply_to || undefined,
        },
      })
    }
  } catch (emailErr: any) {
    console.error("[Refund] Email notification error:", emailErr.message)
  }

  return {
    success: true,
    message: isFullRefund ? "Refund issued successfully" : "Partial refund issued successfully",
    refund_id: gatewayRefundId,
    amount_refunded: Number(requestedDollars.toFixed(2)),
    is_full_refund: isFullRefund,
    remaining_after: Number(Math.max(0, remainingDollars - requestedDollars).toFixed(2)),
  }
}
