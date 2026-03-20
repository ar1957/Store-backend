import { Module } from "@medusajs/framework/utils"
import ClinicOpsService from "./clinic-ops-service"

export const PROVIDER_INTEGRATION_MODULE = "providerIntegration"

export default Module(PROVIDER_INTEGRATION_MODULE, {
  service: ClinicOpsService,
})