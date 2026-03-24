import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * GET /admin/my-role
 * Returns the current user's role in a single DB query.
 * Used by admin widgets instead of the slow N+1 clinic/staff loop.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const actorId = (req.session as any)?.auth_context?.actor_id
    if (!actorId) return res.status(401).json({ role: "super_admin" })

    const userResult = await pg.raw(
      `SELECT email FROM "user" WHERE id = ? LIMIT 1`,
      [actorId]
    )
    const email = userResult.rows[0]?.email
    if (!email) return res.json({ role: "super_admin" })

    const staffResult = await pg.raw(
      `SELECT cs.role, cs.tenant_domain, c.name as clinic_name, c.id as clinic_id
       FROM clinic_staff cs
       JOIN clinic c ON c.id = cs.clinic_id
       WHERE cs.email = ?
         AND cs.is_active = true
         AND cs.deleted_at IS NULL
         AND c.deleted_at IS NULL
       LIMIT 1`,
      [email]
    )

    if (!staffResult.rows.length) {
      return res.json({ role: "super_admin", email })
    }

    const row = staffResult.rows[0]
    return res.json({
      role: row.role,
      email,
      clinicId: row.clinic_id,
      clinicName: row.clinic_name,
      tenantDomain: row.tenant_domain,
    })
  } catch (err: any) {
    console.error("[my-role] error:", err)
    return res.json({ role: "super_admin" })
  }
}
