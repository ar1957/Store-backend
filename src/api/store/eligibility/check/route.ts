import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"

/**
 * GET /store/eligibility/check?domain=myclassywellness.local:8000&productId=prod_xxx
 * Returns whether a product requires eligibility screening for this clinic.
 * Falls back to publishable API key lookup if domain doesn't match.
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

    // Find clinic by domain first
    let clinic = await clinicSvc.getClinicByDomain(domain)

    // Fallback: look up by publishable API key from request header
    if (!clinic) {
      const pubKey = (req.headers["x-publishable-api-key"] as string) || ""
      if (pubKey) {
        const result = await pgConnection.raw(
          `SELECT * FROM clinic WHERE publishable_api_key = ? LIMIT 1`,
          [pubKey]
        )
        if (result.rows[0]) clinic = result.rows[0]
      }
    }

    console.log(`[EligCheck] domain=${domain} productId=${productId} clinic=${clinic?.id}`)
    if (!clinic) return res.json({ requiresEligibility: false })

    // Build all domain variants to check against — with and without port
    const domainVariants = new Set<string>()
    const clinicDomains: string[] = Array.isArray(clinic.domains) ? clinic.domains : []
    if (clinic.slug) clinicDomains.push(clinic.slug)

    for (const d of clinicDomains) {
      domainVariants.add(d)
      domainVariants.add(d.split(":")[0]) // strip port
    }
    // Also add the requested domain and its stripped version
    domainVariants.add(domain)
    domainVariants.add(domain.split(":")[0])

    const domains = Array.from(domainVariants).filter(Boolean)
    const placeholders = domains.map(() => "?").join(", ")
    const result = await pgConnection.raw(`
      SELECT requires_eligibility, tenant_domain
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
