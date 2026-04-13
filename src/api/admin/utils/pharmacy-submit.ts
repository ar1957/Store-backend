import { normalizePhone } from "./normalize-phone"
import { submitToRmm } from "./pharmacy-submit-rmm"

/**
 * Shared pharmacy submission helper.
 * Called when an order transitions to 'processing_pharmacy' status.
 * Handles both DigitalRX and RMM pharmacies.
 */

export async function submitToPharmacyIfEnabled(
  pg: any,
  clinicId: string,
  orderId: string,
  workflowId: string,
  treatmentDosages: any[]
): Promise<void> {
  try {
    const clinicResult = await pg.raw(
      `SELECT pharmacy_type, pharmacy_api_key, pharmacy_store_id, pharmacy_enabled,
              pharmacy_api_url, pharmacy_vendor_name,
              pharmacy_doctor_first_name, pharmacy_doctor_last_name, pharmacy_doctor_npi,
              pharmacy_username, pharmacy_password,
              pharmacy_prescriber_id, pharmacy_prescriber_address, pharmacy_prescriber_city,
              pharmacy_prescriber_state, pharmacy_prescriber_zip, pharmacy_prescriber_phone,
              pharmacy_prescriber_dea, pharmacy_ship_type, pharmacy_ship_rate, pharmacy_pay_type
       FROM clinic WHERE id = ? LIMIT 1`,
      [clinicId]
    )
    const clinic = clinicResult.rows[0]

    // Gate: pharmacy must be enabled
    if (!clinic?.pharmacy_enabled) return

    const isRmm = clinic.pharmacy_type === "rmm"

    // Gate: must have credentials for the configured type
    if (isRmm && (!clinic.pharmacy_username || !clinic.pharmacy_password)) return
    if (!isRmm && (!clinic.pharmacy_api_key || !clinic.pharmacy_store_id)) return

    // Check not already submitted
    const wfCheck = await pg.raw(`SELECT pharmacy_queue_id FROM order_workflow WHERE id = ? LIMIT 1`, [workflowId])
    if (wfCheck.rows[0]?.pharmacy_queue_id) return

    // Get order + patient details
    const orderResult = await pg.raw(
      `SELECT o.id, o.display_id, o.email, o.metadata,
              oa.first_name, oa.last_name, oa.address_1, oa.city, oa.province, oa.postal_code, oa.phone
       FROM "order" o
       LEFT JOIN order_address oa ON oa.id = o.shipping_address_id
       WHERE o.id = ? LIMIT 1`,
      [orderId]
    )
    const order = orderResult.rows[0]
    if (!order) return

    // Get line item for drug name fallback
    const itemsResult = await pg.raw(
      `SELECT li.title FROM order_item oi JOIN order_line_item li ON li.id = oi.item_id WHERE oi.order_id = ? LIMIT 1`,
      [orderId]
    )
    const item = itemsResult.rows[0]

    // Build drug name
    let drugName = "RXI-Compounded Medication"
    try {
      const dosages = Array.isArray(treatmentDosages) ? treatmentDosages : []
      if (dosages.length > 0) {
        const d = dosages[0]
        const name = (d.treatmentName || item?.title || "Medication")
          .replace(/^E-Commerce Online Order:\s*/i, "")
          .replace(/\s*-\s*\d+\s*month\s*supply.*/i, "")
          .trim()
        drugName = d.dosage ? `RXI-${name} - ${d.dosage}` : `RXI-${name}`
      } else if (item?.title) {
        drugName = `RXI-${item.title}`
      }
    } catch {}

    const rxNumber = `RX-${order.display_id}-${Date.now().toString().slice(-6)}`

    // ── RMM path ──────────────────────────────────────────────────────────────
    if (isRmm) {
      await submitToRmm(pg, clinic, order, workflowId, drugName, rxNumber, treatmentDosages)
      return
    }

    // ── DigitalRX path ────────────────────────────────────────────────────────
    const eligibility = (order.metadata || {}).eligibility || {}
    const dob = eligibility.dob ? new Date(eligibility.dob).toISOString().split("T")[0] : "1990-01-01"
    const sex = eligibility.sex === "female" ? "F" : "M"
    const apiUrl = (clinic.pharmacy_api_url || "https://www.dbswebserver.com/DBSRestApi/API").replace(/\/$/, "")

    const payload = {
      StoreID: (clinic.pharmacy_store_id || "").trim(),
      VendorName: (clinic.pharmacy_vendor_name || "MHC Store").trim(),
      Patient: {
        FirstName: (order.first_name || "Patient").trim(),
        LastName: (order.last_name || ".").trim(),
        DOB: dob,
        Sex: sex,
        PatientPhone: normalizePhone(order.phone),
        PatientStreet: order.address_1 || undefined,
        PatientCity: order.city || undefined,
        PatientState: (order.province || "").toUpperCase() || undefined,
        PatientZip: (order.postal_code || "").replace(/[^\d-]/g, "") || undefined,
      },
      Doctor: {
        DoctorFirstName: (clinic.pharmacy_doctor_first_name || "Provider").trim(),
        DoctorLastName: (clinic.pharmacy_doctor_last_name || ".").trim(),
        DoctorNpi: (clinic.pharmacy_doctor_npi || "0000000000").replace(/\D/g, ""),
      },
      RxClaim: {
        RxNumber: rxNumber,
        DrugName: drugName,
        Qty: "1",
        DateWritten: new Date().toISOString().split("T")[0],
      },
    }

    const pharmRes = await fetch(`${apiUrl}/RxWebRequest`, {
      method: "POST",
      headers: { "Authorization": clinic.pharmacy_api_key, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })

    const pharmData = await pharmRes.json()
    console.log(`[PharmacySubmit] Response for order ${orderId}:`, JSON.stringify(pharmData))

    // API returns { "ID": "12345" } — field is "ID" not "QueueID"
    const queueId = pharmData.ID || pharmData.QueueID || pharmData.id

    if (pharmRes.ok && queueId) {
      await pg.raw(
        `UPDATE order_workflow SET pharmacy_queue_id = ?, pharmacy_submitted_at = NOW(), pharmacy_status = 'submitted', updated_at = NOW() WHERE id = ?`,
        [String(queueId), workflowId]
      )
      console.log(`[PharmacySubmit] Order ${orderId} submitted to DigitalRX. QueueID: ${queueId}`)
    } else {
      console.error(`[PharmacySubmit] DigitalRX error for order ${orderId}:`, pharmData)
    }
  } catch (err: any) {
    console.error(`[PharmacySubmit] Error for order ${orderId}:`, err.message)
  }
}
