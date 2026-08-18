/**
 * GET  /admin/order-workflow/missing  — scan (no side effects): lists orders
 *      that were paid for but never got an order_workflow row — e.g. because
 *      the order.placed event was lost (in-memory event bus with no
 *      durability across an instance restart between payment and processing).
 * POST /admin/order-workflow/missing  — recover: re-runs the same scan, then
 *      calls orderPlacedHandler directly (in-process, real subscriber logic,
 *      not a duplicate) for every order it finds.
 *
 * Deliberately does NOT re-emit the platform "order.placed" event —
 * email-notifications.ts also listens for it, and re-emitting would send
 * affected customers a duplicate order-confirmation email days later.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import orderPlacedHandler from "../../../../subscribers/order-placed"

// Mirrors order-placed.ts's own isPaid check: zero-total, or a payment
// session that actually completed (authorized/captured).
const FIND_MISSING_SQL = `
  SELECT o.id AS order_id, o.display_id, o.email, o.created_at
  FROM "order" o
  JOIN order_payment_collection opc ON opc.order_id = o.id
  JOIN payment_collection pc ON pc.id = opc.payment_collection_id
  LEFT JOIN LATERAL (
    SELECT status FROM payment_session WHERE payment_collection_id = pc.id ORDER BY created_at DESC LIMIT 1
  ) ps ON true
  LEFT JOIN order_workflow ow ON ow.order_id = o.id AND ow.deleted_at IS NULL
  WHERE o.deleted_at IS NULL
    AND o.is_draft_order = false
    AND ow.id IS NULL
    AND (COALESCE(pc.amount, 0) = 0 OR ps.status IN ('authorized', 'captured'))
  ORDER BY o.created_at DESC
  LIMIT 100
`

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const result = await pg.raw(FIND_MISSING_SQL)
    return res.json({ orders: result.rows })
  } catch (err: any) {
    return res.status(500).json({ message: err.message })
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const candidates = (await pg.raw(FIND_MISSING_SQL)).rows

    const results: any[] = []
    for (const row of candidates) {
      try {
        await orderPlacedHandler({ event: { data: { id: row.order_id } }, container: req.scope })
        const after = await pg.raw(`SELECT id, status FROM order_workflow WHERE order_id = ? LIMIT 1`, [row.order_id])
        if (after.rows.length > 0) {
          results.push({ order_id: row.order_id, display_id: row.display_id, success: true, status: after.rows[0].status })
        } else {
          results.push({ order_id: row.order_id, display_id: row.display_id, success: false, message: "Still no workflow after retry — check server logs (search [OrderPlaced]) for the specific error." })
        }
      } catch (e: any) {
        results.push({ order_id: row.order_id, display_id: row.display_id, success: false, message: e.message })
      }
    }

    return res.json({
      total: candidates.length,
      recovered: results.filter(r => r.success).length,
      results,
    })
  } catch (err: any) {
    return res.status(500).json({ message: err.message })
  }
}
