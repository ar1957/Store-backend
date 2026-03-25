import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { invalidateCorsCache } from "../../middlewares"

const CLINIC_MODULE = "clinic"

// GET /admin/clinics — list all clinics
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const svc = req.scope.resolve(CLINIC_MODULE) as any
    const clinics = await svc.getAllClinics()
    const masked = clinics.map((c: any) => ({
      ...c,
      api_client_secret: c.api_client_secret
        ? "••••••••" + c.api_client_secret.slice(-4)
        : null,
    }))
    return res.json({ clinics: masked })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

// POST /admin/clinics — create a new clinic
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const svc = req.scope.resolve(CLINIC_MODULE) as any
    const body = req.body as any
    if (!body.name || !body.slug) {
      return res.status(400).json({ message: "name and slug are required" })
    }
    const clinic = await svc.createClinic(body)
    invalidateCorsCache() // new clinic domain available immediately
    return res.json({ clinic })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}