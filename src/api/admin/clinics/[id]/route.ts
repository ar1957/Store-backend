import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"
const PROVIDER_INTEGRATION_MODULE = "providerIntegration"

// GET /admin/clinics/:id
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const svc = req.scope.resolve(CLINIC_MODULE) as any
    const clinicOpsService = req.scope.resolve(PROVIDER_INTEGRATION_MODULE) as any
    
    const clinic = await svc.getClinicById(req.params.id)
    if (!clinic) return res.status(404).json({ message: "Clinic not found" })

    // Fetch associated UI configuration using the clinic's slug/name
    const uiConfig = await clinicOpsService.getUiConfigByTenant(clinic.slug || clinic.name)

    return res.json({ 
      clinic,
      clinic_ui_config: uiConfig 
    })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

// POST /admin/clinics/:id — update clinic & UI config
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const clinicOpsService = req.scope.resolve(PROVIDER_INTEGRATION_MODULE) as any
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
          sets.push(`"${key}" = ?::text[]`)
        } else {
          sets.push(`"${key}" = ?`)
        }
        values.push(body[key])
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

    // 2. Handle UI Configuration Upsert
    const uiFields = ["nav_links", "footer_links", "logo_url", "get_started_url"]
    const hasUiUpdates = uiFields.some(field => field in body)

    let updatedUiConfig = null
    const tenantDomain = updatedClinic.slug || updatedClinic.name

    if (hasUiUpdates) {
      updatedUiConfig = await clinicOpsService.upsertUiConfig({
        tenant_domain: tenantDomain,
        nav_links: body.nav_links,
        footer_links: body.footer_links,
        logo_url: body.logo_url,
        get_started_url: body.get_started_url
      })
    } else {
      updatedUiConfig = await clinicOpsService.getUiConfigByTenant(tenantDomain)
    }

    return res.json({ 
      clinic: updatedClinic,
      clinic_ui_config: updatedUiConfig
    })
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