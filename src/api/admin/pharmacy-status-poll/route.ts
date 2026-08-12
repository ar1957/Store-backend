import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { checkPharmacyStatuses } from "../utils/pharmacy-status-check"

/**
 * POST /admin/pharmacy-status-poll
 * On-demand pharmacy status refresh — same logic as the daily cron job
 * (src/jobs/pharmacy-status-poll.ts). Called by the "Refresh" button on the
 * Clinic Orders page, alongside /admin/gfe-poll.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const logger = req.scope.resolve("logger") as any
    const pg = req.scope.resolve("__pg_connection__") as any

    const result = await checkPharmacyStatuses(pg, logger)

    res.json(result)
  } catch (err: any) {
    console.error("[PharmacyStatusPoll] Error:", err.message)
    res.status(500).json({ error: err.message })
  }
}
