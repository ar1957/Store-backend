import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"

/**
 * GET /store/clinics/stripe-config?domain=spaderx.com
 * Returns the Stripe publishable key for a clinic (safe to expose to frontend)
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const domain = req.query.domain as string
    if (!domain) return res.json({ stripePublishableKey: null })

    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any
    const clinic = await clinicSvc.getClinicByDomain(domain)

    if (!clinic || !clinic.stripe_publishable_key) {
      return res.json({ stripePublishableKey: null })
    }

    return res.json({
      stripePublishableKey: clinic.stripe_publishable_key,
    })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}