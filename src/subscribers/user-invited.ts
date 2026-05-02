/**
 * User Invite Subscriber
 * File: src/subscribers/user-invited.ts
 *
 * Handles invite.created and invite.resent events emitted by Medusa when
 * an admin invites a new user. Sends an email via the Resend notification provider.
 */
import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"
import { INotificationModuleService } from "@medusajs/framework/types"

export default async function userInvitedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  try {
    const query = container.resolve("query") as any
    const notificationService: INotificationModuleService =
      container.resolve(Modules.NOTIFICATION)
    const config = container.resolve("configModule") as any

    // Fetch the invite details
    const { data: invites } = await query.graph({
      entity: "invite",
      fields: ["email", "token"],
      filters: { id: data.id },
    })

    const invite = invites?.[0]
    if (!invite?.email || !invite?.token) {
      console.error("[UserInvited] Could not find invite:", data.id)
      return
    }

    // Build the invite URL — Medusa Admin invite page
    const backendUrl = (config?.admin?.backendUrl && config.admin.backendUrl !== "/")
      ? config.admin.backendUrl
      : process.env.MEDUSA_BACKEND_URL || "https://api-dev.mhc-clinic-admin.com"
    const adminPath = config?.admin?.path || "/app"
    const inviteUrl = `${backendUrl}${adminPath}/invite?token=${invite.token}`

    await notificationService.createNotifications({
      to: invite.email,
      channel: "email",
      template: "auth.invite",
      data: {
        invite_url: inviteUrl,
        email: invite.email,
      },
    })
  } catch (err: any) {
    console.error("[UserInvited] Failed to send invite email:", err.message)
  }
}

export const config: SubscriberConfig = {
  event: ["invite.created", "invite.resent"],
}
