/**
 * File: src/modules/resend/index.ts
 */
import ResendNotificationProviderService from "./service"
import { ModuleProvider, Modules } from "@medusajs/framework/utils"

export default ModuleProvider(Modules.NOTIFICATION, {
  services: [ResendNotificationProviderService],
})