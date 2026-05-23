import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { completeCartWorkflow } from "@medusajs/core-flows"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const { cartId } = req.body as any
    const pg = req.scope.resolve("__pg_connection__") as any

    if (!cartId) {
      return res.status(400).json({ message: "cartId is required" })
    }

    // For zero-total carts (100% promo), a Stripe payment session may have been
    // created before the promo was applied. If it's still pending when the workflow
    // runs, Medusa will try to authorize it — failing for blocked Stripe accounts
    // and leaving the order as "not_paid". Delete pending sessions first so
    // completeCartWorkflow treats the order as fully covered and marks it "captured".
    try {
      const cartRow = await pg.raw(
        `SELECT total, payment_collection_id FROM cart WHERE id = ? LIMIT 1`,
        [cartId]
      )
      const row = cartRow.rows[0]
      if (row?.payment_collection_id && Number(row.total ?? -1) === 0) {
        const deleted = await pg.raw(
          `DELETE FROM payment_session
           WHERE payment_collection_id = ?
             AND status IN ('pending', 'requires_more')
           RETURNING id`,
          [row.payment_collection_id]
        )
        if (deleted.rows.length) {
          console.log(`[complete-cart] Removed ${deleted.rows.length} pending session(s) for zero-total cart ${cartId}`)
        }
      }
    } catch (preErr: any) {
      console.warn("[complete-cart] Pre-flight session clear failed (non-fatal):", preErr.message)
    }

    const { result } = await completeCartWorkflow(req.scope).run({
      input: { id: cartId },
    })

    const r = result as any
    console.log("[complete-cart] workflow result:", JSON.stringify(r))

    // completeCartWorkflow returns { id: orderId } — extract the order ID
    const orderId: string | null =
      r?.id ||                   // { id: "ord_xxx" } — normal path
      r?.order?.id ||            // { order: { id: "ord_xxx" } } — alternate shape
      null

    if (orderId) {
      return res.json({ type: "order", order: { id: orderId } })
    }

    // Fallback: result didn't carry an ID (can happen if the workflow compensated
    // or returned an unexpected shape). Query order_cart to find the created order.
    console.warn("[complete-cart] workflow result had no order ID — querying order_cart as fallback")
    try {
      const ocResult = await pg.raw(
        `SELECT order_id FROM order_cart WHERE cart_id = ? LIMIT 1`,
        [cartId]
      )
      if (ocResult.rows.length && ocResult.rows[0].order_id) {
        const foundId = ocResult.rows[0].order_id
        console.log("[complete-cart] found order via order_cart fallback:", foundId)
        return res.json({ type: "order", order: { id: foundId } })
      }
    } catch (fbErr) {
      console.error("[complete-cart] order_cart fallback query failed:", fbErr)
    }

    // Cart genuinely not completed yet
    return res.json({ type: "cart", cart: r })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Error"
    if (msg.includes("409") || msg.includes("already being completed") || msg.includes("conflicted")) {
      return res.status(409).json({ message: msg })
    }
    console.error("[complete-cart] error:", err)
    return res.status(500).json({ message: msg })
  }
}
