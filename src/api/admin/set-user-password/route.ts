/**
 * POST /admin/set-user-password
 * Body: { email: string, password: string }
 * Allows super_admin / clinic_admin to set a password for any user by email.
 * Uses the emailpass auth provider's update method directly.
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const { email, password } = req.body as { email: string; password: string }

  if (!email || !password) {
    return res.status(400).json({ message: "email and password are required" })
  }
  if (password.length < 8) {
    return res.status(400).json({ message: "Password must be at least 8 characters" })
  }

  const authService = req.scope.resolve(Modules.AUTH)

  const { success, error } = await authService.updateProvider("emailpass", {
    entity_id: email,
    password,
  })

  if (!success) {
    return res.status(400).json({ message: error || "Failed to update password" })
  }

  return res.status(200).json({ success: true })
}
