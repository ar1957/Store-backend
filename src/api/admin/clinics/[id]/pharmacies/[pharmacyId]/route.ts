import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const PHARMACY_FIELDS = [
  "name", "pharmacy_type", "is_enabled", "is_default",
  "pharmacy_api_url", "pharmacy_api_key", "pharmacy_store_id", "pharmacy_vendor_name",
  "pharmacy_doctor_first_name", "pharmacy_doctor_last_name", "pharmacy_doctor_npi",
  "pharmacy_username", "pharmacy_password", "pharmacy_prescriber_id", "pharmacy_prescriber_address",
  "pharmacy_prescriber_city", "pharmacy_prescriber_state", "pharmacy_prescriber_zip",
  "pharmacy_prescriber_phone", "pharmacy_prescriber_dea", "pharmacy_ship_type", "pharmacy_ship_rate", "pharmacy_pay_type",
  "pharmacy_client_id", "pharmacy_client_secret", "pharmacy_subdomain", "pharmacy_preset_catalog_id",
]

// PUT /admin/clinics/:id/pharmacies/:pharmacyId — update one pharmacy
export async function PUT(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId, pharmacyId } = req.params
    const body = req.body as any

    // Unchanged masked secret ("••••••••xxxx") must not overwrite the real one.
    if (body.pharmacy_client_secret?.startsWith("••••")) {
      delete body.pharmacy_client_secret
    }

    if (body.is_default === true) {
      await pg.raw(
        `UPDATE clinic_pharmacy SET is_default = false, updated_at = NOW() WHERE clinic_id = ? AND id != ? AND deleted_at IS NULL`,
        [clinicId, pharmacyId]
      )
    }

    const sets: string[] = []
    const values: any[] = []
    for (const key of PHARMACY_FIELDS) {
      if (key in body) {
        sets.push(`"${key}" = ?`)
        values.push(body[key])
      }
    }
    if (sets.length === 0) {
      return res.status(400).json({ message: "No fields to update" })
    }
    sets.push(`"updated_at" = NOW()`)
    values.push(clinicId, pharmacyId)

    await pg.raw(
      `UPDATE clinic_pharmacy SET ${sets.join(", ")} WHERE clinic_id = ? AND id = ? AND deleted_at IS NULL`,
      values
    )

    return res.json({ success: true })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

// DELETE /admin/clinics/:id/pharmacies/:pharmacyId — soft delete
export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId, pharmacyId } = req.params

    const row = await pg.raw(
      `SELECT is_default FROM clinic_pharmacy WHERE clinic_id = ? AND id = ? AND deleted_at IS NULL`,
      [clinicId, pharmacyId]
    )
    if (!row.rows.length) return res.status(404).json({ message: "Pharmacy not found" })

    await pg.raw(
      `UPDATE clinic_pharmacy SET deleted_at = NOW(), updated_at = NOW() WHERE id = ?`,
      [pharmacyId]
    )

    // If the default pharmacy was deleted, promote whichever remains (oldest
    // first) so product_treatment_map fallback resolution never dead-ends.
    if (row.rows[0].is_default) {
      await pg.raw(
        `UPDATE clinic_pharmacy SET is_default = true, updated_at = NOW()
         WHERE id = (
           SELECT id FROM clinic_pharmacy
           WHERE clinic_id = ? AND deleted_at IS NULL
           ORDER BY created_at ASC LIMIT 1
         )`,
        [clinicId]
      )
    }

    return res.json({ success: true })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
