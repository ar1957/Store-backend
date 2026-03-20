import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * GET /store/carts/current-id
 * Returns the current cart ID from the _medusa_cart_id cookie
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const cartId = req.cookies?.["_medusa_cart_id"]

    if (!cartId) {
      return res.status(404).json({ cartId: null, message: "No cart cookie found" })
    }

    return res.json({ cartId })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}