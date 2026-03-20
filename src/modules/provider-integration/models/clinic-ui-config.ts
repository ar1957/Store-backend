import { model } from "@medusajs/framework/utils"

export const ClinicUiConfig = model.define("clinic_ui_config", {
  id: model.id({ prefix: "cuicfg" }).primaryKey(),
  tenant_domain: model.text(),
  nav_links: model.json().nullable(),
  footer_links: model.json().nullable(),
  logo_url: model.text().nullable(),
  get_started_url: model.text().nullable(),
})