import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"

// GET /admin/clinics/:id/treatments
// ?refresh=true bypasses the 24h in-memory treatment cache — needed since
// nothing client-side (reload, logout, tab switch) can clear a server-side
// cache, and MHC-side treatment edits (e.g. soft-deleting a stray treatment)
// would otherwise stay invisible here for up to 24h with no way to force it.
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const svc = req.scope.resolve(CLINIC_MODULE) as any
    const forceRefresh = req.query?.refresh === "true"
    const treatments = await svc.getTreatments(req.params.id, forceRefresh)
    return res.json({ treatments })
  } catch (err: unknown) {
    return res.status(500).json({
      message: err instanceof Error ? err.message : "Error fetching treatments",
    })
  }
}