import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"

// GET /admin/clinics/:id/treatments
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const svc = req.scope.resolve(CLINIC_MODULE) as any
    const treatments = await svc.getTreatments(req.params.id)
    return res.json({ treatments })
  } catch (err: unknown) {
    return res.status(500).json({
      message: err instanceof Error ? err.message : "Error fetching treatments",
    })
  }
}