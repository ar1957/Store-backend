import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import Stripe from "stripe"

const CLINIC_MODULE = "clinic"

/**
 * POST /store/clinics/create-payment-intent
 * Creates a Stripe PaymentIntent using the clinic's own secret key
 *
 * Body: { domain: string, amount: number, currency: string, cartId: string }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any
    const body = req.body as any
    const { domain, amount, currency = "usd", cartId } = body

    if (!domain || !amount) {
      return res.status(400).json({ message: "domain and amount are required" })
    }

    const clinic = await clinicSvc.getClinicByDomain(domain)
    if (!clinic) return res.status(404).json({ message: "Clinic not found" })

    if (!clinic.stripe_secret_key) {
      return res.status(400).json({ message: "Stripe not configured for this clinic" })
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

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    })
  } catch (err: unknown) {
    console.error("Payment intent error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}