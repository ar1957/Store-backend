/**
 * RMM (RequestMyMeds.net) pharmacy submission handler.
 * Uses JWT authentication — token obtained fresh each submission.
 */
import { normalizePhone } from "./normalize-phone"

interface RmmClinic {
  pharmacy_api_url: string
  pharmacy_username: string
  pharmacy_password: string
  pharmacy_prescriber_id: string
  pharmacy_prescriber_address: string
  pharmacy_prescriber_city: string
  pharmacy_prescriber_state: string
  pharmacy_prescriber_zip: string
  pharmacy_prescriber_phone: string
  pharmacy_prescriber_dea: string
  pharmacy_doctor_first_name: string
  pharmacy_doctor_last_name: string
  pharmacy_doctor_npi: string
  pharmacy_vendor_name: string
  pharmacy_ship_type: string
  pharmacy_ship_rate: string
  pharmacy_pay_type: string
}

async function getRmmToken(baseUrl: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/getJWTkey`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) throw new Error(`RMM auth failed: ${res.status}`)
  const data = await res.json()
  if (!data.token) throw new Error("No token returned from RMM")
  return data.token
}

export async function submitToRmm(
  pg: any,
  clinic: RmmClinic,
  order: any,
  workflowId: string,
  drugName: string,
  rxNumber: string,
  treatmentDosages: any[]
): Promise<void> {
  const baseUrl = (clinic.pharmacy_api_url || "https://requestmymeds.net/api/v2").replace(/\/$/, "")

  // Get JWT token
  const token = await getRmmToken(baseUrl, clinic.pharmacy_username, clinic.pharmacy_password)

  const eligibility = (order.metadata || {}).eligibility || {}
  const dob = eligibility.dob
    ? new Date(eligibility.dob).toISOString()
    : "1990-01-01T00:00:00Z"
  const gender = eligibility.sex === "female" ? "F" : "M"

  // Clean drug name — remove special chars per RMM docs
  const cleanDrug = drugName.replace(/[\n\t"\\]/g, "").trim()

  // Get sig from treatment dosages if available
  const dosages = Array.isArray(treatmentDosages) ? treatmentDosages : []
  const sig = dosages.length > 0 && dosages[0].dosage
    ? `Take as directed - ${dosages[0].dosage}`
    : "Take as directed"

  const payload = {
    prescriber_id: (clinic.pharmacy_prescriber_id || "MHC001").slice(0, 10),
    npi: (clinic.pharmacy_doctor_npi || "0000000000").replace(/\D/g, ""),
    dea: clinic.pharmacy_prescriber_dea || "",
    prescriber_first_name: (clinic.pharmacy_doctor_first_name || "Provider").trim(),
    prescriber_last_name: (clinic.pharmacy_doctor_last_name || ".").trim(),
    prescriber_address: clinic.pharmacy_prescriber_address || "",
    prescriber_city: clinic.pharmacy_prescriber_city || "",
    prescriber_state: (clinic.pharmacy_prescriber_state || "").toUpperCase(),
    prescriber_zip: clinic.pharmacy_prescriber_zip || "",
    prescriber_phone: normalizePhone(clinic.pharmacy_prescriber_phone) || "",
    prescriber_fax: "",
    clinic_name: clinic.pharmacy_vendor_name || "",
    num_scripts: 1,
    prescription_order_id: rxNumber,
    patient_first_name: (order.first_name || "Patient").trim(),
    patient_last_name: (order.last_name || ".").trim(),
    patient_dob: dob,
    patient_gender: gender,
    patient_phone: normalizePhone(order.phone) || "",
    patient_address: order.address_1 || "",
    patient_city: order.city || "",
    patient_state: (order.province || "").toUpperCase(),
    patient_zip: (order.postal_code || "").replace(/[^\d-]/g, ""),
    date: new Date().toISOString(),
    rx_unique_id: rxNumber,
    drug: cleanDrug,
    quantity: "1",
    refills: "0",
    sig,
    pay_type: clinic.pharmacy_pay_type || "patient_pay",
    ship_type: clinic.pharmacy_ship_type || "ship_to_patient",
    ship_rate: clinic.pharmacy_ship_rate || "2_day",
    dispense_as_written: "Yes",
    notes: "",
    other_rx: "",
    supplies: "",
    clinic_ship_address: "",
    clinic_ship_city: "",
    clinic_ship_state: "",
    clinic_ship_zip: "",
    patient_license_number: "",
    patient_email: order.email || "",
    patient_icd10: "",
  }

  console.log(`[PharmacySubmit-RMM] Sending payload:`, JSON.stringify(payload, null, 2))

  const res = await fetch(`${baseUrl}/prescriptions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })

  const data = await res.json()
  console.log(`[PharmacySubmit-RMM] Response:`, JSON.stringify(data))

  if (!res.ok) throw new Error(data.error || `RMM API error: ${res.status}`)

  // RMM returns rx_unique_id as the reference
  const queueId = data.rx_unique_id || rxNumber
  await pg.raw(
    `UPDATE order_workflow SET pharmacy_queue_id = ?, pharmacy_submitted_at = NOW(), pharmacy_status = 'submitted', updated_at = NOW() WHERE id = ?`,
    [String(queueId), workflowId]
  )
  console.log(`[PharmacySubmit-RMM] Order submitted. rx_unique_id: ${queueId}`)
}
