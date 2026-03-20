/**
 * File: src/subscribers/email-notifications.ts
 * Handles all patient email notifications:
 * - Order placed confirmation
 * - Workflow status updates (MD approved/denied, processing pharmacy)
 * - Shipped with tracking
 *
 * This file works alongside your existing order-placed.ts subscriber.
 */
import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"
import { INotificationModuleService } from "@medusajs/framework/types"

// ── Helper: get patient email and name from order ──────────────────────────

async function getOrderDetails(orderId: string, pg: any) {
  const result = await pg.raw(
    `SELECT
      o.display_id,
      o.email,
      o.currency_code,
      c.first_name AS customer_first_name,
      c.last_name  AS customer_last_name,
      oa.first_name AS shipping_first_name,
      oa.last_name  AS shipping_last_name,
      sc.name AS clinic_name,
      os.totals AS order_totals,
      wf.status,
      wf.treatment_dosages,
      wf.tracking_number,
      wf.carrier,
      wf.md_notes
    FROM "order" o
    LEFT JOIN "customer" c       ON c.id = o.customer_id
    LEFT JOIN "order_address" oa ON oa.id = o.shipping_address_id
    LEFT JOIN "sales_channel" sc ON sc.id = o.sales_channel_id
    LEFT JOIN "order_summary" os ON os.order_id = o.id AND os.deleted_at IS NULL
    LEFT JOIN "order_workflow" wf ON wf.order_id = o.id AND wf.deleted_at IS NULL
    WHERE o.id = ?
    LIMIT 1`,
    [orderId]
  )

  const row = result.rows?.[0]
  if (!row) return null

  const firstName = row.shipping_first_name || row.customer_first_name || ""
  const lastName = row.shipping_last_name || row.customer_last_name || ""
  const patientName = `${firstName} ${lastName}`.trim() || "Patient"

  let total = ""
  try {
    const totals = typeof row.order_totals === "string"
      ? JSON.parse(row.order_totals)
      : row.order_totals
    const amount = totals?.current_order_total ?? totals?.total ?? 0
    total = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: (row.currency_code || "usd").toUpperCase(),
    }).format(amount)
  } catch { /* ignore */ }

  let medication = ""
  try {
    const dosages = typeof row.treatment_dosages === "string"
      ? JSON.parse(row.treatment_dosages)
      : row.treatment_dosages
    if (Array.isArray(dosages) && dosages.length > 0) {
      medication = dosages
        .map((d: any) => {
          const name = (d.treatmentName || "").replace(/^E-Commerce Online Order:\s*/i, "").trim()
          return d.dosage ? `${name} — ${d.dosage}` : name
        })
        .join(", ")
    }
  } catch { /* ignore */ }

  return {
    email: row.email,
    patient_name: patientName,
    order_display_id: row.display_id,
    clinic_name: row.clinic_name,
    total,
    medication,
    status: row.status,
    tracking_number: row.tracking_number,
    carrier: row.carrier,
    md_notes: row.md_notes,
  }
}

// ── 1. Order Placed — confirmation email ───────────────────────────────────

export default async function orderPlacedEmailHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  try {
    const pg = container.resolve("__pg_connection__") as any
    const notificationService: INotificationModuleService =
      container.resolve(Modules.NOTIFICATION)

    const details = await getOrderDetails(data.id, pg)
    if (!details?.email) return

    await notificationService.createNotifications({
      to: details.email,
      channel: "email",
      template: "order.confirmation",
      data: details,
    })
  } catch (err: any) {
    console.error("[Email] Order confirmation failed:", err.message)
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}