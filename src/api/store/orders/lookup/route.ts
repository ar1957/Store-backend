import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * GET /store/orders/lookup?email=...&orderId=...
 * Patient self-service order lookup — no auth required
 * Finds orders by email OR order ID, returns workflow statuses
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pgConnection = req.scope.resolve("__pg_connection__") as any
    const { email, orderId } = req.query as { email?: string; orderId?: string }

    if (!email && !orderId) {
      return res.status(400).json({ message: "Provide an email or order ID" })
    }

    let orderRows: any[] = []

    if (orderId) {
      // Lookup by order ID directly
      const result = await pgConnection.raw(`
        SELECT
          o.id as order_id,
          o.email,
          o.metadata,
          ow.id as workflow_id,
          ow.gfe_id,
          ow.status,
          ow.provider_name,
          ow.tracking_number,
          ow.carrier,
          ow.shipped_at,
          ow.created_at
        FROM "order" o
        LEFT JOIN order_workflow ow ON ow.order_id = o.id
        WHERE o.id = ? OR o.display_id::text = ?
        LIMIT 10
      `, [orderId, orderId])
      orderRows = result.rows
    } else if (email) {
      // Lookup by email — return all orders for this email
      const result = await pgConnection.raw(`
        SELECT
          o.id as order_id,
          o.email,
          o.metadata,
          ow.id as workflow_id,
          ow.gfe_id,
          ow.status,
          ow.provider_name,
          ow.tracking_number,
          ow.carrier,
          ow.shipped_at,
          ow.created_at
        FROM "order" o
        LEFT JOIN order_workflow ow ON ow.order_id = o.id
        WHERE LOWER(o.email) = LOWER(?)
        ORDER BY o.created_at DESC
        LIMIT 20
      `, [email])
      orderRows = result.rows
    }

    if (!orderRows.length) {
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