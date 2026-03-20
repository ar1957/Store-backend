import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * POST /admin/orders/:orderId/ship
 * Pharmacist marks order as shipped and provides tracking number
 *
 * Body: { trackingNumber: string, carrier: string, pharmacistUserId?: string }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pgConnection = req.scope.resolve("__pg_connection__") as any
    const { orderId } = req.params
    const body = req.body as any
    const { trackingNumber, carrier, pharmacistUserId } = body

    if (!trackingNumber) {
      return res.status(400).json({ message: "trackingNumber is required" })
    }
    if (!carrier) {
      return res.status(400).json({ message: "carrier is required" })
    }

    // Find the workflow record
    const existing = await pgConnection.raw(`
      SELECT * FROM order_workflow WHERE id = ? OR order_id = ?
    `, [orderId, orderId])

    if (!existing.rows.length) {
      return res.status(404).json({ message: "Order workflow not found" })
    }

    const workflow = existing.rows[0]

    if (workflow.status !== "processing_pharmacy") {
      return res.status(400).json({ message: `Order is not in pharmacy processing (status: ${workflow.status})` })
    }

    await pgConnection.raw(`
      UPDATE order_workflow
      SET
        status = 'shipped',
        pharmacy_tracking_number = ?,
        pharmacy_carrier = ?,
        pharmacy_shipped_at = NOW(),
        pharmacy_staff_id = ?,
        updated_at = NOW()
      WHERE id = ?
    `, [trackingNumber, carrier, pharmacistUserId || null, workflow.id])

    return res.json({
      success: true,
      newStatus: "shipped",
      trackingNumber,
      carrier,
      message: "Order marked as shipped — Medication Shipped",
    })
  } catch (err: unknown) {
    console.error("Ship order error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}