import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

const CLINIC_MODULE = "clinic"

/**
 * POST /admin/clinics/:id/test-connection
 * Tests the GFE API credentials for a clinic by attempting to get a token.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any
    const clinic = await clinicSvc.getClinicById(req.params.id)

    if (!clinic) {
      return res.status(404).json({ success: false, message: "Clinic not found" })
    }

    const result = await clinicSvc.testConnection(clinic.id)
    return res.json(result)
  } catch (err: unknown) {
    return res.json({
      success: false,
      message: err instanceof Error ? err.message : "Connection failed",
    })
  }
}
