/**
 * Order Canceled Subscriber
 * File: src/subscribers/order-canceled.ts
 *
 * Fires when Medusa's native order-cancel workflow runs (the "Cancel order"
 * action on the order detail page's "•••" menu — core Medusa UI, not this
 * codebase's own delete/cancel flow). That native workflow only touches
 * Medusa's own order/payment/inventory state — it never knows this project's
 * order_workflow table exists — so without this subscriber, canceling an
 * order there leaves order_workflow silently pointing at a live status
 * (e.g. "processing_pharmacy") while the underlying order is actually dead.
 *
 * Deliberately does NOT attempt any refund here — Medusa's native cancel
 * already ran its own (non-functional-for-real-money, see
 * [[project-order-delete-vs-cancel]]) refund attempt before this event
 * fires; re-refunding here would risk a double-refund. This subscriber only
 * syncs order_workflow.status so the clinic workflow view reflects reality.
 */
import { MedusaContainer } from "@medusajs/framework"

export default async function orderCanceledHandler({
  event,
  container,
}: {
  event: { data: { id: string } }
  container: MedusaContainer
}) {
  const logger = container.resolve("logger") as any
  const pg = container.resolve("__pg_connection__") as any
  const orderId = event.data.id

  try {
    const result = await pg.raw(
      `UPDATE order_workflow SET status = 'canceled', canceled_at = NOW(), updated_at = NOW()
       WHERE order_id = ? AND deleted_at IS NULL
       RETURNING id`,
      [orderId]
    )
    if (result.rows.length > 0) {
      logger.info(`[OrderCanceled] order_workflow ${result.rows[0].id} marked canceled for order ${orderId}`)
    }
    // No matching row is expected/harmless — e.g. an order with no clinic
    // workflow at all, or one whose workflow was already removed via this
    // codebase's own delete flow.
  } catch (err: any) {
    logger.error(`[OrderCanceled] Failed to sync order_workflow for order ${orderId}: ${err.message}`)
  }
}

export const config = {
  event: "order.canceled",
}
