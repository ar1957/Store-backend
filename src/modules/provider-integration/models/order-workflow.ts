import { model } from "@medusajs/framework/utils"

const OrderWorkflow = model.define("order_workflow", {
  id: model.id().primaryKey(),
  order_id: model.text().unique(),
  tenant_domain: model.text(),
  patient_id: model.number().nullable(),
  gfe_id: model.number().nullable(),
  room_no: model.number().nullable(),
  virtual_room_url: model.text().nullable(),

  // Status
  status: model.text().default("awaiting_provider_review"),

  // Provider review
  provider_status: model.text().nullable(),
  provider_name: model.text().nullable(),
  provider_reviewed_at: model.dateTime().nullable(),

  // Medical Director
  md_user_id: model.text().nullable(),
  md_decision: model.text().nullable(),
  md_notes: model.text().nullable(),
  md_reviewed_at: model.dateTime().nullable(),

  // Pharmacy
  pharmacist_user_id: model.text().nullable(),
  pharmacy_notes: model.text().nullable(),
  tracking_number: model.text().nullable(),
  carrier: model.text().nullable(),
  shipped_at: model.dateTime().nullable(),

  // Refund
  refund_id: model.text().nullable(),
  refund_issued_at: model.dateTime().nullable(),
})

export default OrderWorkflow