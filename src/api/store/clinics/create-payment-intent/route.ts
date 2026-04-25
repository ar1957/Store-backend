import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import Stripe from "stripe"

/**
 * POST /store/clinics/create-payment-intent
 * Creates a Stripe PaymentIntent using the clinic's own secret key
 *
 * Body: { domain: string, amount: number, currency: string, cartId: string }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const body = req.body as any
    const { domain, amount, currency = "usd", cartId } = body

    console.log("[create-payment-intent] Received domain:", domain, "amount:", amount)

    if (!domain || !amount) {
      return res.status(400).json({ message: "domain and amount are required" })
    }

    // Use raw SQL to bypass the in-memory clinic cache
    const result = await pg.raw(
      `SELECT id, name, stripe_secret_key FROM clinic 
       WHERE ($1 = ANY(domains) OR $2 = ANY(SELECT split_part(d,':',1) FROM unnest(domains) AS d))
         AND deleted_at IS NULL AND is_active = true
       LIMIT 1`,
      [domain, domain]
    )

    console.log("[create-payment-intent] Clinic lookup result:", result.rows.length, "rows")

    if (!result.rows.length) {
      console.error("[create-payment-intent] Clinic not found for domain:", domain)
      return res.status(404).json({ message: `Clinic not found for domain: ${domain}` })
    }

    const clinic = result.rows[0]
    console.log("[create-payment-intent] Found clinic:", clinic.name, "has stripe_secret_key:", !!clinic.stripe_secret_key)

    if (!clinic.stripe_secret_key) {
      return res.status(400).json({ message: "Stripe not configured for this clinic" })
    }

    if (!clinic.stripe_secret_key.startsWith("sk_")) {
      return res.status(400).json({ message: `Invalid Stripe secret key format for clinic ${clinic.name}` })
    }

    // Use clinic's own Stripe secret key
    const stripe = new Stripe(clinic.stripe_secret_key, {
      apiVersion: "2024-06-20" as any,
    })

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount), // amount in cents
      currency,
      metadata: {
        cartId: cartId || "",
        clinicId: clinic.id,
        clinicName: clinic.name,
        domain,
      },
    })

    console.log("[create-payment-intent] Created PaymentIntent:", paymentIntent.id)

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    })
  } catch (err: unknown) {
    console.error("Payment intent error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}