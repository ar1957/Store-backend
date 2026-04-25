import { model } from "@medusajs/framework/utils"

const ProviderSettings = model.define("provider_settings", {
  id: model.id().primaryKey(),
  tenant_domain: model.text().unique(),
  client_id: model.text().nullable(),
  client_secret: model.text().nullable(),
  api_base_url: model.text().default(
    "https://api-dev.healthcoversonline.com/endpoint/v2"
  ),
  api_env: model.text().default("test"),
  connect_url_test: model.text().nullable(),
  connect_url_prod: model.text().nullable(),
  redirect_url: model.text().nullable(),
  is_active: model.boolean().default(false),
})

export default ProviderSettings