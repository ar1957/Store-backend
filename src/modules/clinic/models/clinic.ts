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

  // Per-clinic email sending (Resend)
  from_email: model.text().nullable(),
  from_name: model.text().nullable(),
  reply_to: model.text().nullable(),

  // Pharmacy integration
  pharmacy_type: model.text().nullable(),           // e.g. "digitalrx", "custom"
  pharmacy_api_url: model.text().nullable(),
  pharmacy_api_key: model.text().nullable(),
  pharmacy_store_id: model.text().nullable(),
  pharmacy_vendor_name: model.text().nullable(),
  pharmacy_doctor_first_name: model.text().nullable(),
  pharmacy_doctor_last_name: model.text().nullable(),
  pharmacy_doctor_npi: model.text().nullable(),
  pharmacy_enabled: model.boolean().default(false),
  // RMM (RequestMyMeds) specific fields
  pharmacy_username: model.text().nullable(),
  pharmacy_password: model.text().nullable(),
  pharmacy_prescriber_id: model.text().nullable(),
  pharmacy_prescriber_address: model.text().nullable(),
  pharmacy_prescriber_city: model.text().nullable(),
  pharmacy_prescriber_state: model.text().nullable(),
  pharmacy_prescriber_zip: model.text().nullable(),
  pharmacy_prescriber_phone: model.text().nullable(),
  pharmacy_prescriber_dea: model.text().nullable(),
  pharmacy_ship_type: model.text().nullable(),
  pharmacy_ship_rate: model.text().nullable(),
  pharmacy_pay_type: model.text().nullable(),
})

export default Clinic