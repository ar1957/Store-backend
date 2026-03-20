import { model } from "@medusajs/framework/utils"

export const ClinicStaff = model.define("clinic_staff", {
  id: model.id().primaryKey(),
  tenant_domain: model.text(),
  user_id: model.text(),
  email: model.text(),
  full_name: model.text().nullable(),
  role: model.text(), // 'clinic_admin' | 'medical_director' | 'pharmacist'
  is_active: model.boolean().default(true),
})