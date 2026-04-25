import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import Stripe from "stripe"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const body = req.body as any
    const { domain, amount, currency = "usd", cartId } = body

    if (!domain || !amount) {
      return res.status(400).json({ message: "domain and amount are required" })
    }

    // Raw SQL — bypass ClinicService cache so key changes take effect immediately
    const result = await pg.raw(
      `SELECT id, name, stripe_secret_key FROM clinic WHERE ? = ANY(domains) OR slug = ? LIMIT 1`,
      [domain, domain]
    )
    const clinic = result.rows[0]
    if (!clinic) return res.status(404).json({ message: "Clinic not found" })

    if (!clinic.stripe_secret_key) {
      return res.status(400).json({ message: "Stripe not configured for this clinic" })
    }

    const stripe = new Stripe(clinic.stripe_secret_key, { apiVersion: "2024-06-20" as any })

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount),
      currency,
      automatic_payment_methods: { enabled: true },
      metadata: { cartId: cartId || "", clinicId: clinic.id, clinicName: clinic.name, domain },
    })

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    })
  } catch (err: unknown) {
    console.error("[create-payment-intent] error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}