import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"

/**
 * GET /store/eligibility/states?domain=spaderx.com
 * Returns licensed states for a clinic from provider API (cached 24h in service)
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const domain = req.query.domain as string
    if (!domain) return res.status(400).json({ message: "domain is required" })

    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any
    let clinic = await clinicSvc.getClinicByDomain(domain)
    // Fallback: try without port
    if (!clinic) clinic = await clinicSvc.getClinicByDomain(domain.split(":")[0])
    if (!clinic) return res.status(404).json({ message: "Clinic not found for domain" })

    const locations = await clinicSvc.getLocations(clinic.id)
    return res.json({ locations })
  } catch (err: unknown) {
    console.error("States error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}