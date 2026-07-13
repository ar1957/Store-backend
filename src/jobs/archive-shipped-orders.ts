/**
 * Job: archive-old-orders
 * Runs daily at 2AM.
 * Sets archived_at on order_workflow rows that are:
 *   - shipped AND shipped_at > 30 days ago, OR
 *   - refund_issued AND refund_issued_at > 30 days ago
 */
import { MedusaContainer } from "@medusajs/framework"

export default async function archiveOldOrdersJob(container: MedusaContainer) {
  const logger = container.resolve("logger") as any
  const pg = container.resolve("__pg_connection__") as any

  logger.info("[ArchiveOldOrders] Starting daily archive job...")

  try {
    const result = await pg.raw(`
      UPDATE order_workflow
      SET archived_at = NOW(), updated_at = NOW()
      WHERE archived_at IS NULL
        AND deleted_at IS NULL
        AND (
          (status = 'shipped'
            AND shipped_at IS NOT NULL
            AND shipped_at < NOW() - INTERVAL '30 days')
          OR
          (status = 'refund_issued'
            AND refund_issued_at IS NOT NULL
            AND refund_issued_at < NOW() - INTERVAL '30 days')
        )
    `)

    const count = result.rowCount ?? 0
    logger.info(`[ArchiveOldOrders] Archived ${count} order(s)`)
  } catch (err: any) {
    logger.error(`[ArchiveOldOrders] Error: ${err.message}`)
  }
}

export const config = {
  name: "archive-old-orders",
  schedule: "0 2 * * *", // 2AM every day
}
