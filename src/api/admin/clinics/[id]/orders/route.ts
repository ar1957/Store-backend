import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"

/**
 * GET /admin/clinics/:id/orders
 * Returns all orders for a clinic with their workflow status
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any
    const pgConnection = req.scope.resolve("__pg_connection__") as any

    const clinic = await clinicSvc.getClinicById(req.params.id)
    if (!clinic) return res.status(404).json({ message: "Clinic not found" })

    const domains: string[] = clinic.domains || []
    if (clinic.slug && !domains.includes(clinic.slug)) domains.push(clinic.slug)
    if (!domains.length) return res.json({ orders: [] })

    const statusFilter = req.query.status as string | undefined
    const placeholders = domains.map(() => "?").join(", ")

    let query = `
      SELECT
        ow.id, ow.order_id, ow.tenant_domain, ow.gfe_id, ow.patient_id,
        ow.room_no, ow.virtual_room_url, ow.status,
        ow.provider_status, ow.provider_reviewed_at, ow.provider_name,
        ow.md_decision, ow.md_reviewed_at, ow.md_notes, ow.md_user_id,
        ow.tracking_number, ow.carrier, ow.shipped_at,
        ow.treatment_dosages,
        ow.refund_reason, ow.refunded_at,
        ow.created_at, ow.updated_at,
        o.display_id,
        COALESCE(oa.first_name, c.first_name, '') || ' ' || COALESCE(oa.last_name, c.last_name, '') AS patient_name,
        o.email AS patient_email
      FROM order_workflow ow
      LEFT JOIN "order" o        ON o.id = ow.order_id AND o.deleted_at IS NULL
      LEFT JOIN customer c       ON c.id = o.customer_id
      LEFT JOIN order_address oa ON oa.id = o.shipping_address_id
      WHERE ow.tenant_domain IN (${placeholders})
    `
    const params: any[] = [...domains]

    if (statusFilter) {
      query += ` AND ow.status = ?`
      params.push(statusFilter)
    }

    query += ` ORDER BY ow.created_at DESC LIMIT 200`

    const result = await pgConnection.raw(query, params)
    return res.json({ orders: result.rows })
  } catch (err: unknown) {
    console.error("Orders GET error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

/**
 * DELETE /admin/clinics/:id/orders/:orderId
 */
export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pgConnection = req.scope.resolve("__pg_connection__") as any
    const { orderId } = req.params
    await pgConnection.raw(`DELETE FROM order_workflow WHERE order_id = ?`, [orderId])
    return res.json({ success: true })
  } catch (err: unknown) {
    console.error("Order delete error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}