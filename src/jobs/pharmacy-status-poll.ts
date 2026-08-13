/**
 * Job: pharmacy-status-poll
 * Runs once a day (midnight server time).
 * Checks tracking/status for orders already submitted to DigitalRX or RMM.
 * RxVortex is webhook-driven and is skipped — see checkPharmacyStatuses().
 * The same logic also runs on-demand from the Clinic Orders "↻ Refresh"
 * button via POST /admin/pharmacy-status-poll.
 */
import { MedusaContainer } from "@medusajs/framework"
import { checkPharmacyStatuses } from "../api/admin/utils/pharmacy-status-check"

export default async function pharmacyStatusPollJob(container: MedusaContainer) {
  const logger = container.resolve("logger") as any
  const pg = container.resolve("__pg_connection__") as any

  logger.info("[PharmacyStatusPoll] Starting daily pharmacy status poll...")
  try {
    const { checked, updated, errors } = await checkPharmacyStatuses(pg, logger)
    logger.info(`[PharmacyStatusPoll] Done. Checked ${checked}, updated ${updated}, errors ${errors}.`)
  } catch (err: any) {
    logger.error("[PharmacyStatusPoll] Fatal error:", err.message)
  }
}

export const config = {
  name: "pharmacy-status-poll",
  schedule: "0 0 * * *",
}
