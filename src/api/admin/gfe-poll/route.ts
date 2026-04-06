import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { submitToPharmacyIfEnabled } from "../utils/pharmacy-submit"

/**
 * POST /admin/gfe-poll
 * On-demand GFE status refresh — same logic as the cron job.
 * Called by the "Refresh" button on the Clinic Orders page.
 */

const CLINIC_MODULE = "clinic"

function determineTreatmentOutcome(treatments: any[]): "approved" | "deferred" | "pending" {
  if (!treatments || treatments.length === 0) return "pending"
  const hasDefer = treatments.some((t: any) =>
    ["defer", "deferred"].includes((t.status || "").toLowerCase())
  )
  if (hasDefer) return "deferred"
  const allApproved = treatments.every((t: any) =>
    ["approve", "approved"].includes((t.status || "").toLowerCase())
  )
  if (allApproved) return "approved"
  return "pending"
}

function extractDosages(treatments: any[]) {
  return treatments.map((t: any) => ({
    treatmentId: t.treatmentId,
    treatmentName: t.name || "",
    dosage: t.dosage ?? null,
  }))
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any
    const pg = req.scope.resolve("__pg_connection__") as any

    const result = await pg.raw(`
      SELECT id, tenant_domain, gfe_id, order_id
      FROM order_workflow
      WHERE status = 'pending_provider'
        AND gfe_id IS NOT NULL
      ORDER BY created_at ASC
      LIMIT 100
    `)

    const pending = result.rows
    let updated = 0
    let checked = 0
    const errors: string[] = []

    for (const row of pending) {
      checked++
      try {
        const clinic = await clinicSvc.getClinicByDomain(row.tenant_domain)
        if (!clinic) continue

        const token = await clinicSvc.getToken(clinic.id)
        const baseUrl = clinic.api_env === "prod"
          ? clinic.api_base_url_prod
          : clinic.api_base_url_test

        const gfeRes = await fetch(`${baseUrl}/gfe/status/${row.gfe_id}`, {
          headers: { "Authorization": `Bearer ${token}` },
        })

        if (!gfeRes.ok) continue

        const gfeData = await gfeRes.json()
        const payload = gfeData?.payload

        // Array = still pending
        if (Array.isArray(payload)) continue

        const providerStatus = (payload?.status || "").toLowerCase()
        const treatments = payload?.treatments || []
        const providerName = payload?.providerName || null
        const outcome = determineTreatmentOutcome(treatments)
        const dosages = extractDosages(treatments)

        if (providerStatus === "completed") {
          if (outcome === "approved") {
            await pg.raw(`
              UPDATE order_workflow
              SET status = 'processing_pharmacy',
                  provider_status = 'approved',
                  provider_name = ?,
                  provider_reviewed_at = NOW(),
                  treatment_dosages = ?::jsonb,
                  updated_at = NOW()
              WHERE id = ?
            `, [providerName, JSON.stringify(dosages), row.id])
            updated++
            // Auto-submit to pharmacy API if enabled for this clinic
            const clinic = await clinicSvc.getClinicByDomain(row.tenant_domain)
            if (clinic) {
              submitToPharmacyIfEnabled(pg, clinic.id, row.order_id, row.id, dosages)
                .catch(e => console.error("[gfe-poll] Pharmacy submit error:", e.message))
            }
          } else if (outcome === "deferred") {
            await pg.raw(`
              UPDATE order_workflow
              SET status = 'pending_md_review',
                  provider_status = 'deferred',
                  provider_name = ?,
                  provider_reviewed_at = NOW(),
                  treatment_dosages = ?::jsonb,
                  updated_at = NOW()
              WHERE id = ?
            `, [providerName, JSON.stringify(dosages), row.id])
            updated++
          }
        }
      } catch (e: any) {
        errors.push(`gfe_id=${row.gfe_id}: ${e.message}`)
      }
    }

    return res.json({ checked, updated, errors })
  } catch (err: any) {
    console.error("[gfe-poll] Error:", err)
    return res.status(500).json({ message: err.message })
  }
}
