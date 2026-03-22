/**
 * POST /admin/set-user-password
 * Body: { email: string, password: string }
 * Sets (or creates) the emailpass auth identity for a user.
 * Creates the Medusa user record if it doesn't exist yet.
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
  const userService = req.scope.resolve(Modules.USER) as any
  const pg = req.scope.resolve("__pg_connection__") as any

  // Try updating first (user has logged in before and has an auth identity)
  const { success, error } = await authService.updateProvider("emailpass", {
    entity_id: email,
    password,
  })

  if (success) {
    return res.status(200).json({ success: true })
  }

  console.log(`[set-user-password] updateProvider failed for ${email}: ${error}`)

  try {
    // Find or create the Medusa user record
    let userId: string | null = null

    const userResult = await pg.raw(
      `SELECT id FROM "user" WHERE email = ? LIMIT 1`,
      [email]
    )
    userId = userResult.rows[0]?.id ?? null

    if (!userId) {
      // Create the user via the user module
      const newUser = await userService.createUsers({ email })
      userId = newUser.id || newUser[0]?.id
      console.log(`[set-user-password] Created new user ${userId} for ${email}`)
    }

    if (!userId) {
      return res.status(500).json({ message: `Failed to create user for ${email}` })
    }

    // Check if a provider identity already exists
    const existingIdentity = await pg.raw(
      `SELECT ai.id FROM auth_identity ai
       JOIN provider_identity pi ON pi.auth_identity_id = ai.id
       WHERE pi.entity_id = ? AND pi.provider = 'emailpass'
       LIMIT 1`,
      [email]
    )

    if (!existingIdentity.rows[0]) {
      // Create auth identity linked to the user
      await (authService as any).createAuthIdentities([{
        provider_identities: [{
          provider: "emailpass",
          entity_id: email,
          provider_metadata: {},
        }],
        app_metadata: { user_id: userId },
      }])
    }

    // Now set the password
    const { success: s2, error: e2 } = await authService.updateProvider("emailpass", {
      entity_id: email,
      password,
    })

    if (s2) {
      return res.status(200).json({ success: true })
    }
    return res.status(400).json({ message: e2 || "Failed to set password" })

  } catch (createErr: unknown) {
    console.error("[set-user-password] error:", createErr)
    return res.status(500).json({
      message: createErr instanceof Error ? createErr.message : "Failed to create user",
    })
  }
}
