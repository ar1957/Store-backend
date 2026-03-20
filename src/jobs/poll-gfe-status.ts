/**
 * GFE Status Polling Job
 * File: src/jobs/poll-gfe-status.ts
 * Runs every 5 minutes — checks pending GFE orders and auto-advances status.
 */

import { MedusaContainer } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"

export const config = {
  name: "poll-gfe-status",
  schedule: "*/5 * * * *",
}

/**
 * Determine overall order outcome from all treatments:
 * - ANY deferred  → whole order deferred
 * - ALL approved  → approved
 * - otherwise     → still pending
 */
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

/**
 * Extract dosage info from treatments array for storage.
 * Stores: [{ treatmentId, treatmentName, dosage }]
 */
function extractDosages(treatments: any[]): { treatmentId: number; treatmentName: string; dosage: string | null }[] {
  return treatments.map((t: any) => ({
    treatmentId: t.treatmentId,
    treatmentName: t.name || "",
    dosage: t.dosage ?? null,
  }))
}

export default async function pollGfeStatus(container: MedusaContainer) {
  const logger = container.resolve("logger") as any
  const clinicSvc = container.resolve(CLINIC_MODULE) as any
  const pgConnection = container.resolve("__pg_connection__") as any

  logger.info("[GFE Poll] Starting GFE status poll...")

  try {
    const result = await pgConnection.raw(`
      SELECT id, tenant_domain, gfe_id, order_id
      FROM order_workflow
      WHERE status = 'pending_provider'
        AND gfe_id IS NOT NULL
      ORDER BY created_at ASC
      LIMIT 100
    `)

    const pending = result.rows
    logger.info(`[GFE Poll] Found ${pending.length} orders to check`)

    for (const row of pending) {
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

        if (!gfeRes.ok) {
          logger.warn(`[GFE Poll] Failed to get status for gfe_id=${row.gfe_id}: ${gfeRes.status}`)
          continue
        }

        const gfeData = await gfeRes.json()
        const payload = gfeData?.payload

        // Array payload = still Pending, skip
        if (Array.isArray(payload)) {
          logger.info(`[GFE Poll] gfe_id=${row.gfe_id} still Pending`)
          continue
        }

        const providerStatus = (payload?.status || "").toLowerCase()
        const treatments = payload?.treatments || []
        const providerName = payload?.providerName || null
        const outcome = determineTreatmentOutcome(treatments)
        const dosages = extractDosages(treatments)

        logger.info(`[GFE Poll] gfe_id=${row.gfe_id} providerStatus=${providerStatus} outcome=${outcome} treatments=${treatments.length}`)

        if (providerStatus === "completed") {
          if (outcome === "approved") {
            await pgConnection.raw(`
              UPDATE order_workflow
              SET status = 'processing_pharmacy',
                  provider_status = 'approved',
                  provider_name = ?,
                  provider_reviewed_at = NOW(),
                  treatment_dosages = ?::jsonb,
                  updated_at = NOW()
              WHERE id = ?
            `, [providerName, JSON.stringify(dosages), row.id])
            logger.info(`[GFE Poll] ✓ Order ${row.id} → processing_pharmacy (all treatments approved)`)

          } else if (outcome === "deferred") {
            await pgConnection.raw(`
              UPDATE order_workflow
              SET status = 'pending_md_review',
                  provider_status = 'deferred',
                  provider_name = ?,
                  provider_reviewed_at = NOW(),
                  treatment_dosages = ?::jsonb,
                  updated_at = NOW()
              WHERE id = ?
            `, [providerName, JSON.stringify(dosages), row.id])
            logger.info(`[GFE Poll] ↷ Order ${row.id} → pending_md_review (at least one treatment deferred)`)
          }
        }

      } catch (rowErr) {
        logger.error(`[GFE Poll] Error processing row ${row.id}:`, rowErr)
      }
    }

    logger.info("[GFE Poll] Done.")
  } catch (err) {
    logger.error("[GFE Poll] Job failed:", err)
  }
}