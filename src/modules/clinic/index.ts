import { Module } from "@medusajs/framework/utils"
import ClinicService from "./service"

export const CLINIC_MODULE = "clinic"

// This satisfies the Type Definition while allowing the module to be loaded
export default Module(CLINIC_MODULE, {
  service: ClinicService,
})