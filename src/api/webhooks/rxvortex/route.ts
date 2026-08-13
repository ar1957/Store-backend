/**
 * POST /webhooks/rxvortex
 *
 * Receives real-time status updates from RxVortex (Strive) pharmacy.
 * RxVortex sends a webhook payload whenever an order status changes.
 * Docs: https://docs.rxvortex.net/guides/webhooks/
 *
 * The payload includes:
 *   - sender_order_id  — our rxNumber (e.g. "RX-12345-987654"), or for a
 *                        split order one of its per-split IDs (e.g. "RX-12345-987654-S2")
 *   - trackingnumber   — shipping tracking number (when shipped)
 *   - rxstatus         — verbose status from Strive
 *   - external_status  — simplified status (in_progress, fulfilled, completed, cancelled)
 *   - shippingcarrier  — carrier name (e.g. FEDEX, UPS)
 *   - shipmenttrackingurl — full tracking URL
 *
 * Split orders each get their own sender_order_id, so each ships/updates
 * independently — this matches against pharmacy_sub_order first (the
 * per-order source of truth going forward) and only falls back to the
 * legacy single order_workflow.pharmacy_queue_id match for orders submitted
 * before pharmacy_sub_order existed. order_workflow.status only flips to
 * 'shipped' once every sub-order for that order has a tracking number.
 *
 * This route lives outside /store and /admin on purpose: Medusa mounts its
 * publishable-API-key requirement unconditionally on the entire /store
 * namespace with no per-route opt-out, so a webhook endpoint under /store
 * can never be reached by an external caller that doesn't send that key.
 * Security instead relies on the secret URL path (add IP allowlisting in
 * nginx/ALB if desired for additional protection) — RxVortex does not sign
 * payloads.
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

    const newStatus = rxStatus || externalStatus

    // ── Try matching a pharmacy_sub_order first (covers both split and
    // non-split orders submitted after this table was introduced) ──────────
    const subResult = await pg.raw(
      `SELECT id, order_workflow_id FROM pharmacy_sub_order WHERE pharmacy_queue_id = ? LIMIT 1`,
      [senderOrderId]
    )

    if (subResult.rows.length > 0) {
      const subOrder = subResult.rows[0]
      console.log(`[RxVortexWebhook] Matched pharmacy_sub_order ${subOrder.id} (workflow ${subOrder.order_workflow_id})`)

      if (trackingNumber) {
        await pg.raw(
          `UPDATE pharmacy_sub_order
           SET tracking_number = ?, carrier = ?, shipped_at = NOW(), pharmacy_status = ?,
               pharmacy_status_check_response = ?::jsonb, pharmacy_status_check_source = 'webhook',
               pharmacy_status_checked_at = NOW(), updated_at = NOW()
           WHERE id = ?`,
          [trackingNumber, carrier.toUpperCase(), newStatus, JSON.stringify(body), subOrder.id]
        )
        console.log(`[RxVortexWebhook] Sub-order ${subOrder.id} shipped. Tracking: ${trackingNumber} via ${carrier}`)
      } else if (newStatus) {
        await pg.raw(
          `UPDATE pharmacy_sub_order
           SET pharmacy_status = ?,
               pharmacy_status_check_response = ?::jsonb, pharmacy_status_check_source = 'webhook',
               pharmacy_status_checked_at = NOW(), updated_at = NOW()
           WHERE id = ?`,
          [newStatus, JSON.stringify(body), subOrder.id]
        )
        console.log(`[RxVortexWebhook] Sub-order ${subOrder.id} status updated to: ${newStatus}`)
      }

      // Roll up: order_workflow only moves to 'shipped' once every sub-order
      // for this order has shipped.
      const rollup = await pg.raw(
        `SELECT COUNT(*) AS total, COUNT(tracking_number) AS shipped_count,
                MAX(tracking_number) AS last_tracking, MAX(carrier) AS last_carrier
         FROM pharmacy_sub_order WHERE order_workflow_id = ?`,
        [subOrder.order_workflow_id]
      )
      const { total, shipped_count, last_tracking, last_carrier } = rollup.rows[0]

      if (Number(total) > 0 && Number(shipped_count) === Number(total)) {
        // Single sub-order case: also mirror onto order_workflow's legacy
        // columns so old display code / emails keep working unchanged. For a
        // genuine multi-split order, a single tracking_number would be
        // misleading, so leave those columns null — pharmacy_sub_order is
        // the real source of truth for per-shipment tracking.
        if (Number(total) === 1) {
          await pg.raw(
            `UPDATE order_workflow
             SET status = 'shipped', tracking_number = ?, carrier = ?, shipped_at = NOW(), updated_at = NOW()
             WHERE id = ?`,
            [last_tracking, last_carrier, subOrder.order_workflow_id]
          )
        } else {
          await pg.raw(
            `UPDATE order_workflow SET status = 'shipped', updated_at = NOW() WHERE id = ?`,
            [subOrder.order_workflow_id]
          )
        }
        console.log(`[RxVortexWebhook] All ${total} sub-order(s) shipped for workflow ${subOrder.order_workflow_id} — marked shipped.`)
      }

      return res.status(200).json({ received: true })
    }

    // ── Legacy fallback: orders submitted before pharmacy_sub_order existed ──
    const wfResult = await pg.raw(
      `SELECT id, order_id, status FROM order_workflow
       WHERE pharmacy_queue_id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [senderOrderId]
    )

    if (wfResult.rows.length === 0) {
      console.warn(`[RxVortexWebhook] No pharmacy_sub_order or order_workflow found for sender_order_id: ${senderOrderId}`)
      return res.status(200).json({ received: true })
    }

    const workflow = wfResult.rows[0]
    console.log(`[RxVortexWebhook] Matched workflow ${workflow.id} for order ${workflow.order_id} (legacy match)`)

    try {
      await pg.raw(
        `UPDATE order_workflow
         SET pharmacy_status_check_response = ?::jsonb,
             pharmacy_status_check_source = 'webhook',
             pharmacy_status_checked_at = NOW()
         WHERE id = ?`,
        [JSON.stringify(body), workflow.id]
      )
    } catch (logErr: any) {
      console.error(`[RxVortexWebhook] Failed to persist status-check log:`, logErr.message)
    }

    if (trackingNumber && workflow.status !== "shipped") {
      await pg.raw(
        `UPDATE order_workflow
         SET status = 'shipped', tracking_number = ?, carrier = ?, shipped_at = NOW(), pharmacy_status = ?, updated_at = NOW()
         WHERE id = ?`,
        [trackingNumber, carrier.toUpperCase(), newStatus, workflow.id]
      )
      console.log(`[RxVortexWebhook] Order ${workflow.order_id} marked shipped. Tracking: ${trackingNumber} via ${carrier}`)
    } else if (newStatus) {
      await pg.raw(
        `UPDATE order_workflow SET pharmacy_status = ?, updated_at = NOW() WHERE id = ?`,
        [newStatus, workflow.id]
      )
      console.log(`[RxVortexWebhook] Order ${workflow.order_id} status updated to: ${newStatus}`)
    }

    // RxVortex expects a 2xx response to acknowledge receipt
    return res.status(200).json({ received: true })
  } catch (err: any) {
    console.error(`[RxVortexWebhook] Error processing webhook:`, err.message)
    // Return 200 anyway so RxVortex doesn't keep retrying
    return res.status(200).json({ received: true, error: err.message })
  }
}
