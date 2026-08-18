/**
 * POST /admin/orders/:orderId/recover-workflow
 *
 * Manually re-runs order-placed.ts's logic for a single order that has no
 * order_workflow row at all — e.g. because the order.placed event was lost
 * (in-memory event bus with no durability across an instance restart between
 * payment and processing — see [[project-*-event-bus]] memory).
 *
 * Calls the real subscriber handler directly, in-process, so this can never
 * drift out of sync with the actual order-placement logic. Deliberately does
 * NOT re-emit the platform "order.placed" event — email-notifications.ts also
 * listens for it, and re-emitting would send the customer a duplicate
 * order-confirmation email days after the fact.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import orderPlacedHandler from "../../../../../subscribers/order-placed"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { orderId } = req.params

    const existing = await pg.raw(
      `SELECT id FROM order_workflow WHERE order_id = ? LIMIT 1`,
      [orderId]
    )
    if (existing.rows.length > 0) {
      return res.status(400).json({
        message: "This order already has a workflow — nothing to recover.",
        workflowId: existing.rows[0].id,
      })
    }

    await orderPlacedHandler({
      event: { data: { id: orderId } },
      container: req.scope,
    })

    const after = await pg.raw(
      `SELECT id, status, gfe_id FROM order_workflow WHERE order_id = ? LIMIT 1`,
      [orderId]
    )
    if (after.rows.length > 0) {
      return res.json({ success: true, workflow: after.rows[0] })
    }
    return res.status(500).json({
      success: false,
      message: "Still no workflow after retry — check server logs (search for [OrderPlaced]) for the specific error: clinic lookup, patient creation, or GFE creation failure.",
    })
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message })
  }
}
