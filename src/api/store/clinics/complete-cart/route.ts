import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { completeCartWorkflow } from "@medusajs/core-flows"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const { cartId } = req.body as any

    if (!cartId) {
      return res.status(400).json({ message: "cartId is required" })
    }

    const { result } = await completeCartWorkflow(req.scope).run({
      input: { id: cartId },
    })

    const r = result as any

    // completeCartWorkflow returns the order object directly (not wrapped).
    // The storefront expects { type: "order", order: { id, shipping_address, ... } }
    if (r?.id) {
      return res.json({ type: "order", order: r })
    }

    // Fallback — cart was not completed (e.g. payment still pending)
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
