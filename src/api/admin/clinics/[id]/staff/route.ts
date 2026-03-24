import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"

// GET /admin/clinics/:id/staff
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any
    const pgConnection = req.scope.resolve("__pg_connection__") as any

    const clinic = await clinicSvc.getClinicById(req.params.id)
    if (!clinic) return res.status(404).json({ message: "Clinic not found" })

    const tenantDomain = clinic.domains?.[0] || clinic.slug

    const result = await pgConnection.raw(`
      SELECT id, tenant_domain, user_id, email, full_name, role, is_active, created_at
      FROM clinic_staff
      WHERE tenant_domain = ? AND is_active = true
      ORDER BY created_at DESC
    `, [tenantDomain])

    return res.json({ staff: result.rows })
  } catch (err: unknown) {
    console.error("Staff GET error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

// POST /admin/clinics/:id/staff
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any
    const pgConnection = req.scope.resolve("__pg_connection__") as any
    const userService = req.scope.resolve("user") as any

    const clinic = await clinicSvc.getClinicById(req.params.id)
    if (!clinic) return res.status(404).json({ message: "Clinic not found" })

    const tenantDomain = clinic.domains?.[0] || clinic.slug
    const body = req.body as any
    const id = `staff_${Date.now()}`

    // Ensure a Medusa user record exists for this email
    const existing = await pgConnection.raw(
      `SELECT id FROM "user" WHERE email = ? LIMIT 1`,
      [body.email]
    )
    if (!existing.rows[0]) {
      await userService.createUsers({ email: body.email })
    }

    await pgConnection.raw(`
      INSERT INTO clinic_staff (id, tenant_domain, user_id, email, full_name, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, true, NOW(), NOW())
    `, [id, tenantDomain, body.email, body.email, body.full_name || "", body.role])

    return res.json({ member: { id, tenant_domain: tenantDomain, email: body.email, full_name: body.full_name, role: body.role } })
  } catch (err: unknown) {
    console.error("Staff POST error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}