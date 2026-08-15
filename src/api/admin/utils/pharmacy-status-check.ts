/**
 * Pharmacy status-check logic — polls already-submitted orders for tracking
 * updates. Handles both DigitalRX (SmartConnect) and RMM (RequestMyMeds).
 * RxVortex is webhook-driven (Strive pushes updates to our webhook endpoint)
 * so it is intentionally skipped here regardless of caller.
 *
 * Shared by the daily `pharmacy-status-poll` cron job and the on-demand
 * "↻ Refresh" button on the Clinic Orders admin list (POST /admin/pharmacy-status-poll).
 */

async function saveStatusCheckLog(pg: any, workflowId: string, response: any) {
  try {
    await pg.raw(
      `UPDATE order_workflow
       SET pharmacy_status_check_response = ?::jsonb,
           pharmacy_status_check_source = 'api_poll',
           pharmacy_status_checked_at = NOW()
       WHERE id = ?`,
      [JSON.stringify(response ?? null), workflowId]
    )
  } catch (err: any) {
    console.error(`[PharmacyStatusCheck] Failed to persist status-check log for workflow ${workflowId}:`, err.message)
  }
}

// ── DigitalRX (SmartConnect) ─────────────────────────────────────────────────

async function pollDigitalRx(pg: any, logger: any, order: any): Promise<boolean> {
  if (!order.pharmacy_api_key || !order.pharmacy_store_id) return false

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
    logger.warn(`[PharmacyStatusCheck][DigitalRX] Status check failed for QueueID=${order.pharmacy_queue_id}: ${res.status}`)
    return false
  }

  const text = await res.text()
  if (!text || text.trim() === "") {
    logger.info(`[PharmacyStatusCheck][DigitalRX] QueueID=${order.pharmacy_queue_id}: no status yet (empty response)`)
    return false
  }

  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    logger.warn(`[PharmacyStatusCheck][DigitalRX] QueueID=${order.pharmacy_queue_id}: non-JSON response: ${text.slice(0, 100)}`)
    return false
  }

  await saveStatusCheckLog(pg, order.workflow_id, data)

  const records = Array.isArray(data) ? data : [data]
  const record = records[0] || {}

  const trackingNumber = record.Trackingnumber || record.TrackingNumber
  const billingStatus = record.BillingStatus || ""
  const packDateTime = record.approveddated || record.PackDateTime

  logger.info(`[PharmacyStatusCheck][DigitalRX] QueueID=${order.pharmacy_queue_id} status=${billingStatus} tracking=${trackingNumber || "none"}`)

  if (trackingNumber) {
    await pg.raw(`
      UPDATE order_workflow
      SET status = 'shipped', tracking_number = ?, carrier = 'UPS',
          shipped_at = ?, pharmacy_status = ?, updated_at = NOW()
      WHERE id = ?
    `, [trackingNumber, packDateTime || new Date().toISOString(), billingStatus, order.workflow_id])
    logger.info(`[PharmacyStatusCheck][DigitalRX] Order ${order.order_id} shipped. Tracking: ${trackingNumber}`)
    return true
  } else if (billingStatus && billingStatus !== order.pharmacy_status) {
    await pg.raw(`UPDATE order_workflow SET pharmacy_status = ?, updated_at = NOW() WHERE id = ?`, [billingStatus, order.workflow_id])
    return true
  }
  return false
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

