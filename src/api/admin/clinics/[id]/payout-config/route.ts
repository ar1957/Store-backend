import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * GET /admin/clinics/:id/payout-config
 * Returns bank details for clinic and pharmacy vendors.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id } = req.params
    const result = await pg.raw(
      `SELECT * FROM vendor_payout_config WHERE clinic_id = ? LIMIT 1`, [id]
    )
    return res.json({ config: result.rows[0] || null })
  } catch (err: unknown) {
    console.error("[payout-config GET]", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

/**
 * POST /admin/clinics/:id/payout-config
 * Upserts bank details for both vendors. No split percent — amounts come from product costs.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id } = req.params
    const {
      clinic_name = "",
      clinic_bank_routing, clinic_bank_account, clinic_bank_name, clinic_account_name,
      pharmacy_name = "",
      pharmacy_bank_routing, pharmacy_bank_account, pharmacy_bank_name, pharmacy_account_name,
      notes,
    } = req.body as any

    const configId = `vpc_${id}`
    await pg.raw(`
      INSERT INTO vendor_payout_config (
        id, clinic_id,
        clinic_name, clinic_bank_routing, clinic_bank_account, clinic_bank_name, clinic_account_name,
        pharmacy_name, pharmacy_bank_routing, pharmacy_bank_account, pharmacy_bank_name, pharmacy_account_name,
        notes, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
      ON CONFLICT (clinic_id) DO UPDATE SET
        clinic_name           = EXCLUDED.clinic_name,
        clinic_bank_routing   = EXCLUDED.clinic_bank_routing,
        clinic_bank_account   = EXCLUDED.clinic_bank_account,
        clinic_bank_name      = EXCLUDED.clinic_bank_name,
        clinic_account_name   = EXCLUDED.clinic_account_name,
        pharmacy_name         = EXCLUDED.pharmacy_name,
        pharmacy_bank_routing = EXCLUDED.pharmacy_bank_routing,
        pharmacy_bank_account = EXCLUDED.pharmacy_bank_account,
        pharmacy_bank_name    = EXCLUDED.pharmacy_bank_name,
        pharmacy_account_name = EXCLUDED.pharmacy_account_name,
        notes                 = EXCLUDED.notes,
        updated_at            = NOW()
    `, [
      configId, id,
      clinic_name,
      clinic_bank_routing || null, clinic_bank_account || null,
      clinic_bank_name || null, clinic_account_name || null,
      pharmacy_name,
      pharmacy_bank_routing || null, pharmacy_bank_account || null,
      pharmacy_bank_name || null, pharmacy_account_name || null,
      notes || null,
    ])

    const saved = await pg.raw(
      `SELECT * FROM vendor_payout_config WHERE clinic_id = ? LIMIT 1`, [id]
    )
    return res.json({ config: saved.rows[0] })
  } catch (err: unknown) {
    console.error("[payout-config POST]", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
