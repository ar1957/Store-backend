/**
 * Job: pending-provider-reminder
 * Runs daily at 1AM.
 * Sends a reminder email to patients whose order is still in 'pending_provider'
 * status — i.e. they haven't connected with a provider yet.
 * Includes the track-order link so they can join their virtual visit.
 */
import { MedusaContainer } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"
import { INotificationModuleService } from "@medusajs/framework/types"

export default async function pendingProviderReminderJob(container: MedusaContainer) {
  const logger = container.resolve("logger") as any
  const pg = container.resolve("__pg_connection__") as any

  logger.info("[PendingProviderReminder] Starting daily reminder job...")

  try {
    const notificationService: INotificationModuleService =
      container.resolve(Modules.NOTIFICATION)

    // Find all orders still pending provider — joined with clinic for branding + domain
    const result = await pg.raw(`
      SELECT
        ow.id AS workflow_id,
        ow.gfe_id,
        ow.order_id,
        ow.tenant_domain,
        ow.virtual_room_url,
        ow.created_at AS order_created_at,
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
      )
      WHERE ow.status = 'pending_provider'
        AND ow.deleted_at IS NULL
        AND o.email IS NOT NULL
      ORDER BY ow.created_at ASC
    `)

    const orders = result.rows
    logger.info(`[PendingProviderReminder] Found ${orders.length} pending orders to remind`)

    let sent = 0
    let failed = 0

    for (const row of orders) {
      try {
        // Build the track-order URL using the clinic's production domain
        const domain = (row.domains || []).find((d: string) => !d.includes("localhost") && !d.includes(".local"))
          || row.tenant_domain
        const cleanDomain = domain.split(":")[0]
        const trackOrderUrl = `https://${cleanDomain}/us/order/status/${row.gfe_id || row.order_id}`

        const patientName = [row.first_name, row.last_name].filter(Boolean).join(" ") || "Patient"
        const daysPending = Math.floor((Date.now() - new Date(row.order_created_at).getTime()) / 86400000)

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

        sent++
        logger.info(`[PendingProviderReminder] Reminder sent to ${row.email} (order #${row.display_id}, ${daysPending} days pending)`)
      } catch (err: any) {
        failed++
        logger.error(`[PendingProviderReminder] Failed to send to ${row.email}: ${err.message}`)
      }
    }

    logger.info(`[PendingProviderReminder] Done. Sent: ${sent}, Failed: ${failed}`)
  } catch (err: any) {
    logger.error("[PendingProviderReminder] Fatal error:", err.message)
  }
}

export const config = {
  name: "pending-provider-reminder",
  schedule: "0 1 * * *", // 1AM every day
}
