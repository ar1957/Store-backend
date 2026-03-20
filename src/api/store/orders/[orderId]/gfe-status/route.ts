import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * GET /store/orders/:orderId/gfe-status
 * Returns virtualRoomUrl once GFE has been created for an order
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pgConnection = req.scope.resolve("__pg_connection__") as any
    const { orderId } = req.params

    // Check order_workflow for this order
    const result = await pgConnection.raw(`
      SELECT gfe_id, virtual_room_url, status
      FROM order_workflow
      WHERE order_id = ?
      LIMIT 1
    `, [orderId])

    if (!result.rows.length) {
      // Also check order metadata directly
      const orderResult = await pgConnection.raw(`
        SELECT metadata FROM "order" WHERE id = ?
      `, [orderId])

      const metadata = orderResult.rows[0]?.metadata || {}
      if (metadata.virtualRoomUrl) {
        return res.json({
          virtualRoomUrl: metadata.virtualRoomUrl,
          gfeId: metadata.gfeId,
          status: metadata.workflowStatus || "pending_provider",
        })
      }

      return res.json({ virtualRoomUrl: null })
    }

    const row = result.rows[0]
    return res.json({
      virtualRoomUrl: row.virtual_room_url,
      gfeId: row.gfe_id,
      status: row.status,
    })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}