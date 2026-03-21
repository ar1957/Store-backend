import { model } from "@medusajs/framework/utils"

export const ClinicUiConfig = model.define("clinic_ui_config", {
  id: model.id({ prefix: "cuicfg" }).primaryKey(),
  tenant_domain: model.text(),
  nav_links: model.json().nullable(),
  footer_links: model.json().nullable(),
  bottom_links: model.json().nullable(),
  logo_url: model.text().nullable(),
  get_started_url: model.text().nullable(),
  contact_phone: model.text().nullable(),
  contact_email: model.text().nullable(),
  contact_address: model.text().nullable(),
  social_links: model.json().nullable(),
  certification_image_url: model.text().nullable(),
})