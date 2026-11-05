import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import Stripe from "stripe"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const body = req.body as any
    const { domain, amount, currency = "usd", cartId, previousPaymentIntentId } = body

    if (!domain || !amount) {
      return res.status(400).json({ message: "domain and amount are required" })
    }

    // Get clinic's Stripe config
    const result = await pg.raw(
      `SELECT id, name, stripe_secret_key, stripe_mode, stripe_connect_account_id, platform_fee_fixed FROM clinic WHERE ? = ANY(domains) OR slug = ? LIMIT 1`,
      [domain, domain]
    )
    const clinic = result.rows[0]
    if (!clinic) return res.status(404).json({ message: "Clinic not found" })

    const stripeMode = clinic.stripe_mode || "direct"
    const isConnect = stripeMode === "connect" && clinic.stripe_connect_account_id

    console.log(`[create-payment-intent] clinic=${clinic.name} mode=${stripeMode} isConnect=${!!isConnect} connectAcct=${clinic.stripe_connect_account_id || "none"}`)

    // Resolve which Stripe secret key to use
    const stripeKey = isConnect
      ? process.env.STRIPE_API_KEY
      : clinic.stripe_secret_key

    if (!stripeKey) {
      return res.status(400).json({ message: "Stripe not configured for this clinic" })
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" as any })

    // Cancel previous clinic PI if one exists (prevents duplicate Incomplete transactions)
    if (previousPaymentIntentId && previousPaymentIntentId.startsWith("pi_")) {
      await stripe.paymentIntents.cancel(previousPaymentIntentId).catch(() => {})
    }

    // Cancel the global PI that Medusa created via initiatePaymentSession
    if (cartId && process.env.STRIPE_API_KEY) {
      try {
        const sessionResult = await pg.raw(`
          SELECT ps.data
          FROM payment_session ps
          WHERE ps.payment_collection_id = (
            SELECT payment_collection_id FROM cart WHERE id = ? LIMIT 1
          )
          AND ps.status = 'pending'
          AND ps.data->>'id' IS NOT NULL
          ORDER BY ps.created_at DESC
          LIMIT 1
        `, [cartId])

        const globalPiId = sessionResult.rows[0]?.data?.id
        if (globalPiId && globalPiId.startsWith("pi_")) {
          const globalStripe = new Stripe(process.env.STRIPE_API_KEY, { apiVersion: "2024-06-20" as any })
          await globalStripe.paymentIntents.cancel(globalPiId).catch(() => {})
        }
      } catch {
        // Non-fatal
      }
    }

    // Create fresh PaymentIntent — in Connect mode, route funds to clinic's connected account
    const piParams: Stripe.PaymentIntentCreateParams = {
      amount: Math.round(amount),
      currency,
      automatic_payment_methods: { enabled: true },
      metadata: { cartId: cartId || "", clinicId: clinic.id, clinicName: clinic.name, domain },
    }
    if (isConnect) {
      // Stripe processing fee: 2.9% + $0.30 (in cents)
      const stripeFee = Math.round(amount * 0.029) + 30
      // Platform usage fee per clinic config (stored in dollars, e.g. 10.00)
      const platformFee = Math.round((parseFloat(clinic.platform_fee_fixed) || 0) * 100)
      // application_fee_amount stays with the platform; connected account receives remainder
      piParams.application_fee_amount = stripeFee + platformFee
      piParams.transfer_data = { destination: clinic.stripe_connect_account_id }
    }
    const paymentIntent = await stripe.paymentIntents.create(piParams)

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    })
  } catch (err: unknown) {
    console.error("[create-payment-intent] error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
