import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const CLINIC_OPS_MODULE = "clinicOps"

// DELETE /admin/clinics/:id/staff/:staffId
export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  try {
    const opsSvc = req.scope.resolve(CLINIC_OPS_MODULE) as any
    await opsSvc.deactivateStaff(req.params.staffId)
    return res.json({ success: true })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}