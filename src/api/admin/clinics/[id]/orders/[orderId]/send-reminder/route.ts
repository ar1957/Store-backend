import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"
import { INotificationModuleService } from "@medusajs/framework/types"

/**
 * POST /admin/clinics/:id/orders/:orderId/send-reminder
 * Sends the provider clearance reminder email for a single order.
 * Identical to the daily cron job but for one specific order on demand.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const notificationService: INotificationModuleService =
      req.scope.resolve(Modules.NOTIFICATION)

    const { orderId } = req.params

    const result = await pg.raw(`
      SELECT
        ow.id AS workflow_id,
        ow.gfe_id,
        ow.order_id,
        ow.tenant_domain,
        ow.virtual_room_url,
        ow.created_at AS order_created_at,
        ow.status,
        o.email,
        o.display_id,
        oa.first_name,
        oa.last_name,
        c.name AS clinic_name,
        c.logo_url,
        c.from_email,
        c.from_name,
        c.reply_to,
        c.domains
      FROM order_workflow ow
      JOIN "order" o ON o.id = ow.order_id
      LEFT JOIN order_address oa ON oa.id = o.shipping_address_id
      JOIN clinic c ON (
        ow.tenant_domain = ANY(c.domains)
        OR ow.tenant_domain = ANY(SELECT split_part(d,':',1) FROM unnest(c.domains) AS d)
        OR o.sales_channel_id = c.sales_channel_id
      )
      WHERE o.id = ?
        AND ow.deleted_at IS NULL
      LIMIT 1
    `, [orderId])

    if (!result.rows.length) {
      return res.status(404).json({ message: "Order not found" })
    }

    const row = result.rows[0]

    if (row.status !== "pending_provider") {
      return res.status(400).json({
        message: `Reminder can only be sent for orders in 'pending_provider' status. Current status: ${row.status}`
      })
    }

    if (!row.email) {
      return res.status(400).json({ message: "No patient email on this order" })
    }

    const domain = (row.domains || []).find((d: string) =>
      !d.includes("localhost") && !d.includes(".local")
    ) || row.tenant_domain
    const cleanDomain = domain.split(":")[0]
    const trackOrderUrl = `https://${cleanDomain}/us/order/status/${row.gfe_id || row.order_id}`
    const patientName = [row.first_name, row.last_name].filter(Boolean).join(" ") || "Patient"
    const daysPending = Math.floor(
      (Date.now() - new Date(row.order_created_at).getTime()) / 86400000
    )

    await notificationService.createNotifications({
      to: row.email,
      channel: "email",
      template: "order.pending_provider_reminder",
      data: {
        patient_name: patientName,
        patient_email: row.email,
        order_display_id: row.display_id,
        clinic_name: row.clinic_name,
        logo_url: row.logo_url || null,
        from_email: row.from_email || null,
        from_name: row.from_name || null,
        reply_to: row.reply_to || null,
        track_order_url: trackOrderUrl,
        virtual_room_url: row.virtual_room_url || null,
        days_pending: daysPending,
        status: "pending_provider",
      },
    })

    return res.json({ success: true, message: `Reminder sent to ${row.email}` })
  } catch (err: unknown) {
    console.error("[SendReminder] Error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
