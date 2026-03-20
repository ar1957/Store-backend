import { Module } from "@medusajs/framework/utils"
import ClinicOpsService from "../provider-integration/clinic-ops-service"

export const CLINIC_OPS_MODULE = "clinicOps"

export default Module(CLINIC_OPS_MODULE, {
  service: ClinicOpsService,
})