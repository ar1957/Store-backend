/**
 * Job: pharmacy-poll
 * Runs every 5 minutes.
 * 1. Auto-submits orders stuck in processing_pharmacy with no pharmacy_queue_id yet.
 * 2. Polls status of already-submitted orders and updates tracking when shipped.
 * Handles both DigitalRX (SmartConnect) and RMM (RequestMyMeds) pharmacies.
 */
import { MedusaContainer } from "@medusajs/framework"
import { submitToPharmacyIfEnabled } from "../api/admin/utils/pharmacy-submit"

export default async function pharmacyPollJob(container: MedusaContainer) {
  const logger = container.resolve("logger") as any
  const pg = container.resolve("__pg_connection__") as any

  logger.info("[PharmacyPoll] Starting pharmacy status poll...")

  try {
    // ── Step 1: Auto-submit orders not yet sent to pharmacy ──────────────────
    const unsubmitted = await pg.raw(`
      SELECT
        ow.id AS workflow_id,
        ow.order_id,
        ow.treatment_dosages,
        c.id AS clinic_id
      FROM order_workflow ow
      JOIN clinic c ON (
        ow.tenant_domain = ANY(c.domains)
        OR ow.tenant_domain = ANY(SELECT split_part(d, ':', 1) FROM unnest(c.domains) AS d)
      )
      WHERE ow.status = 'processing_pharmacy'
        AND ow.pharmacy_queue_id IS NULL
        AND ow.deleted_at IS NULL
        AND c.pharmacy_enabled = true
      LIMIT 50
    `)

    logger.info(`[PharmacyPoll] Found ${unsubmitted.rows.length} unsubmitted orders to auto-submit`)

    for (const row of unsubmitted.rows) {
      try {
        const dosages = typeof row.treatment_dosages === "string"
          ? JSON.parse(row.treatment_dosages || "[]")
          : (row.treatment_dosages || [])
        await submitToPharmacyIfEnabled(pg, row.clinic_id, row.order_id, row.workflow_id, dosages)
        logger.info(`[PharmacyPoll] Auto-submitted order ${row.order_id}`)
      } catch (err: any) {
        logger.error(`[PharmacyPoll] Auto-submit error for order ${row.order_id}: ${err.message}`)
      }
    }

    // ── Step 2: Poll status of already-submitted orders ──────────────────────
    const submitted = await pg.raw(`
      SELECT
        ow.id AS workflow_id,
        ow.order_id,
        ow.pharmacy_queue_id,
        ow.pharmacy_status,
        ow.tenant_domain,
        c.pharmacy_type,
        c.pharmacy_api_url,
        c.pharmacy_api_key,
        c.pharmacy_store_id,
        c.pharmacy_username,
        c.pharmacy_password
      FROM order_workflow ow
      JOIN clinic c ON (
        ow.tenant_domain = ANY(c.domains)
        OR ow.tenant_domain = ANY(SELECT split_part(d, ':', 1) FROM unnest(c.domains) AS d)
      )
      WHERE ow.pharmacy_queue_id IS NOT NULL
        AND ow.status = 'processing_pharmacy'
        AND ow.tracking_number IS NULL
        AND ow.deleted_at IS NULL
      LIMIT 50
    `)

    logger.info(`[PharmacyPoll] Found ${submitted.rows.length} submitted orders to status-check`)

    for (const order of submitted.rows) {
      try {
        if (order.pharmacy_type === "rmm") {
          await pollRmm(pg, logger, order)
        } else {
          await pollDigitalRx(pg, logger, order)
        }
      } catch (err: any) {
        logger.error(`[PharmacyPoll] Error checking order ${order.order_id}: ${err.message}`)
      }
    }

    logger.info("[PharmacyPoll] Done.")
  } catch (err: any) {
    logger.error("[PharmacyPoll] Fatal error:", err.message)
  }
}

// ── DigitalRX (SmartConnect) ─────────────────────────────────────────────────

