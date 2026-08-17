/**
 * src/scripts/recover-order-workflow.ts
 *
 * One-off recovery for an order whose order_workflow row was never created —
 * the order.placed event either never fired or was lost (in-memory event
 * bus + instance replacement between the order's payment and this recovery),
 * so GFE/patient creation never ran and the order is invisible in Clinic
 * Orders (that list INNER JOINs order_workflow).
 *
 * Calls orderPlacedHandler directly with the real container — reuses the
 * exact same tested logic (clinic lookup, patient + GFE creation, workflow
 * row creation) rather than duplicating it. Deliberately does NOT re-emit
 * the real "order.placed" event through the event bus, since
 * email-notifications.ts also listens for it and would send the customer a
 * duplicate order-confirmation email.
 *
 * SAFETY: re-verifies order_workflow is still empty for this order right
 * before running, so this is safe to abort if someone else already fixed it.
 * This WILL create a real patient + GFE in the MHC provider system if the
 * order has eligibility data — review the ORDER_ID below before running.
 *
 * Usage (on the server, via medusa exec):
 *   npx medusa exec src/scripts/recover-order-workflow.ts
 */
import { ExecArgs } from "@medusajs/framework/types"
import orderPlacedHandler from "../subscribers/order-placed"

const ORDER_ID = "order_01M04A8QG4V1WJ3QQTZ4BMV9VK"

export default async function recoverOrderWorkflow({ container }: ExecArgs) {
  const logger = container.resolve("logger") as any
  const pg = container.resolve("__pg_connection__") as any

  const existing = await pg.raw(
    `SELECT id FROM order_workflow WHERE order_id = ? LIMIT 1`,
    [ORDER_ID]
  )
  if (existing.rows.length > 0) {
    logger.info(`[Recover] Order ${ORDER_ID} already has an order_workflow row (${existing.rows[0].id}) — nothing to do, aborting.`)
    return
  }

  logger.info(`[Recover] No order_workflow found for ${ORDER_ID} — replaying order-placed logic directly (bypassing the event bus)...`)

  await orderPlacedHandler({
    event: { data: { id: ORDER_ID } },
    container,
  })

  const after = await pg.raw(
    `SELECT id, status, gfe_id FROM order_workflow WHERE order_id = ? LIMIT 1`,
    [ORDER_ID]
  )
  if (after.rows.length > 0) {
    logger.info(`[Recover] Success — order_workflow ${after.rows[0].id} created, status=${after.rows[0].status}, gfe_id=${after.rows[0].gfe_id || "(none)"}`)
  } else {
    logger.error(`[Recover] Still no order_workflow row after replay — check the logs just above this line for the actual error (clinic lookup / patient creation / GFE creation failure).`)
  }
}
