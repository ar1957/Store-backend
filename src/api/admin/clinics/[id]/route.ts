import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"

// GET /admin/clinics/:id
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const svc = req.scope.resolve(CLINIC_MODULE) as any
    const pg = req.scope.resolve("__pg_connection__") as any

    const clinic = await svc.getClinicById(req.params.id)
    if (!clinic) return res.status(404).json({ message: "Clinic not found" })

    const tenantDomain = clinic.domains?.[0] || clinic.slug
    const uiResult = await pg.raw(
      `SELECT * FROM clinic_ui_config WHERE clinic_id = ? OR tenant_domain = ? ORDER BY clinic_id NULLS LAST LIMIT 1`,
      [req.params.id, tenantDomain]
    )

    return res.json({ 
      clinic,
      clinic_ui_config: uiResult.rows[0] || null
    })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

// POST /admin/clinics/:id — update clinic core fields only
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId } = req.params
    const body = req.body as any

    if (body.api_client_secret?.startsWith("••••")) {
      delete body.api_client_secret
    }

    // 1. Handle Clinic Core Table Update
    const ALLOWED = [
      "name", "slug", "domains", "contact_email", "is_active",
      "logo_url", "brand_color", "api_client_id", "api_client_secret",
      "api_env", "api_base_url_test", "api_base_url_prod",
      "connect_env", "connect_url_test", "connect_url_prod",
      "redirect_url", "publishable_api_key", "sales_channel_id",
      "stripe_publishable_key", "stripe_secret_key", "pharmacy_staff_id",
    ]

    const sets: string[] = []
    const values: any[] = []
    for (const key of ALLOWED) {
      if (key in body) {
        if (key === "domains") {
          // Serialize JS array to PostgreSQL array literal: '{val1,val2}'
          const arr = Array.isArray(body[key]) ? body[key] : []
          const pgArray = `{${arr.map((v: string) => `"${String(v).replace(/"/g, '\\"')}"`).join(",")}}`
          sets.push(`"${key}" = ?::text[]`)
          values.push(pgArray)
        } else {
          sets.push(`"${key}" = ?`)
          values.push(body[key])
        }
      }
    }

    let updatedClinic;
    if (sets.length > 0) {
      sets.push(`updated_at = NOW()`)
      values.push(clinicId)
      const sql = `UPDATE clinic SET ${sets.join(", ")} WHERE id = ? RETURNING *`
      const result = await pg.raw(sql, values)
      updatedClinic = result.rows[0]
    } else {
      const current = await pg.raw(`SELECT * FROM clinic WHERE id = ? LIMIT 1`, [clinicId])
      updatedClinic = current.rows[0]
    }

    return res.json({ clinic: updatedClinic })
  } catch (err: unknown) {
    console.error("[Clinic Update] Error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

// DELETE /admin/clinics/:id
export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  try {
    const svc = req.scope.resolve(CLINIC_MODULE) as any
    await svc.deleteClinic(req.params.id)
    return res.json({ success: true })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}