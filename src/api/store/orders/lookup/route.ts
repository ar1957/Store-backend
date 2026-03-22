import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * GET /store/orders/lookup?email=...&orderId=...
 * Patient self-service order lookup — scoped to the requesting clinic's tenant domain
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pgConnection = req.scope.resolve("__pg_connection__") as any
    const clinicSvc = req.scope.resolve("clinic") as any
    const { email, orderId } = req.query as { email?: string; orderId?: string }

    if (!email && !orderId) {
      return res.status(400).json({ message: "Provide an email or order ID" })
    }

    // Resolve tenant — only return orders belonging to this clinic
    const host = (
      req.headers["x-forwarded-host"] ||
      req.headers["x-tenant-domain"] ||
      req.headers["host"] ||
      ""
    ) as string
    const domain = host.split(":")[0]
    const clinic = await clinicSvc.getClinicByDomain(host) || await clinicSvc.getClinicByDomain(domain)

    if (!clinic) {
      return res.status(404).json({ message: "No orders found" })
    }

    // Scope by sales_channel_id (most reliable) or fall back to domain matching
    const salesChannelId = clinic.sales_channel_id
    const allowedDomains: string[] = clinic?.domains ?? []
    if (clinic.slug) allowedDomains.push(clinic.slug)

    let orderRows: any[] = []

    if (orderId) {
      const result = await pgConnection.raw(`
        SELECT
          o.id as order_id,
          o.email,
          o.metadata,
          ow.id as workflow_id,
          ow.gfe_id,
          ow.status,
          ow.virtual_room_url,
          ow.provider_name,
          ow.tracking_number,
          ow.carrier,
          ow.shipped_at,
          ow.created_at
        FROM "order" o
        LEFT JOIN order_workflow ow ON ow.order_id = o.id
        WHERE (o.id = ? OR o.display_id::text = ?)
          AND (
            o.sales_channel_id = ?
            OR ow.tenant_domain = ANY(?)
            OR o.metadata->>'tenant_domain' = ANY(?)
          )
        LIMIT 10
      `, [orderId, orderId, salesChannelId, allowedDomains, allowedDomains])
      orderRows = result.rows
    } else if (email) {
      const result = await pgConnection.raw(`
        SELECT
          o.id as order_id,
          o.email,
          o.metadata,
          ow.id as workflow_id,
          ow.gfe_id,
          ow.status,
          ow.virtual_room_url,
          ow.provider_name,
          ow.tracking_number,
          ow.carrier,
          ow.shipped_at,
          ow.created_at
        FROM "order" o
        LEFT JOIN order_workflow ow ON ow.order_id = o.id
        WHERE LOWER(o.email) = LOWER(?)
          AND (
            o.sales_channel_id = ?
            OR ow.tenant_domain = ANY(?)
            OR o.metadata->>'tenant_domain' = ANY(?)
          )
        ORDER BY o.created_at DESC
        LIMIT 20
      `, [email, salesChannelId, allowedDomains, allowedDomains])
      orderRows = result.rows
    }

    if (!orderRows.length) {
      console.log(`[Order Lookup] No orders found. clinic=${clinic.id} sales_channel=${salesChannelId} domains=${JSON.stringify(allowedDomains)} query=${JSON.stringify({ email, orderId })}`)
      return res.status(404).json({ message: "No orders found" })
    }

    const statusLabels: Record<string, string> = {
      pending_provider:    "Pending Provider Clearance",
      pending_md_review:   "Pending Physician Review",
      processing_pharmacy: "Processing by Pharmacy",
      shipped:             "Medication Shipped",
      refund_pending:      "Refund Processing",
      refunded:            "Refund Issued",
    }

    const orders = orderRows.map(row => ({
      orderId: row.order_id,
      gfeId: row.gfe_id,
      status: row.status || "pending_provider",
      statusLabel: statusLabels[row.status] || row.status || "Pending",
      providerName: row.provider_name,
      virtualRoomUrl: row.virtual_room_url || null,
      tracking: row.tracking_number ? {
        trackingNumber: row.tracking_number,
        carrier: row.carrier,
        shippedAt: row.shipped_at,
      } : null,
      createdAt: row.created_at,
    }))

    return res.json({ orders })
  } catch (err: unknown) {
    console.error("Order lookup error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}