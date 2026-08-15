import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * GET /admin/clinics/:id/staff/:staffId/pharmacies — which pharmacies a
 *     pharmacist can see orders for (clinic_staff_pharmacy join table)
 * PUT /admin/clinics/:id/staff/:staffId/pharmacies — replace the full
 *     assignment set in one call (simplest correct semantics for a
 *     multi-select "these are the pharmacies this person can see" control)
 */

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const result = await pg.raw(
      `SELECT clinic_pharmacy_id FROM clinic_staff_pharmacy WHERE clinic_staff_id = ?`,
      [req.params.staffId]
    )
    return res.json({ pharmacy_ids: result.rows.map((r: any) => r.clinic_pharmacy_id) })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

export async function PUT(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { staffId } = req.params
    const ids: string[] = Array.isArray((req.body as any)?.clinic_pharmacy_ids)
      ? (req.body as any).clinic_pharmacy_ids
      : []

    await pg.raw(`DELETE FROM clinic_staff_pharmacy WHERE clinic_staff_id = ?`, [staffId])

    for (const pharmacyId of ids) {
      await pg.raw(
        `INSERT INTO clinic_staff_pharmacy (id, clinic_staff_id, clinic_pharmacy_id, created_at)
         VALUES (?, ?, ?, NOW())
         ON CONFLICT (clinic_staff_id, clinic_pharmacy_id) DO NOTHING`,
        [`csp_${Date.now()}_${pharmacyId}`, staffId, pharmacyId]
      )
    }

    return res.json({ success: true })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
