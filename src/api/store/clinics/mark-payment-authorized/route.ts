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
    const sessionResult = await pg.raw(`
      SELECT ps.id, ps.amount, ps.currency_code, ps.payment_collection_id, ps.provider_id
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
    const amount = session.amount
    // raw_amount format Medusa expects: {"value": "450", "precision": 20}
    const rawAmount = JSON.stringify({ value: String(amount), precision: 20 })

    console.log("[mark-payment-authorized] found pending session:", session.id, "amount:", amount)

    // 4. Idempotency — payment record already exists?
    const existingPayment = await pg.raw(
      `SELECT id FROM payment WHERE payment_session_id = ? LIMIT 1`,
      [session.id]
    )
    if (existingPayment.rows.length && existingPayment.rows[0].id) {
      console.log("[mark-payment-authorized] already authorized:", existingPayment.rows[0].id)
      return res.json({ success: true, sessionId: session.id, paymentId: existingPayment.rows[0].id })
    }

    // 5. Update payment_session to authorized
    await pg.raw(
      `UPDATE payment_session SET status = 'authorized', authorized_at = NOW(), updated_at = NOW() WHERE id = ?`,
      [session.id]
    )

    // 6. Create payment record with captured_at set
    const paymentId = generateEntityId("", "pay")
    const intentData = { id: intent.id, status: intent.status, amount: intent.amount, currency: intent.currency }

    await pg.raw(`
      INSERT INTO payment (id, amount, raw_amount, currency_code, provider_id, payment_collection_id, payment_session_id, data, captured_at, created_at, updated_at)
      VALUES (?, ?, ?::jsonb, ?, ?, ?, ?, ?::jsonb, NOW(), NOW(), NOW())
    `, [
      paymentId,
      amount,
      rawAmount,
      session.currency_code,
      session.provider_id,
      session.payment_collection_id,
      session.id,
      JSON.stringify(intentData),
    ])
    console.log("[mark-payment-authorized] payment record created:", paymentId)

    // 7. Create capture record — makes Medusa admin show "Captured" + correct "Total paid"
    const captureId = generateEntityId("", "capt")
    await pg.raw(`
      INSERT INTO capture (id, amount, raw_amount, payment_id, created_at, updated_at)
      VALUES (?, ?, ?::jsonb, ?, NOW(), NOW())
    `, [captureId, amount, rawAmount, paymentId])
    console.log("[mark-payment-authorized] capture record created:", captureId)

    // 8. Update payment_collection to "completed" with captured/authorized amounts
    //    Valid statuses: not_paid, awaiting, authorized, partially_authorized,
    //                    canceled, failed, partially_captured, completed
    await pg.raw(`
      UPDATE payment_collection 
      SET status = 'completed',
          authorized_amount = ?,
          raw_authorized_amount = ?::jsonb,
          captured_amount = ?,
          raw_captured_amount = ?::jsonb,
          updated_at = NOW()
      WHERE id = ?
    `, [amount, rawAmount, amount, rawAmount, session.payment_collection_id])
    console.log("[mark-payment-authorized] payment_collection updated to completed")

    return res.json({ success: true, sessionId: session.id, paymentId, captureId })
  } catch (err: unknown) {
    console.error("[mark-payment-authorized] error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