async function pollDigitalRx(pg: any, logger: any, order: any) {
  if (!order.pharmacy_api_key || !order.pharmacy_store_id) return

  const apiUrl = (order.pharmacy_api_url || "https://www.dbswebserver.com/DBSRestApi/API").replace(/\/$/, "")
  const res = await fetch(`${apiUrl}/RxRequestStatus`, {
    method: "POST",
    headers: {
      "Authorization": order.pharmacy_api_key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      StoreID: order.pharmacy_store_id,
      QueueID: order.pharmacy_queue_id,
    }),
  })

  if (!res.ok) {
    logger.warn(`[PharmacyPoll][DigitalRX] Status check failed for QueueID=${order.pharmacy_queue_id}: ${res.status}`)
    return
  }

  const text = await res.text()
  if (!text || text.trim() === "") {
    // Sandbox or no-status-yet — normal, just wait
    logger.info(`[PharmacyPoll][DigitalRX] QueueID=${order.pharmacy_queue_id}: no status yet (empty response)`)
    return
  }

  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    logger.warn(`[PharmacyPoll][DigitalRX] QueueID=${order.pharmacy_queue_id}: non-JSON response: ${text.slice(0, 100)}`)
    return
  }

  // Status endpoint returns an array of prescription records
  const records = Array.isArray(data) ? data : [data]
  const record = records[0] || {}

  // Field is "Trackingnumber" (lowercase n) per API docs
  const trackingNumber = record.Trackingnumber || record.TrackingNumber
  const billingStatus = record.BillingStatus || ""
  const packDateTime = record.approveddated || record.PackDateTime

  logger.info(`[PharmacyPoll][DigitalRX] QueueID=${order.pharmacy_queue_id} status=${billingStatus} tracking=${trackingNumber || "none"}`)

  if (trackingNumber) {
    await pg.raw(`
      UPDATE order_workflow
      SET status = 'shipped', tracking_number = ?, carrier = 'UPS',
          shipped_at = ?, pharmacy_status = ?, updated_at = NOW()
      WHERE id = ?
    `, [trackingNumber, packDateTime || new Date().toISOString(), billingStatus, order.workflow_id])
    logger.info(`[PharmacyPoll][DigitalRX] Order ${order.order_id} shipped. Tracking: ${trackingNumber}`)
  } else if (billingStatus) {
    await pg.raw(`UPDATE order_workflow SET pharmacy_status = ?, updated_at = NOW() WHERE id = ?`, [billingStatus, order.workflow_id])
  }
}

// ── RMM (RequestMyMeds) ──────────────────────────────────────────────────────

async function getRmmToken(baseUrl: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/getJWTkey`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) throw new Error(`RMM auth failed: ${res.status}`)
  const data = await res.json()
  if (!data.token) throw new Error("No token returned from RMM")
  return data.token
}

async function pollRmm(pg: any, logger: any, order: any) {
  if (!order.pharmacy_username || !order.pharmacy_password) return

  const baseUrl = (order.pharmacy_api_url || "https://requestmymeds.net/api/v2").replace(/\/$/, "")
  const token = await getRmmToken(baseUrl, order.pharmacy_username, order.pharmacy_password)

  const res = await fetch(`${baseUrl}/prescriptions/${encodeURIComponent(order.pharmacy_queue_id)}`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
  })

  if (!res.ok) {
    logger.warn(`[PharmacyPoll][RMM] Status check failed for rx_unique_id=${order.pharmacy_queue_id}: ${res.status}`)
    return
  }

  const data = await res.json()
  const rmmStatus: string = data.status || ""
  const trackingNumber: string | null = data.tracking_number || null

  logger.info(`[PharmacyPoll][RMM] rx_unique_id=${order.pharmacy_queue_id} status=${rmmStatus} tracking=${trackingNumber || "none"}`)

  if (trackingNumber) {
    await pg.raw(`
      UPDATE order_workflow
      SET status = 'shipped', tracking_number = ?, carrier = 'UPS',
          shipped_at = NOW(), pharmacy_status = ?, updated_at = NOW()
      WHERE id = ?
    `, [trackingNumber, rmmStatus, order.workflow_id])
    logger.info(`[PharmacyPoll][RMM] Order ${order.order_id} shipped. Tracking: ${trackingNumber}`)
  } else if (rmmStatus && rmmStatus !== order.pharmacy_status) {
    await pg.raw(`UPDATE order_workflow SET pharmacy_status = ?, updated_at = NOW() WHERE id = ?`, [rmmStatus, order.workflow_id])
    logger.info(`[PharmacyPoll][RMM] Order ${order.order_id} status updated to: ${rmmStatus}`)
  }
}

export const config = {
  name: "pharmacy-poll",
  schedule: "*/5 * * * *",
}