async function pollRmm(pg: any, logger: any, order: any): Promise<boolean> {
  if (!order.pharmacy_username || !order.pharmacy_password) return false

  let updated = false
  const baseUrl = (order.pharmacy_api_url || "https://requestmymeds.net/api/v2").replace(/\/$/, "")
  const token = await getRmmToken(baseUrl, order.pharmacy_username, order.pharmacy_password)

  const subOrdersResult = await pg.raw(
    `SELECT id, split_index, pharmacy_queue_id, pharmacy_status
     FROM pharmacy_sub_order
     WHERE order_workflow_id = ? AND pharmacy_queue_id IS NOT NULL AND tracking_number IS NULL`,
    [order.workflow_id]
  )
  const subOrders = subOrdersResult.rows

  const toCheck = subOrders.length > 0
    ? subOrders.map((so: any) => ({ queueId: so.pharmacy_queue_id, subOrderId: so.id }))
    : [{ queueId: order.pharmacy_queue_id, subOrderId: null }]

  for (const { queueId, subOrderId } of toCheck) {
    if (!queueId) continue
    const res = await fetch(`${baseUrl}/prescriptions/${encodeURIComponent(queueId)}`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    })

    if (!res.ok) {
      logger.warn(`[PharmacyStatusCheck][RMM] Status check failed for rx_unique_id=${queueId}: ${res.status}`)
      continue
    }

    const data = await res.json()
    const rmmStatus: string = data.status || ""
    const trackingNumber: string | null = data.tracking_number || null

    logger.info(`[PharmacyStatusCheck][RMM] rx_unique_id=${queueId} status=${rmmStatus} tracking=${trackingNumber || "none"}`)

    if (subOrderId) {
      if (trackingNumber || (rmmStatus && rmmStatus !== order.pharmacy_status)) updated = true
      await pg.raw(
        `UPDATE pharmacy_sub_order
         SET tracking_number = ?, carrier = ?, shipped_at = ?, pharmacy_status = ?,
             pharmacy_status_check_response = ?::jsonb, pharmacy_status_check_source = 'api_poll',
             pharmacy_status_checked_at = NOW(), updated_at = NOW()
         WHERE id = ?`,
        [trackingNumber, trackingNumber ? "RMM" : null, trackingNumber ? new Date().toISOString() : null, rmmStatus, JSON.stringify(data), subOrderId]
      )
    } else {
      await saveStatusCheckLog(pg, order.workflow_id, data)
      if (trackingNumber) {
        await pg.raw(`
          UPDATE order_workflow
          SET status = 'shipped', tracking_number = ?, carrier = 'RMM',
              shipped_at = NOW(), pharmacy_status = ?, updated_at = NOW()
          WHERE id = ?
        `, [trackingNumber, rmmStatus, order.workflow_id])
        logger.info(`[PharmacyStatusCheck][RMM] Order ${order.order_id} shipped. Tracking: ${trackingNumber}`)
        updated = true
      } else if (rmmStatus && rmmStatus !== order.pharmacy_status) {
        await pg.raw(`UPDATE order_workflow SET pharmacy_status = ?, updated_at = NOW() WHERE id = ?`, [rmmStatus, order.workflow_id])
        logger.info(`[PharmacyStatusCheck][RMM] Order ${order.order_id} status updated to: ${rmmStatus}`)
        updated = true
      }
    }
  }

  // Roll up: order_workflow only moves to 'shipped' once every sub-order for
  // this order has shipped (mirrors the RxVortex webhook rollup).
  if (subOrders.length > 0) {
    const rollup = await pg.raw(
      `SELECT COUNT(*) AS total, COUNT(tracking_number) AS shipped_count,
              MAX(tracking_number) AS last_tracking
       FROM pharmacy_sub_order WHERE order_workflow_id = ?`,
      [order.workflow_id]
    )
    const { total, shipped_count, last_tracking } = rollup.rows[0]
    if (Number(total) > 0 && Number(shipped_count) === Number(total)) {
      if (Number(total) === 1) {
        await pg.raw(
          `UPDATE order_workflow SET status = 'shipped', tracking_number = ?, carrier = 'RMM', shipped_at = NOW(), updated_at = NOW() WHERE id = ?`,
          [last_tracking, order.workflow_id]
        )
      } else {
        await pg.raw(`UPDATE order_workflow SET status = 'shipped', updated_at = NOW() WHERE id = ?`, [order.workflow_id])
      }
      logger.info(`[PharmacyStatusCheck][RMM] All ${total} sub-order(s) shipped for workflow ${order.workflow_id} — marked shipped.`)
      updated = true
    }
  }

  return updated
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function checkPharmacyStatuses(pg: any, logger: any): Promise<{ checked: number; updated: number; errors: number }> {
  // Joins via order_workflow.clinic_pharmacy_id — the specific pharmacy this
  // order actually resolved to — rather than the clinic's legacy single
  // pharmacy_type column, which is wrong for any clinic using more than one
  // pharmacy type at once (e.g. RMM for one product, RxVortex for another).
  const submitted = await pg.raw(`
    SELECT
      ow.id AS workflow_id,
      ow.order_id,
      ow.pharmacy_queue_id,
      ow.pharmacy_status,
      ow.tenant_domain,
      cp.pharmacy_type,
      cp.pharmacy_api_url,
      cp.pharmacy_api_key,
      cp.pharmacy_store_id,
      cp.pharmacy_username,
      cp.pharmacy_password
    FROM order_workflow ow
    LEFT JOIN clinic_pharmacy cp ON cp.id = ow.clinic_pharmacy_id AND cp.deleted_at IS NULL
    WHERE ow.pharmacy_queue_id IS NOT NULL
      AND ow.status = 'processing_pharmacy'
      AND ow.tracking_number IS NULL
      AND ow.deleted_at IS NULL
    LIMIT 200
  `)

  logger.info(`[PharmacyStatusCheck] Found ${submitted.rows.length} submitted orders to status-check`)

  let updated = 0
  let errors = 0

  for (const order of submitted.rows) {
    try {
      if (order.pharmacy_type === "rmm") {
        if (await pollRmm(pg, logger, order)) updated++
      } else if (order.pharmacy_type === "rxvortex") {
        // RxVortex is webhook-driven — Strive pushes status updates to our webhook endpoint.
        logger.info(`[PharmacyStatusCheck][RxVortex] Order ${order.order_id} — status managed via webhook, skipping poll.`)
      } else {
        if (await pollDigitalRx(pg, logger, order)) updated++
      }
    } catch (err: any) {
      errors++
      logger.error(`[PharmacyStatusCheck] Error checking order ${order.order_id}: ${err.message}`)
    }
  }

  return { checked: submitted.rows.length, updated, errors }
}
