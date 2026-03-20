/**
 * GET  /admin/clinics/:id/orders/:orderId/comments
 * POST /admin/clinics/:id/orders/:orderId/comments
 * File: src/api/admin/clinics/[id]/orders/[orderId]/comments/route.ts
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { orderId } = req.params

    // Get order_workflow id from order_id
    const wf = await pg.raw(
      `SELECT id FROM order_workflow WHERE order_id = ? LIMIT 1`,
      [orderId]
    )
    if (!wf.rows.length) return res.json({ comments: [] })

    const result = await pg.raw(
      `SELECT * FROM order_comment 
       WHERE order_workflow_id = ? 
       ORDER BY created_at ASC`,
      [wf.rows[0].id]
    )
    return res.json({ comments: result.rows })
  } catch (err: any) {
    return res.status(500).json({ message: err.message })
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { orderId } = req.params
    const { comment, user_id, user_email, user_name, role } = req.body as any

    if (!comment?.trim()) return res.status(400).json({ message: "Comment is required" })

    // Get order_workflow id
    const wf = await pg.raw(
      `SELECT id FROM order_workflow WHERE order_id = ? LIMIT 1`,
      [orderId]
    )
    if (!wf.rows.length) return res.status(404).json({ message: "Order not found" })

    const id = `cmt_${Date.now()}`
    await pg.raw(
      `INSERT INTO order_comment 
       (id, order_workflow_id, user_id, user_email, user_name, role, comment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [id, wf.rows[0].id, user_id, user_email, user_name, role, comment.trim()]
    )

    return res.json({ success: true, id })
  } catch (err: any) {
    return res.status(500).json({ message: err.message })
  }
}