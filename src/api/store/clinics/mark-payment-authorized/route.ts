import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import Stripe from "stripe"

/**
 * POST /store/clinics/mark-payment-authorized
 *
 * Called after stripe.confirmPayment() succeeds on the storefront.
 * Verifies the PaymentIntent using the clinic's own key, then marks
 * the Medusa payment session as "authorized" so authorizePaymentSessionsStep
 * in cart.complete() skips re-verification via the global Stripe key.
 *
 * Body: { cartId, paymentIntentId, domain }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const body = req.body as any
    const { cartId, paymentIntentId, domain } = body

    if (!cartId || !paymentIntentId || !domain) {
      return res.status(400).json({ message: "cartId, paymentIntentId, and domain are required" })
    }

    // Raw SQL — bypass cache for fresh keys
    const clinicResult = await pg.raw(
      `SELECT stripe_secret_key FROM clinic WHERE ? = ANY(domains) OR slug = ? LIMIT 1`,
      [domain, domain]
    )
    const clinic = clinicResult.rows[0]
    if (!clinic?.stripe_secret_key) {
      return res.status(400).json({ message: "Stripe not configured for this clinic" })
    }

    // Verify payment intent status with the clinic's own key
    const stripe = new Stripe(clinic.stripe_secret_key, { apiVersion: "2024-06-20" as any })
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId)

    if (intent.status !== "succeeded" && intent.status !== "requires_capture") {
      return res.status(400).json({ message: `Payment intent status is '${intent.status}' — cannot authorize` })
    }

    // Find the pending Medusa payment session for this cart
    const sessionResult = await pg.raw(`
      SELECT ps.id
      FROM payment_session ps
      WHERE ps.payment_collection_id = (
        SELECT payment_collection_id FROM cart WHERE id = ? LIMIT 1
      )
      AND ps.status = 'pending'
      LIMIT 1
    `, [cartId])

    if (!sessionResult.rows.length) {
      return res.status(404).json({ message: "No pending payment session found for cart" })
    }

    const sessionId = sessionResult.rows[0].id

    // Mark as authorized — authorizePaymentSessionsStep in cart.complete() skips these
    await pg.raw(
      `UPDATE payment_session SET status = 'authorized', updated_at = NOW() WHERE id = ?`,
      [sessionId]
    )

    return res.json({ success: true, sessionId })
  } catch (err: unknown) {
    console.error("[mark-payment-authorized] error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
