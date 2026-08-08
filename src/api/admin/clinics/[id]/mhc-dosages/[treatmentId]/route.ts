/**
 * GET /admin/clinics/:id/mhc-dosages/:treatmentId
 * Proxies the MHC dosage-progression API so the admin UI can list the
 * Month 1..N dosage tiers for a treatment without exposing clinic API
 * credentials to the browser.
 *
 * ASSUMPTION: this endpoint lives on the same host/auth as the GFE API
 * (clinic.api_base_url_prod/test, authenticated via clinicSvc.getToken) —
 * confirmed the dosage endpoint requires a bearer token (verified via a
 * live 401 "authorization token must be provided" response), but the token
 * itself hasn't been confirmed to be interchangeable across the /endpoint/v2
 * and /api/dosage paths. If this route 401s in practice, that assumption
 * needs revisiting with MHC directly.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

const CLINIC_MODULE = "clinic"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any

    const clinic = await clinicSvc.getClinicById(req.params.id)
    if (!clinic) return res.status(404).json({ message: "Clinic not found" })

    const treatmentId = req.params.treatmentId
    if (!treatmentId || !/^\d+$/.test(treatmentId)) {
      return res.status(400).json({ message: "Invalid treatment id" })
    }

    const token = await clinicSvc.getToken(clinic.id)

    // Dosage API lives at the host root (/api/dosage/...), not under the
    // /endpoint/v2 prefix used by the rest of the clinic integration.
    const baseUrl = clinicSvc.getApiBaseUrl(clinic).replace(/\/endpoint\/v2\/?$/, "")

    const dosageRes = await fetch(`${baseUrl}/api/dosage/treatment/${treatmentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!dosageRes.ok) {
      const text = await dosageRes.text()
      return res.status(dosageRes.status).json({ message: `Dosage fetch failed: ${text.slice(0, 200)}` })
    }

    const data = await dosageRes.json()
    const dosages: any[] = Array.isArray(data?.payload) ? data.payload : []

    return res.json({
      dosages: dosages.map((d: any) => ({
        id: d.id,
        treatmentId: d.treatmentId,
        key: d.key,
        value: d.value,
      })),
    })
  } catch (err: any) {
    console.error("[MhcDosages] Error:", err.message)
    return res.status(500).json({ message: err.message })
  }
}
