import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * POST /admin/orders/:orderId/md-review
 * Medical Director approves or denies a deferred order
 *
 * Body: { decision: "approve" | "deny", notes?: string, mdUserId?: string }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pgConnection = req.scope.resolve("__pg_connection__") as any
    const { orderId } = req.params
    const body = req.body as any
    const { decision, notes, mdUserId } = body

    if (!decision || !["approve", "deny"].includes(decision)) {
      return res.status(400).json({ message: "decision must be 'approve' or 'deny'" })
    }

    // Find the workflow record
    const existing = await pgConnection.raw(`
      SELECT * FROM order_workflow WHERE id = ? OR order_id = ?
    `, [orderId, orderId])

    if (!existing.rows.length) {
      return res.status(404).json({ message: "Order workflow not found" })
    }

    const workflow = existing.rows[0]

    if (workflow.status !== "pending_md_review") {
      return res.status(400).json({ message: `Order is not pending MD review (status: ${workflow.status})` })
    }

    const newStatus = decision === "approve" ? "processing_pharmacy" : "refund_pending"

    await pgConnection.raw(`
      UPDATE order_workflow
      SET
        status = ?,
        md_decision = ?,
        md_decided_at = NOW(),
        md_notes = ?,
        md_user_id = ?,
        updated_at = NOW()
      WHERE id = ?
    `, [newStatus, decision, notes || null, mdUserId || null, workflow.id])

    return res.json({
      success: true,
      newStatus,
      message: decision === "approve"
        ? "Order approved — moved to Processing by Pharmacy"
        : "Order denied — pending refund",
    })
  } catch (err: unknown) {
    console.error("MD review error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}