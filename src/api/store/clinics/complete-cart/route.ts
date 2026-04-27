import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { completeCartWorkflow } from "@medusajs/core-flows"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const { cartId } = req.body as any
    const pg = req.scope.resolve("__pg_connection__") as any

    if (!cartId) {
      return res.status(400).json({ message: "cartId is required" })
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
