/**
 * Job: pharmacy-poll
 * Runs every 5 minutes.
 * Auto-submits orders stuck in processing_pharmacy with no pharmacy_queue_id yet.
 * (Status-checking of already-submitted orders moved to the daily
 * `pharmacy-status-poll` job — see src/jobs/pharmacy-status-poll.ts — since
 * re-checking tracking for orders already in the pharmacy's hands doesn't
 * need to run every 5 minutes, unlike getting new orders submitted promptly.)
 */
import { MedusaContainer } from "@medusajs/framework"
import { submitToPharmacyIfEnabled } from "../api/admin/utils/pharmacy-submit"

// After this many failed auto-submit attempts, stop retrying and flag the
// order for manual review — a submission that fails repeatedly (missing
// catalog mapping, missing patient phone, etc.) will never succeed on its
// own, and retrying every 5 minutes just spams the pharmacy API and logs.
const MAX_PHARMACY_SUBMIT_ATTEMPTS = 5

export default async function pharmacyPollJob(container: MedusaContainer) {
  const logger = container.resolve("logger") as any
  const pg = container.resolve("__pg_connection__") as any

  logger.info("[PharmacyPoll] Starting pharmacy auto-submit poll...")

  try {
    const unsubmitted = await pg.raw(`
      SELECT
        ow.id AS workflow_id,
        ow.order_id,
        ow.treatment_dosages,
        ow.pharmacy_submit_attempts,
        c.id AS clinic_id
      FROM order_workflow ow
      JOIN clinic c ON (
        ow.tenant_domain = ANY(c.domains)
        OR ow.tenant_domain = ANY(SELECT split_part(d, ':', 1) FROM unnest(c.domains) AS d)
      )
      WHERE ow.status = 'processing_pharmacy'
        AND ow.pharmacy_queue_id IS NULL
        AND ow.pharmacy_blocked_at IS NULL
        AND ow.deleted_at IS NULL
        AND c.pharmacy_enabled = true
      LIMIT 50
    `)

    logger.info(`[PharmacyPoll] Found ${unsubmitted.rows.length} unsubmitted orders to auto-submit`)

    for (const row of unsubmitted.rows) {
      try {
        const dosages = typeof row.treatment_dosages === "string"
          ? JSON.parse(row.treatment_dosages || "[]")
          : (row.treatment_dosages || [])
        await submitToPharmacyIfEnabled(pg, row.clinic_id, row.order_id, row.workflow_id, dosages)
        logger.info(`[PharmacyPoll] Auto-submitted order ${row.order_id}`)
      } catch (err: any) {
        const attempts = (row.pharmacy_submit_attempts || 0) + 1
        logger.error(`[PharmacyPoll] Auto-submit error for order ${row.order_id} (attempt ${attempts}/${MAX_PHARMACY_SUBMIT_ATTEMPTS}): ${err.message}`)

        if (attempts >= MAX_PHARMACY_SUBMIT_ATTEMPTS) {
          await pg.raw(
            `UPDATE order_workflow
             SET pharmacy_submit_attempts = ?, pharmacy_last_error = ?, pharmacy_blocked_at = NOW(), updated_at = NOW()
             WHERE id = ?`,
            [attempts, err.message, row.workflow_id]
          )
          logger.error(`[PharmacyPoll] Order ${row.order_id} blocked after ${attempts} failed auto-submit attempts — needs manual review.`)
        } else {
          await pg.raw(
            `UPDATE order_workflow
             SET pharmacy_submit_attempts = ?, pharmacy_last_error = ?, updated_at = NOW()
             WHERE id = ?`,
            [attempts, err.message, row.workflow_id]
          )
        }
      }
    }

    logger.info("[PharmacyPoll] Done.")
  } catch (err: any) {
    logger.error("[PharmacyPoll] Fatal error:", err.message)
  }
}

export const config = {
  name: "pharmacy-poll",
  schedule: "*/5 * * * *",
}
