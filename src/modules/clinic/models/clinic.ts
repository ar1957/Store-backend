import { model } from "@medusajs/framework/utils"

const Clinic = model.define("clinic", {
  id: model.id().primaryKey(),

  // Identity
  name: model.text(),
  slug: model.text().unique(),
  domains: model.array(), // string[] — list of domains this clinic owns
  contact_email: model.text().nullable(),
  is_active: model.boolean().default(true),

  // Branding
  logo_url: model.text().nullable(),
  brand_color: model.text().default("#111111"),

  // Provider API credentials
  api_client_id: model.text().nullable(),
  api_client_secret: model.text().nullable(),
  api_env: model.text().default("test"),
  api_base_url_test: model.text().default(
    "https://api-dev.healthcoversonline.com/endpoint/v2"
  ),
  api_base_url_prod: model.text().default(
    "https://api.healthcoversonline.com/endpoint/v2"
  ),

  // Patient connect
  connect_env: model.text().default("test"),
  connect_url_test: model.text().default(
    "https://app.healthcoversonline.com/connect/patient"
  ),
  connect_url_prod: model.text().default(
    "https://app.healthcoversonline.com/connect/patient"
  ),
  redirect_url: model.text().nullable(),

  // Medusa integration
  publishable_api_key: model.text().nullable(),
  sales_channel_id: model.text().nullable(),

  // Stripe
  stripe_publishable_key: model.text().nullable(),
  stripe_secret_key: model.text().nullable(),

  // Pharmacy
  pharmacy_staff_id: model.text().nullable(),
})

export default Clinic