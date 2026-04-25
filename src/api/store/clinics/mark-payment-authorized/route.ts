import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { generateEntityId } from "@medusajs/utils"
import Stripe from "stripe"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const body = req.body as any
    const { cartId, paymentIntentId, domain } = body

    if (!cartId || !paymentIntentId || !domain) {
      return res.status(400).json({ message: "cartId, paymentIntentId, and domain are required" })
    }

    // 1. Get clinic's Stripe key
    const clinicResult = await pg.raw(
      `SELECT stripe_secret_key FROM clinic WHERE ? = ANY(domains) OR slug = ? LIMIT 1`,
      [domain, domain]
    )
    const clinic = clinicResult.rows[0]
    if (!clinic?.stripe_secret_key) {
      return res.status(400).json({ message: "Stripe not configured for this clinic" })
    }

    // 2. Verify with clinic's own Stripe key
    const stripe = new Stripe(clinic.stripe_secret_key, { apiVersion: "2024-06-20" as any })
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId)
    console.log("[mark-payment-authorized] intent.status:", intent.status)

    if (intent.status !== "succeeded" && intent.status !== "requires_capture") {
      return res.status(400).json({ message: `Payment intent status is '${intent.status}' — cannot authorize` })
    }

    // 3. Get the NEWEST PENDING payment session for this cart
    //    Must be 'pending' — that's what completeCartWorkflow will try to authorize
    //    Order by created_at DESC to get the newest one in case of multiple sessions
    const sessionResult = await pg.raw(`
      SELECT ps.id, ps.amount, ps.raw_amount, ps.currency_code, ps.payment_collection_id, ps.provider_id
      FROM payment_session ps
      WHERE ps.payment_collection_id = (
        SELECT payment_collection_id FROM cart WHERE id = ? LIMIT 1
      )
      AND ps.status = 'pending'
      ORDER BY ps.created_at DESC
      LIMIT 1
    `, [cartId])

    if (!sessionResult.rows.length) {
      return res.status(404).json({ message: "No pending payment session found for cart" })
    }

    const session = sessionResult.rows[0]
    console.log("[mark-payment-authorized] found pending session:", session.id)

    // 4. Check idempotency — payment record already created for this session?
    const existingPayment = await pg.raw(
      `SELECT id FROM payment WHERE payment_session_id = ? LIMIT 1`,
      [session.id]
    )

    if (existingPayment.rows.length && existingPayment.rows[0].id) {
      console.log("[mark-payment-authorized] already authorized:", existingPayment.rows[0].id)
      return res.json({ success: true, sessionId: session.id, paymentId: existingPayment.rows[0].id })
    }

    // 5. Set authorized_at + status on payment_session
    await pg.raw(
      `UPDATE payment_session SET status = 'authorized', authorized_at = NOW(), updated_at = NOW() WHERE id = ?`,
      [session.id]
    )
    console.log("[mark-payment-authorized] session updated to authorized")

    // 6. Create payment record — satisfies Medusa's idempotency check:
    //    authorizePaymentSession() checks: if (session.payment && session.authorized_at) → skips provider call
    const paymentId = generateEntityId("", "pay")
    const intentData = {
      id: intent.id,
      status: intent.status,
      amount: intent.amount,
      currency: intent.currency,
    }

    await pg.raw(`
      INSERT INTO payment (id, amount, raw_amount, currency_code, provider_id, payment_collection_id, payment_session_id, data, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `, [
      paymentId,
      session.amount,
      JSON.stringify(session.raw_amount),
      session.currency_code,
      session.provider_id,
      session.payment_collection_id,
      session.id,
      JSON.stringify(intentData),
    ])
    console.log("[mark-payment-authorized] payment record created:", paymentId)

    return res.json({ success: true, sessionId: session.id, paymentId })
  } catch (err: unknown) {
    console.error("[mark-payment-authorized] error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
