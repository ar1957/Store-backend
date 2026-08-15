import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * GET  /admin/clinics/:id/pharmacies — list every pharmacy configured for a clinic
 * POST /admin/clinics/:id/pharmacies — add a new pharmacy
 *
 * A clinic can have multiple pharmacies (clinic_pharmacy table) — each
 * product routes to one via product_treatment_map.clinic_pharmacy_id,
 * falling back to whichever row here has is_default = true.
 */

const PHARMACY_FIELDS = [
  "name", "pharmacy_type", "is_enabled", "is_default",
  "pharmacy_api_url", "pharmacy_api_key", "pharmacy_store_id", "pharmacy_vendor_name",
  "pharmacy_doctor_first_name", "pharmacy_doctor_last_name", "pharmacy_doctor_npi",
  "pharmacy_username", "pharmacy_password", "pharmacy_prescriber_id", "pharmacy_prescriber_address",
  "pharmacy_prescriber_city", "pharmacy_prescriber_state", "pharmacy_prescriber_zip",
  "pharmacy_prescriber_phone", "pharmacy_prescriber_dea", "pharmacy_ship_type", "pharmacy_ship_rate", "pharmacy_pay_type",
  "pharmacy_client_id", "pharmacy_client_secret", "pharmacy_subdomain", "pharmacy_preset_catalog_id",
]

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const result = await pg.raw(
      `SELECT * FROM clinic_pharmacy WHERE clinic_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, created_at ASC`,
      [req.params.id]
    )
    // Mask the secret so it doesn't leak in plaintext to the browser — same
    // pattern as GET /admin/clinics/:id.
    const pharmacies = result.rows.map((raw: any) => ({
      ...raw,
      pharmacy_client_secret: raw.pharmacy_client_secret
        ? "••••••••" + raw.pharmacy_client_secret.slice(-4)
        : null,
    }))
    return res.json({ pharmacies })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const clinicId = req.params.id
    const body = req.body as any

    if (!body.name?.trim()) {
      return res.status(400).json({ message: "Pharmacy name is required" })
    }
    if (!body.pharmacy_type) {
      return res.status(400).json({ message: "Pharmacy type is required" })
    }

    const id = `cph_${Date.now()}`

    // If this is the clinic's first pharmacy, or the caller explicitly asked,
    // make it the default. Only one default per clinic.
    const existingResult = await pg.raw(
      `SELECT COUNT(*) AS count FROM clinic_pharmacy WHERE clinic_id = ? AND deleted_at IS NULL`,
      [clinicId]
    )
    const isFirst = Number(existingResult.rows[0]?.count || 0) === 0
    const isDefault = isFirst || body.is_default === true

    if (isDefault) {
      await pg.raw(
        `UPDATE clinic_pharmacy SET is_default = false, updated_at = NOW() WHERE clinic_id = ? AND deleted_at IS NULL`,
        [clinicId]
      )
    }

    const columns = ["id", "clinic_id"]
    const placeholders = ["?", "?"]
    const values: any[] = [id, clinicId]
    for (const key of PHARMACY_FIELDS) {
      if (key === "is_default") continue // handled above
      if (key in body) {
        columns.push(`"${key}"`)
        placeholders.push("?")
        values.push(body[key])
      }
    }
    columns.push(`"is_default"`)
    placeholders.push("?")
    values.push(isDefault)

    await pg.raw(
      `INSERT INTO clinic_pharmacy (${columns.join(", ")}, created_at, updated_at)
       VALUES (${placeholders.join(", ")}, NOW(), NOW())`,
      values
    )

    return res.json({ success: true, id })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
