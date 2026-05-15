import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * POST /store/carts/location
 * Saves selected location to cart metadata
 * Body: { cartId, locationId, locationName }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { cartId, locationId, locationName } = req.body as any

    if (!cartId) {
      return res.status(400).json({ message: "cartId is required" })
    }

    if (!locationId || !locationName) {
      return res.status(400).json({ message: "locationId and locationName are required" })
    }

    // Get current cart metadata
    const cartRes = await pg.raw(
      `SELECT metadata FROM cart WHERE id = ? LIMIT 1`,
      [cartId]
    )

    if (!cartRes.rows.length) {
      return res.status(404).json({ message: "Cart not found" })
    }

    const currentMetadata = cartRes.rows[0].metadata || {}
    const updatedMetadata = {
      ...currentMetadata,
      location_id: locationId,
      location_name: locationName,
    }

    await pg.raw(
      `UPDATE cart SET metadata = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(updatedMetadata), cartId]
    )

    return res.json({ success: true })
  } catch (err: unknown) {
    console.error("[cart location POST]", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
