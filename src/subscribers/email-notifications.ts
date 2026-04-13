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
      o.created_at AS order_created_at,
      o.metadata AS order_metadata,
      -- shipping address
      sa.first_name AS ship_first, sa.last_name AS ship_last,
      sa.address_1  AS ship_addr1, sa.address_2 AS ship_addr2,
      sa.city       AS ship_city,  sa.province  AS ship_province,
      sa.postal_code AS ship_zip,  sa.country_code AS ship_country,
      sa.phone      AS ship_phone,
      -- billing address
      ba.first_name AS bill_first, ba.last_name AS bill_last,
      ba.address_1  AS bill_addr1, ba.address_2 AS bill_addr2,
      ba.city       AS bill_city,  ba.province  AS bill_province,
      ba.postal_code AS bill_zip,  ba.country_code AS bill_country,
      ba.phone      AS bill_phone,
      -- customer fallback
      c.first_name AS cust_first, c.last_name AS cust_last,
      sc.name AS clinic_name,
      os.totals AS order_totals,
      wf.status,
      wf.treatment_dosages,
      wf.tracking_number,
      wf.carrier,
      wf.md_notes,
      wf.tenant_domain,
      cl.from_email AS clinic_from_email,
      cl.from_name  AS clinic_from_name,
      cl.reply_to   AS clinic_reply_to,
      cl.brand_color AS clinic_brand_color,
      cl.logo_url   AS clinic_logo_url
    FROM "order" o
    LEFT JOIN "customer" c        ON c.id  = o.customer_id
    LEFT JOIN "order_address" sa  ON sa.id = o.shipping_address_id
    LEFT JOIN "order_address" ba  ON ba.id = o.billing_address_id
    LEFT JOIN "sales_channel" sc  ON sc.id = o.sales_channel_id
    LEFT JOIN "order_summary" os  ON os.order_id = o.id AND os.deleted_at IS NULL
    LEFT JOIN "order_workflow" wf ON wf.order_id = o.id AND wf.deleted_at IS NULL
    LEFT JOIN "clinic" cl ON (
      wf.tenant_domain = ANY(cl.domains)
      OR o.sales_channel_id = cl.sales_channel_id
      OR (o.metadata->>'eligibility')::jsonb->>'domain' = ANY(cl.domains)
    )
    WHERE o.id = ?
    LIMIT 1`,
    [orderId]
  )

  const row = result.rows?.[0]
  if (!row) return null

  // Line items
  const itemsResult = await pg.raw(
    `SELECT li.title, li.unit_price, oi.quantity, li.metadata
     FROM order_item oi
     JOIN order_line_item li ON li.id = oi.item_id
     WHERE oi.order_id = ?
     ORDER BY li.created_at`,
    [orderId]
  )

  const currency = (row.currency_code || "usd").toUpperCase()
  const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n)

  const lineItems = (itemsResult.rows || []).map((li: any) => {
    const meta = li.metadata || {}
    // Pull eligibility answers from metadata for display (e.g. pregnancy)
    const notes: string[] = []
    if (meta.is_pregnant !== undefined) notes.push(`Is pregnant: ${meta.is_pregnant}`)
    return {
      title: li.title,
      quantity: Number(li.quantity),
      unit_price: fmt(Number(li.unit_price)),
      notes,
    }
  })

  // Totals
  let subtotal = "", discount = "", shipping = "", total = ""
  try {
    const totals = typeof row.order_totals === "string" ? JSON.parse(row.order_totals) : row.order_totals
    subtotal = fmt(Number(totals?.subtotal ?? 0))
    discount = totals?.discount_total ? `-${fmt(Number(totals.discount_total))}` : ""
    shipping = totals?.shipping_total === 0 ? "Free Standard Shipping" : fmt(Number(totals?.shipping_total ?? 0))
    total = fmt(Number(totals?.current_order_total ?? totals?.total ?? 0))
  } catch { /* ignore */ }

  const firstName = row.ship_first || row.cust_first || ""
  const lastName  = row.ship_last  || row.cust_last  || ""
  const patientName = `${firstName} ${lastName}`.trim() || "Patient"

  const orderDate = row.order_created_at
    ? new Date(row.order_created_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : ""

  const domain = row.tenant_domain || (() => {
    try {
      const meta = typeof row.order_metadata === "string" ? JSON.parse(row.order_metadata) : (row.order_metadata || {})
      return meta?.eligibility?.domain || ""
    } catch { return "" }
  })()
  const trackOrderUrl = domain ? `https://${domain}/us/order/status` : null

  return {
    email: row.email,
    patient_name: patientName,
    order_display_id: row.display_id,
    order_date: orderDate,
    clinic_name: row.clinic_name,
    line_items: lineItems,
    subtotal,
    discount,
    shipping,
    total,
    shipping_address: {
      name: `${row.ship_first || ""} ${row.ship_last || ""}`.trim(),
      address_1: row.ship_addr1,
      address_2: row.ship_addr2,
      city: row.ship_city,
      province: row.ship_province,
      postal_code: row.ship_zip,
      country_code: (row.ship_country || "").toUpperCase(),
      phone: row.ship_phone,
    },
    billing_address: {
      name: `${row.bill_first || ""} ${row.bill_last || ""}`.trim(),
      address_1: row.bill_addr1,
      address_2: row.bill_addr2,
      city: row.bill_city,
      province: row.bill_province,
      postal_code: row.bill_zip,
      country_code: (row.bill_country || "").toUpperCase(),
      phone: row.bill_phone,
      email: row.email,
    },
    track_order_url: trackOrderUrl,
    brand_color: row.clinic_brand_color || "#6d28d9",
    logo_url: row.clinic_logo_url || null,
    status: row.status,
    tracking_number: row.tracking_number,
    carrier: row.carrier,
    md_notes: row.md_notes,
    from_email: row.clinic_from_email || undefined,
    from_name: row.clinic_from_name || undefined,
    reply_to: row.clinic_reply_to || undefined,
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