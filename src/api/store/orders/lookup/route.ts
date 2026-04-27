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
    // Include both with-port and without-port variants of every domain
    const allowedDomains: string[] = []
    for (const d of (clinic.domains || [])) {
      allowedDomains.push(d)
      allowedDomains.push(d.split(":")[0])
    }
    if (clinic.slug) allowedDomains.push(clinic.slug)
    if (domain && !allowedDomains.includes(domain)) allowedDomains.push(domain)

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
          ow.pharmacy_queue_id,
          ow.pharmacy_status,
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
          ow.pharmacy_queue_id,
          ow.pharmacy_status,
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
      pending_pharmacy:    "Being Prepared by Pharmacy",
      shipped:             "Medication Shipped",
      refund_pending:      "Refund Processing",
      refunded:            "Refund Issued",
    }

    const orders = orderRows.map(row => {
      // Pharmacy-aware status label
      let statusLabel = statusLabels[row.status] || row.status || "Pending"
      if (row.status === "processing_pharmacy" && row.pharmacy_queue_id) {
        statusLabel = row.pharmacy_status
          ? `Order Received by Pharmacy (${row.pharmacy_status})`
          : "Order Received by Pharmacy"
      }
      // For pending_pharmacy orders, gfe_id is null — use workflow_id so the status page link works
      const statusPageId = row.gfe_id || row.workflow_id
      return {
        orderId: row.order_id,
        gfeId: statusPageId,
        status: row.status || "pending_provider",
        statusLabel,
        providerName: row.provider_name,
        virtualRoomUrl: row.virtual_room_url || null,
        pharmacyQueueId: row.pharmacy_queue_id || null,
        pharmacyStatus: row.pharmacy_status || null,
        tracking: row.tracking_number ? {
          trackingNumber: row.tracking_number,
          carrier: row.carrier,
          shippedAt: row.shipped_at,
        } : null,
        createdAt: row.created_at,
      }
    })

    return res.json({ orders })
  } catch (err: unknown) {
    console.error("Order lookup error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}