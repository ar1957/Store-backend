import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * POST /store/carts/eligibility-metadata
 * Saves eligibility answers to the current cart's metadata
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pgConnection = req.scope.resolve("__pg_connection__") as any
    const body = req.body as any
    const { eligibilityData, cartId: bodyCartId } = body

    if (!eligibilityData) {
      return res.status(400).json({ message: "eligibilityData is required" })
    }

    // Get cart ID from body first, then cookie, then header
    const cartId = bodyCartId
      || req.cookies?.["_medusa_cart_id"]
      || (req.headers["x-cart-id"] as string)

    if (!cartId) {
      return res.status(400).json({ message: "No cart found" })
    }

    // Update cart metadata with eligibility answers
    const existing = await pgConnection.raw(
      `SELECT metadata FROM cart WHERE id = ?`,
      [cartId]
    )

    if (!existing.rows.length) {
      return res.status(404).json({ message: "Cart not found" })
    }

    const currentMetadata = existing.rows[0].metadata || {}
    const updatedMetadata = {
      ...currentMetadata,
      eligibility: eligibilityData,
    }

    await pgConnection.raw(
      `UPDATE cart SET metadata = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(updatedMetadata), cartId]
    )

    return res.json({ success: true, cartId })
  } catch (err: unknown) {
    console.error("Eligibility metadata error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}