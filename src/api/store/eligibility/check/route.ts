import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"

/**
 * GET /store/eligibility/check?domain=myclassywellness.local:8000&productId=prod_xxx
 * Returns whether a product requires eligibility screening for this clinic
 * Checks against ALL clinic domains so local dev domains work correctly
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const domain = req.query.domain as string
    const productId = req.query.productId as string

    if (!domain || !productId) {
      return res.json({ requiresEligibility: false })
    }

    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any
    const pgConnection = req.scope.resolve("__pg_connection__") as any

    // Find clinic by the requested domain
    const clinic = await clinicSvc.getClinicByDomain(domain)
    if (!clinic) return res.json({ requiresEligibility: false })

    // Check against ALL domains for this clinic so any alias works
    const domains: string[] = clinic.domains || []
    if (clinic.slug && !domains.includes(clinic.slug)) domains.push(clinic.slug)
    if (!domains.length) return res.json({ requiresEligibility: false })

    const placeholders = domains.map(() => "?").join(", ")
    const result = await pgConnection.raw(`
      SELECT requires_eligibility
      FROM product_treatment_map
      WHERE tenant_domain IN (${placeholders}) AND product_id = ?
      LIMIT 1
    `, [...domains, productId])

    const row = result.rows[0]
    return res.json({
      requiresEligibility: row?.requires_eligibility === true,
    })
  } catch (err: unknown) {
    console.error("Eligibility check error:", err)
    return res.json({ requiresEligibility: false })
  }
}