import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"

// POST /admin/clinics/:id/test-connection
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const svc = req.scope.resolve(CLINIC_MODULE) as any
    const result = await svc.testConnection(req.params.id)
    return res.json(result)
  } catch (err: unknown) {
    return res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : "Error",
    })
  }
}