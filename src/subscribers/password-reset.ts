/**
 * Password Reset Subscriber
 * File: src/subscribers/password-reset.ts
 *
 * Handles the auth.password_reset event emitted by Medusa when a user
 * requests a password reset. Sends an email via the Resend notification provider.
 */
import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"
import { INotificationModuleService } from "@medusajs/framework/types"

export default async function passwordResetHandler({
  event: { data: { entity_id: email, token, actor_type } },
  container,
}: SubscriberArgs<{ entity_id: string; token: string; actor_type: string }>) {
  try {
    const notificationService: INotificationModuleService =
      container.resolve(Modules.NOTIFICATION)

    const config = container.resolve("configModule") as any

    // Build the reset URL — admin users go to the admin panel reset page
    let resetUrl: string
    if (actor_type === "customer") {
      const storefrontUrl = config?.admin?.storefrontUrl || "https://myclassywellness.com"
      resetUrl = `${storefrontUrl}/us/account/reset-password?token=${token}&email=${encodeURIComponent(email)}`
    } else {
      // Admin user — Medusa Admin is served at /app on the backend URL
      const backendUrl = (config?.admin?.backendUrl && config.admin.backendUrl !== "/")
        ? config.admin.backendUrl
        : process.env.MEDUSA_BACKEND_URL || "https://api-dev.mhc-clinic-admin.com"
      const adminPath = config?.admin?.path || "/app"
      resetUrl = `${backendUrl}${adminPath}/reset-password?token=${token}&email=${encodeURIComponent(email)}`
    }

    await notificationService.createNotifications({
      to: email,
      channel: "email",
      template: "auth.password_reset",
      data: {
        reset_url: resetUrl,
        email,
      },
    })
  } catch (err: any) {
    console.error("[PasswordReset] Failed to send reset email:", err.message)
  }
}

export const config: SubscriberConfig = {
  event: "auth.password_reset",
}
