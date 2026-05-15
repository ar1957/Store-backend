import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * GET /store/clinics/locations
 * Returns active locations for the current clinic (identified by publishable key)
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    
    // Get publishable key from header
    const pubKey = req.headers["x-publishable-api-key"] as string
    if (!pubKey) {
      return res.json({ locations: [] })
    }

    // Find clinic by publishable key
    const clinicRes = await pg.raw(
      `SELECT id FROM clinic WHERE publishable_api_key = ? LIMIT 1`,
      [pubKey]
    )

    if (!clinicRes.rows.length) {
      return res.json({ locations: [] })
    }

    const clinicId = clinicRes.rows[0].id

    // Get active locations for this clinic
    const result = await pg.raw(
      `SELECT id, name, address, city, state, zip, phone
       FROM clinic_location
       WHERE clinic_id = ? AND is_active = true
       ORDER BY display_order ASC, name ASC`,
      [clinicId]
    )

    return res.json({ locations: result.rows })
  } catch (err: unknown) {
    console.error("[store/clinics/locations GET]", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
