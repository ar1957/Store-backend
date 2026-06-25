/**
 * POST /store/webhooks/rxvortex
 *
 * Receives real-time status updates from RxVortex (Strive) pharmacy.
 * RxVortex sends a webhook payload whenever an order status changes.
 * Docs: https://docs.rxvortex.net/guides/webhooks/
 *
 * The payload includes:
 *   - sender_order_id  — our rxNumber (e.g. "RX-12345-987654")
 *   - trackingnumber   — shipping tracking number (when shipped)
 *   - rxstatus         — verbose status from Strive
 *   - external_status  — simplified status (in_progress, fulfilled, completed, cancelled)
 *   - shippingcarrier  — carrier name (e.g. FEDEX, UPS)
 *   - shipmenttrackingurl — full tracking URL
 *
 * This endpoint is intentionally unauthenticated (no Medusa JWT required).
 * RxVortex does not sign payloads; security relies on the secret URL path.
 * Add IP allowlisting in nginx/ALB if desired for additional protection.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const body = req.body as any

    console.log(`[RxVortexWebhook] Received payload:`, JSON.stringify(body))

    const senderOrderId: string = body.sender_order_id || ""
    const trackingNumber: string = body.trackingnumber || ""
    const rxStatus: string = body.rxstatus || ""
    const externalStatus: string = body.external_status || ""
    const carrier: string = body.shippingcarrier || "FEDEX"

    if (!senderOrderId) {
      console.warn(`[RxVortexWebhook] Missing sender_order_id — ignoring payload`)
      return res.status(200).json({ received: true })
    }

    const pg = (req as any).scope?.resolve("__pg_connection__")
    if (!pg) {
      console.error(`[RxVortexWebhook] Could not resolve pg connection`)
      return res.status(200).json({ received: true })
    }

    // Find the order_workflow where pharmacy_queue_id = our order_tracking_id
    // OR where the rxNumber (sender_order_id) is stored in pharmacy_queue_id
    const wfResult = await pg.raw(
      `SELECT id, order_id, status FROM order_workflow
       WHERE pharmacy_queue_id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [senderOrderId]
    )

    if (wfResult.rows.length === 0) {
      console.warn(`[RxVortexWebhook] No order_workflow found for sender_order_id: ${senderOrderId}`)
      return res.status(200).json({ received: true })
    }

    const workflow = wfResult.rows[0]
    console.log(`[RxVortexWebhook] Matched workflow ${workflow.id} for order ${workflow.order_id}`)

    // Determine if the order has shipped based on status values
    const isShipped = !!(trackingNumber) || rxStatus.toLowerCase().includes("fulfillment complete") ||
      rxStatus.toLowerCase().includes("shipping") || externalStatus === "fulfilled" || externalStatus === "completed"

    if (trackingNumber && workflow.status !== "shipped") {
      // Order shipped — update to shipped with tracking info
      await pg.raw(
        `UPDATE order_workflow
         SET status = 'shipped',
             tracking_number = ?,
             carrier = ?,
             shipped_at = NOW(),
             pharmacy_status = ?,
             updated_at = NOW()
         WHERE id = ?`,
        [trackingNumber, carrier.toUpperCase(), rxStatus || externalStatus, workflow.id]
      )
      console.log(`[RxVortexWebhook] Order ${workflow.order_id} marked shipped. Tracking: ${trackingNumber} via ${carrier}`)
    } else {
      // Status update only — update pharmacy_status
      const newStatus = rxStatus || externalStatus
      if (newStatus) {
        await pg.raw(
          `UPDATE order_workflow
           SET pharmacy_status = ?, updated_at = NOW()
           WHERE id = ?`,
          [newStatus, workflow.id]
        )
        console.log(`[RxVortexWebhook] Order ${workflow.order_id} status updated to: ${newStatus}`)
      }
    }

    // RxVortex expects a 2xx response to acknowledge receipt
    return res.status(200).json({ received: true })
  } catch (err: any) {
    console.error(`[RxVortexWebhook] Error processing webhook:`, err.message)
    // Return 200 anyway so RxVortex doesn't keep retrying
    return res.status(200).json({ received: true, error: err.message })
  }
}
