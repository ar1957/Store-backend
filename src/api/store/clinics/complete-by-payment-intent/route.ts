import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { completeCartWorkflow } from "@medusajs/core-flows"
import Stripe from "stripe"

/**
 * POST /store/clinics/complete-by-payment-intent
 *
 * Called by the Klarna/Stripe redirect return page when the cart cookie
 * is lost after the external redirect. Retrieves the payment intent from
 * Stripe (which has cartId in metadata), marks the payment authorized,
 * then completes the cart.
 *
 * Body: { paymentIntentId: string }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const { paymentIntentId, cartId: cartIdFromBody } = req.body as any
    const pg = req.scope.resolve("__pg_connection__") as any

    if (!paymentIntentId) {
      return res.status(400).json({ message: "paymentIntentId is required" })
    }

    // 1. Find the clinic by looking up which clinic has a Stripe key that owns this PI.
    //    We stored cartId + domain in the PI metadata when creating it.
    //    Try each clinic's Stripe key until we find the one that owns this PI.
    const clinicsRes = await pg.raw(
      `SELECT id, name, stripe_secret_key FROM clinic WHERE stripe_secret_key IS NOT NULL AND deleted_at IS NULL`
    )

    let intent: any = null
    let clinicStripeKey: string | null = null

    for (const clinic of clinicsRes.rows) {
      try {
        const stripe = new Stripe(clinic.stripe_secret_key, { apiVersion: "2024-06-20" as any })
        intent = await stripe.paymentIntents.retrieve(paymentIntentId)
        clinicStripeKey = clinic.stripe_secret_key
        break
      } catch {
        // Not this clinic's key — try next
      }
    }

    if (!intent) {
      console.warn(`[complete-by-pi] Could not find PI ${paymentIntentId} in any clinic's Stripe account`)
      return res.status(404).json({ message: "Payment intent not found" })
    }

    console.log(`[complete-by-pi] Found PI ${paymentIntentId}, status: ${intent.status}`)

    // 2. Check payment was actually successful
    if (intent.status !== "succeeded" && intent.status !== "requires_capture") {
      return res.status(400).json({
        message: `Payment status is '${intent.status}' — cannot complete order`
      })
    }

    // 3. Get cartId — prefer the one passed directly (from return_url param), fall back to PI metadata
    const cartId = cartIdFromBody || intent.metadata?.cartId
    if (!cartId) {
      return res.status(400).json({ message: "No cartId in payment intent metadata" })
    }

    console.log(`[complete-by-pi] Cart ID from PI metadata: ${cartId}`)

    // 4. Check if order already exists for this cart (idempotency)
    const existingOrder = await pg.raw(
      `SELECT order_id FROM order_cart WHERE cart_id = ? LIMIT 1`,
      [cartId]
    )
    if (existingOrder.rows.length) {
      const orderId = existingOrder.rows[0].order_id
      console.log(`[complete-by-pi] Order already exists: ${orderId}`)
      const orderRes = await pg.raw(
        `SELECT id, display_id FROM "order" WHERE id = ? LIMIT 1`,
        [orderId]
      )
      return res.json({ type: "order", order: { id: orderId, display_id: orderRes.rows[0]?.display_id } })
    }

    // 5. Find the payment session for this cart and mark it authorized
    const sessionResult = await pg.raw(`
      SELECT ps.id as session_id, ps.amount, ps.currency_code,
             ps.payment_collection_id, ps.provider_id, ps.status as session_status
      FROM payment_session ps
      WHERE ps.payment_collection_id = (
        SELECT cpc.payment_collection_id
        FROM cart_payment_collection cpc
        WHERE cpc.cart_id = ?
        LIMIT 1
      )
      ORDER BY ps.created_at DESC
      LIMIT 1
    `, [cartId])

    if (!sessionResult.rows.length) {
      return res.status(404).json({ message: "No payment session found for cart" })
    }

    const session = sessionResult.rows[0]
    console.log(`[complete-by-pi] Payment session: ${session.session_id}, status: ${session.session_status}`)

    // 6. Mark authorized if not already — use same logic as mark-payment-authorized
    if (session.session_status !== "authorized") {
      const { generateEntityId } = await import("@medusajs/utils")
      const amount = session.amount
      const rawAmount = JSON.stringify({ value: String(amount), precision: 20 })
      const intentData = { id: intent.id, status: intent.status, amount: intent.amount, currency: intent.currency }

      await pg.raw(
        `UPDATE payment_session SET status = 'authorized', authorized_at = NOW(), updated_at = NOW() WHERE id = ?`,
        [session.session_id]
      )

      // Check if payment record already exists
      const existingPayment = await pg.raw(
        `SELECT id FROM payment WHERE payment_session_id = ? LIMIT 1`,
        [session.session_id]
      )

      if (!existingPayment.rows.length) {
        const paymentId = generateEntityId("", "pay")
        await pg.raw(`
          INSERT INTO payment (id, amount, raw_amount, currency_code, provider_id, payment_collection_id, payment_session_id, data, captured_at, created_at, updated_at)
          VALUES (?, ?, ?::jsonb, ?, ?, ?, ?, ?::jsonb, NOW(), NOW(), NOW())
        `, [paymentId, amount, rawAmount, session.currency_code, session.provider_id,
            session.payment_collection_id, session.session_id, JSON.stringify(intentData)])

        const captureId = generateEntityId("", "capt")
        await pg.raw(`
          INSERT INTO capture (id, amount, raw_amount, payment_id, created_at, updated_at)
          VALUES (?, ?, ?::jsonb, ?, NOW(), NOW())
        `, [captureId, amount, rawAmount, paymentId])

        await pg.raw(`
          UPDATE payment_collection
          SET status = 'completed', authorized_amount = ?, raw_authorized_amount = ?::jsonb,
              captured_amount = ?, raw_captured_amount = ?::jsonb, updated_at = NOW()
          WHERE id = ?
        `, [amount, rawAmount, amount, rawAmount, session.payment_collection_id])

        console.log(`[complete-by-pi] Payment authorized and captured: ${paymentId}`)
      }
    }

    // 7. Complete the cart → creates the order
    const { result } = await completeCartWorkflow(req.scope).run({
      input: { id: cartId },
    })

    const r = result as any
    console.log(`[complete-by-pi] Workflow result:`, JSON.stringify(r))

    const orderId: string | null = r?.id || r?.order?.id || null

    if (orderId) {
      const orderRes = await pg.raw(
        `SELECT id, display_id FROM "order" WHERE id = ? LIMIT 1`,
        [orderId]
      )
      return res.json({ type: "order", order: { id: orderId, display_id: orderRes.rows[0]?.display_id } })
    }

    // Fallback: check order_cart
    const ocResult = await pg.raw(
      `SELECT order_id FROM order_cart WHERE cart_id = ? LIMIT 1`,
      [cartId]
    )
    if (ocResult.rows.length) {
      return res.json({ type: "order", order: { id: ocResult.rows[0].order_id } })
    }

    return res.status(500).json({ message: "Cart found but order creation failed" })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Error"
    if (msg.includes("409") || msg.includes("already being completed")) {
      return res.status(409).json({ message: msg })
    }
    console.error("[complete-by-pi] error:", err)
    return res.status(500).json({ message: msg })
  }
}
