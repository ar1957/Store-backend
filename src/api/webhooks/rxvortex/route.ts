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
 *   - foreignrxnumber  — our sender_med_request_id; Strive sends one callback
 *                        PER medication_request, even within one order
 *
 * Matches against pharmacy_sub_order first (the per-order source of truth)
 * and only falls back to the legacy order_workflow.pharmacy_queue_id match
 * for orders submitted before pharmacy_sub_order existed. Per-rx callbacks
 * are stored in pharmacy_sub_order.rx_statuses and rolled up (see
 * aggregateRxStatuses). A sub-order gets its tracking number only once every
 * rx has shipped or been cancelled, and order_workflow.status only flips to
 * 'shipped' once every sub-order has a tracking number. (Orders placed under
 * the pre-2026-11 one-order-per-split scheme have "-S<n>" sender_order_ids
 * with one rx each, and still match the same way.)
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

// ── Per-rx status tracking ──────────────────────────────────────────────────
// One RxVortex order can hold several medication_requests (e.g. 2 months of
// a titration), and Strive sends a separate callback for each one. These are
// stored per rx in pharmacy_sub_order.rx_statuses, and the sub-order's own
// pharmacy_status / tracking_number are DERIVED from all of them — otherwise
// whichever callback arrived last would win and status could go backwards
// (e.g. month 1 "shipped" overwritten by a late month 2 "processing").

const ORDER_LEVEL_KEY = "_order"

interface RxStatusEntry {
  status: string | null
  external_status: string | null
  tracking_number: string | null
  carrier: string | null
  updated_at: string
}

function isCancelled(e: RxStatusEntry): boolean {
  return /cancel/i.test(e.external_status || "") || /cancel/i.test(e.status || "")
}

// Strive's simplified external_status: in_progress → fulfilled → completed.
// Unknown values rank lowest so they're surfaced rather than hidden.
function progressRank(e: RxStatusEntry): number {
  const s = (e.external_status || "").toLowerCase()
  if (s === "completed") return 3
  if (s === "fulfilled") return 2
  if (s === "in_progress") return 1
  return 0
}

// The sender_med_request_ids we actually submitted for this order.
function expectedRxIds(payload: any): string[] {
  const reqs = payload?.medication_requests
  if (!Array.isArray(reqs)) return []
  return reqs.map((r: any) => r?.sender_med_request_id).filter(Boolean)
}

function aggregateRxStatuses(
  rxStatuses: Record<string, RxStatusEntry>,
  expectedIds: string[]
): { status: string | null; trackingNumber: string | null; carrier: string | null } {
  const orderLevel = rxStatuses[ORDER_LEVEL_KEY] || null
  const ids = expectedIds.length > 0
    ? expectedIds
    : Object.keys(rxStatuses).filter(k => k !== ORDER_LEVEL_KEY)
  // An rx with no callback of its own falls back to any order-level update
  // (a callback without foreignrxnumber), which preserves the old behaviour
  // if Strive ever sends order-level callbacks.
  const perRx: (RxStatusEntry | null)[] = ids.length > 0
    ? ids.map(id => rxStatuses[id] || orderLevel)
    : [orderLevel]

  // Shipped only when EVERY rx has tracking or was cancelled, and at least
  // one actually shipped.
  const allDone = perRx.every(e => e && (e.tracking_number || isCancelled(e)))
  const shipped = perRx.find(e => e?.tracking_number) || null
  const trackingNumber = allDone && shipped ? shipped.tracking_number : null
  const carrier = trackingNumber ? (shipped?.carrier || null) : null

  // Displayed status = the least-progressed active rx, so the order never
  // looks further along than its slowest item.
  const reported = perRx.filter((e): e is RxStatusEntry => !!e)
  const active = reported.filter(e => !isCancelled(e))
  const cancelledCount = reported.length - active.length
  let status: string | null = null
  if (active.length > 0) {
    const slowest = active.reduce((a, b) => (progressRank(b) < progressRank(a) ? b : a))
    status = slowest.status || slowest.external_status || null
    if (status && cancelledCount > 0) {
      status = `${status} — ${cancelledCount} of ${perRx.length} items cancelled`
    }
  } else if (reported.length > 0) {
    status = reported[0].status || reported[0].external_status || null
  }
  return { status, trackingNumber, carrier }
}

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
      // Strive sends one callback per medication_request; foreignrxnumber is
      // our sender_med_request_id. Absent → treat as an order-level update.
      const rxKey: string = String(body.foreignrxnumber || body.foreignRxNumber || "").trim() || ORDER_LEVEL_KEY
      console.log(`[RxVortexWebhook] Matched pharmacy_sub_order ${subOrder.id} (workflow ${subOrder.order_workflow_id}) rx=${rxKey}`)

      // Row lock so two callbacks for different rx in the same order (they
      // tend to arrive together) can't overwrite each other's entry.
      await pg.transaction(async (trx: any) => {
        const locked = await trx.raw(
          `SELECT rx_statuses, pharmacy_submission_payload, tracking_number
           FROM pharmacy_sub_order WHERE id = ? FOR UPDATE`,
          [subOrder.id]
        )
        const row = locked.rows[0] || {}
        const rxStatuses: Record<string, RxStatusEntry> = { ...(row.rx_statuses || {}) }
        const prev = rxStatuses[rxKey] || ({} as RxStatusEntry)
        rxStatuses[rxKey] = {
          status: newStatus || prev.status || null,
          external_status: externalStatus || prev.external_status || null,
          tracking_number: trackingNumber || prev.tracking_number || null,
          carrier: trackingNumber ? carrier.toUpperCase() : (prev.carrier || null),
          updated_at: new Date().toISOString(),
        }

        const agg = aggregateRxStatuses(rxStatuses, expectedRxIds(row.pharmacy_submission_payload))
        // Tracking is only set once — when every rx in the order has shipped
        // (or been cancelled) — and never cleared/replaced afterwards.
        const setTracking = !row.tracking_number && agg.trackingNumber

        await trx.raw(
          `UPDATE pharmacy_sub_order
           SET rx_statuses = ?::jsonb,
               pharmacy_status = COALESCE(?, pharmacy_status),
               tracking_number = COALESCE(tracking_number, ?),
               carrier = CASE WHEN ? THEN ? ELSE carrier END,
               shipped_at = CASE WHEN ? THEN NOW() ELSE shipped_at END,
               pharmacy_status_check_response = ?::jsonb, pharmacy_status_check_source = 'webhook',
               pharmacy_status_checked_at = NOW(), updated_at = NOW()
           WHERE id = ?`,
          [
            JSON.stringify(rxStatuses),
            agg.status,
            setTracking ? agg.trackingNumber : null,
            !!setTracking, agg.carrier,
            !!setTracking,
            JSON.stringify(body),
            subOrder.id,
          ]
        )
        console.log(
          `[RxVortexWebhook] Sub-order ${subOrder.id} rx ${rxKey} → ${newStatus || "(no status)"}${trackingNumber ? ` tracking ${trackingNumber}` : ""}. ` +
          `Order status: ${agg.status || "(unchanged)"}${setTracking ? `; all rx shipped — tracking ${agg.trackingNumber}` : ""}`
        )
      })

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
