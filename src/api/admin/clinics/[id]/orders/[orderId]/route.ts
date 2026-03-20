/**
 * GET  /admin/clinics/:id/orders
 * DELETE /admin/clinics/:id/orders/:orderId
 * File: src/api/admin/clinics/[id]/orders/route.ts
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId } = req.params
    const { status, limit = 50, offset = 0 } = req.query as any

    // Get clinic domains
    const clinicResult = await pg.raw(
      `SELECT domains FROM clinic WHERE id = ? LIMIT 1`,
      [clinicId]
    )
    if (!clinicResult.rows.length) {
      return res.status(404).json({ message: "Clinic not found" })
    }

    const domains = clinicResult.rows[0].domains || []

    let query = `
      SELECT 
        ow.id,
        ow.order_id,
        ow.status,
        ow.patient_id,
        ow.provider_name,
        ow.provider_status,
        ow.tracking_number,
        ow.carrier,
        ow.shipped_at,
        ow.md_decision,
        ow.md_notes,
        ow.treatment_dosages,
        ow.created_at,
        ow.updated_at,
        o.email as customer_email
      FROM order_workflow ow
      LEFT JOIN "order" o ON o.id = ow.order_id
      WHERE ow.tenant_domain = ANY(?)
    `
    const params: any[] = [domains]

    if (status) {
      query += ` AND ow.status = ?`
      params.push(status)
    }

    query += ` ORDER BY ow.created_at DESC LIMIT ? OFFSET ?`
    params.push(Number(limit), Number(offset))

    const result = await pg.raw(query, params)

    return res.json({ 
      orders: result.rows,
      count: result.rows.length
    })
  } catch (err: any) {
    console.error("[Orders GET] Error:", err)
    return res.status(500).json({ message: err.message })
  }
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { orderId } = req.params

    await pg.raw(
      `DELETE FROM order_workflow WHERE order_id = ?`,
      [orderId]
    )

    return res.json({ success: true })
  } catch (err: any) {
    console.error("[Orders DELETE] Error:", err)
    return res.status(500).json({ message: err.message })
  }
}