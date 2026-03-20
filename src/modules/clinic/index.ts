import { Module } from "@medusajs/framework/utils"
import ClinicService from "./service"

export const CLINIC_MODULE = "clinic"

export default Module(CLINIC_MODULE, {
  service: ClinicService,
})