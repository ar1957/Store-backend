import { Module } from "@medusajs/framework/utils"
import ClinicOpsService from "./clinic-ops-service"
import { Migration20240101000001 } from "./migrations/Migration20240101000001"
import { Migration20240101000002 } from "./migrations/Migration20240101000002"
import { Migration20240101000003 } from "./migrations/Migration20240101000003"
import { Migration20240101000004 } from "./migrations/Migration20240101000004"
import { Migration20240101000005 } from "./migrations/Migration20240101000005"
import { Migration20240101000006 } from "./migrations/Migration20240101000006"
import { Migration20240101000007 } from "./migrations/Migration20240101000007"
import { Migration20240101000008 } from "./migrations/Migration20240101000008"

export const PROVIDER_INTEGRATION_MODULE = "providerIntegration"

export default Module(PROVIDER_INTEGRATION_MODULE, {
  service: ClinicOpsService,
  migrations: [
    Migration20240101000001,
    Migration20240101000002,
    Migration20240101000003,
    Migration20240101000004,
    Migration20240101000005,
    Migration20240101000006,
    Migration20240101000007,
    Migration20240101000008,
  ],
})