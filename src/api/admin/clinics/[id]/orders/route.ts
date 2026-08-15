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

    const salesChannelId = clinic.sales_channel_id || null
    const statusFilter = req.query.status as string | undefined

    // A user who is purely a pharmacist (every active staff row has that
    // role) only sees orders touching a pharmacy they're assigned to — fails
    // closed to zero orders if unassigned. Mixed-role users (e.g. clinic_admin
    // at one clinic, pharmacist at another) keep unscoped clinic-level access,
    // matching /admin/order-workflow's list-level filtering.
    let pharmacyIds: string[] = []
    let isPharmacistOnly = false
    const actorId = (req as any).session?.auth_context?.actor_id
    if (actorId) {
      const userResult = await pgConnection.raw(`SELECT email FROM "user" WHERE id = ? LIMIT 1`, [actorId])
      const userEmail = userResult.rows[0]?.email
      if (userEmail) {
        const staffResult = await pgConnection.raw(
          `SELECT id, role FROM clinic_staff WHERE email = ? AND is_active = true AND deleted_at IS NULL`,
          [userEmail]
        )
        const staffRows = staffResult.rows ?? []
        isPharmacistOnly = staffRows.length > 0 && staffRows.every((r: any) => r.role === "pharmacist")
        if (isPharmacistOnly) {
          const staffIds = staffRows.map((r: any) => r.id)
          const pharmacyResult = await pgConnection.raw(
            `SELECT DISTINCT clinic_pharmacy_id FROM clinic_staff_pharmacy WHERE clinic_staff_id = ANY(?)`,
            [staffIds]
          )
          pharmacyIds = (pharmacyResult.rows ?? []).map((r: any) => r.clinic_pharmacy_id)
          if (pharmacyIds.length === 0) return res.json({ orders: [] })
        }
      }
    }

    // Build WHERE: match by sales_channel_id (most reliable) OR tenant_domain
    const conditions: string[] = []
    const params: any[] = []

    if (salesChannelId) {
      conditions.push(`o.sales_channel_id = ?`)
      params.push(salesChannelId)
    }
    if (domains.length) {
      const placeholders = domains.map(() => "?").join(", ")
      conditions.push(`ow.tenant_domain IN (${placeholders})`)
      params.push(...domains)
    }

    if (!conditions.length) return res.json({ orders: [] })

    let query = `
      SELECT
        ow.id, ow.order_id, ow.tenant_domain, ow.gfe_id, ow.patient_id,
        ow.room_no, ow.virtual_room_url, ow.status,
        ow.provider_status, ow.provider_reviewed_at, ow.provider_name,
        ow.md_decision, ow.md_reviewed_at, ow.md_notes, ow.md_user_id,
        ow.tracking_number, ow.carrier, ow.shipped_at,
        ow.treatment_dosages,
        ow.refund_reason, ow.refunded_at,
        ow.pharmacy_queue_id, ow.pharmacy_status, ow.pharmacy_submitted_at,
        ow.pharmacy_submit_attempts, ow.pharmacy_last_error, ow.pharmacy_blocked_at,
        ow.location_id, ow.location_name,
        ow.created_at, ow.updated_at,
        o.display_id,
        COALESCE(oa.first_name, c.first_name, '') || ' ' || COALESCE(oa.last_name, c.last_name, '') AS patient_name,
        o.email AS patient_email
      FROM order_workflow ow
      LEFT JOIN "order" o        ON o.id = ow.order_id AND o.deleted_at IS NULL
      LEFT JOIN customer c       ON c.id = o.customer_id
      LEFT JOIN order_address oa ON oa.id = o.shipping_address_id
      WHERE (${conditions.join(" OR ")})
    `

    if (isPharmacistOnly) {
      query += ` AND (
        ow.clinic_pharmacy_id = ANY(?)
        OR EXISTS (
          SELECT 1 FROM pharmacy_sub_order pso
          WHERE pso.order_workflow_id = ow.id AND pso.clinic_pharmacy_id = ANY(?)
        )
      )`
      params.push(pharmacyIds, pharmacyIds)
    }

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