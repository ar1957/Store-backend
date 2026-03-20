import { model } from "@medusajs/framework/utils"

const ProductTreatmentMap = model.define("product_treatment_map", {
  id: model.id().primaryKey(),
  tenant_domain: model.text(),
  product_id: model.text(),
  product_title: model.text().nullable(),
  variant_id: model.text().nullable(),
  treatment_id: model.number(),
  treatment_name: model.text().nullable(),
  requires_eligibility: model.boolean().default(true),
})

export default ProductTreatmentMap