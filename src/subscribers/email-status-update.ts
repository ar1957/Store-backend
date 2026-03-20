/**
 * File: src/subscribers/email-status-update.ts
 * Fires when order_workflow status changes — sends status update email.
 * Called manually from md-decision/route.ts and ship/route.ts
 * via a custom event, OR you can call sendStatusEmail() directly.
 */
import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"
import { INotificationModuleService } from "@medusajs/framework/types"

export default async function orderStatusEmailHandler({
  event: { data },
  container,
}: SubscriberArgs<{
  order_id: string
  status: string
  patient_email: string
  patient_name: string
  order_display_id: number
  clinic_name?: string
  tracking_number?: string
  carrier?: string
  md_notes?: string
}>) {
  try {
    const notificationService: INotificationModuleService =
      container.resolve(Modules.NOTIFICATION)

    // Choose template based on status
    let template = "order.status_update"
    if (data.status === "shipped") template = "order.shipped"
    if (data.status === "md_denied") template = "order.md_denied"

    await notificationService.createNotifications({
      to: data.patient_email,
      channel: "email",
      template,
      data,
    })
  } catch (err: any) {
    console.error("[Email] Status update email failed:", err.message)
  }
}

export const config: SubscriberConfig = {
  event: "order.workflow.status_updated",
}