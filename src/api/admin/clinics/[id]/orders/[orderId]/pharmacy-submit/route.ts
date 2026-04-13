/**
 * POST /admin/clinics/:id/orders/:orderId/pharmacy-submit
 * Submits an order to the clinic's configured pharmacy API.
 * Routes to DigitalRX or RMM based on pharmacy_type.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { normalizePhone } from "../../../../../utils/normalize-phone"
import { submitToRmm } from "../../../../../utils/pharmacy-submit-rmm"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId, orderId } = req.params

    // 1. Get clinic pharmacy config
    const clinicResult = await pg.raw(
      `SELECT pharmacy_type, pharmacy_api_url, pharmacy_api_key, pharmacy_store_id,
              pharmacy_vendor_name, pharmacy_doctor_first_name, pharmacy_doctor_last_name,
              pharmacy_doctor_npi, pharmacy_username, pharmacy_password,
              pharmacy_prescriber_id, pharmacy_prescriber_address, pharmacy_prescriber_city,
              pharmacy_prescriber_state, pharmacy_prescriber_zip, pharmacy_prescriber_phone,
              pharmacy_prescriber_dea, pharmacy_ship_type, pharmacy_ship_rate, pharmacy_pay_type
       FROM clinic WHERE id = ? LIMIT 1`,
      [clinicId]
    )
    const clinic = clinicResult.rows[0]
    const isRmm = clinic?.pharmacy_type === "rmm"

    if (isRmm) {
      if (!clinic?.pharmacy_username || !clinic?.pharmacy_password) {
        return res.status(400).json({ message: "No RMM credentials configured for this clinic" })
      }
    } else {
      if (!clinic?.pharmacy_api_key || !clinic?.pharmacy_store_id) {
        return res.status(400).json({ message: "No pharmacy API configured for this clinic" })
      }
    }

    // 2. Get order + patient + medication info
    const orderResult = await pg.raw(
      `SELECT
        o.id, o.display_id, o.email, o.metadata,
        oa.first_name, oa.last_name,
        oa.address_1, oa.city, oa.province, oa.postal_code,
        oa.phone,
        ow.id AS workflow_id, ow.treatment_dosages, ow.pharmacy_queue_id
       FROM "order" o
       LEFT JOIN order_address oa ON oa.id = o.shipping_address_id
       LEFT JOIN order_workflow ow ON ow.order_id = o.id AND ow.deleted_at IS NULL
       WHERE o.id = ? LIMIT 1`,
      [orderId]
    )
    if (!orderResult.rows.length) {
      return res.status(404).json({ message: "Order not found" })
    }
    const order = orderResult.rows[0]

    // Already submitted
    if (order.pharmacy_queue_id) {
      return res.json({ success: true, queueId: order.pharmacy_queue_id, message: "Already submitted" })
    }

    // 3. Get medication info from order line items + treatment dosages
    const itemsResult = await pg.raw(
      `SELECT li.title, li.variant_sku, li.metadata
       FROM order_item oi
       JOIN order_line_item li ON li.id = oi.item_id
       WHERE oi.order_id = ? LIMIT 1`,
      [orderId]
    )
    const item = itemsResult.rows[0]

    // Build drug name in DigitalRX format: "RXI-{product name} - {dosage}"
    // Use treatment_dosages from order_workflow if available
    let drugName = "RXI-Compounded Medication"
    try {
      const dosages = typeof order.treatment_dosages === "string"
        ? JSON.parse(order.treatment_dosages)
        : (order.treatment_dosages || [])
      if (Array.isArray(dosages) && dosages.length > 0) {
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

    // 4. Get DOB from eligibility metadata
    const metadata = order.metadata || {}
    const eligibility = metadata.eligibility || {}
    const dob = eligibility.dob ? new Date(eligibility.dob).toISOString().split("T")[0] : "1990-01-01"
    const sex = eligibility.sex === "female" ? "F" : "M"

    // 5. Route to correct pharmacy handler
    if (isRmm) {
      await submitToRmm(pg, clinic, order, order.workflow_id, drugName, rxNumber,
        typeof order.treatment_dosages === "string" ? JSON.parse(order.treatment_dosages || "[]") : (order.treatment_dosages || []))
      return res.json({ success: true, message: "Submitted to Partell Pharmacy (RMM)" })
    }

    // 5b. Build DigitalRX payload
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

    // 6. Submit to pharmacy API
    console.log("[PharmacySubmit] Sending payload:", JSON.stringify(payload, null, 2))
    const pharmRes = await fetch(`${apiUrl}/RxWebRequest`, {
      method: "POST",
      headers: {
        "Authorization": clinic.pharmacy_api_key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })

    const pharmData = await pharmRes.json()
    if (!pharmRes.ok || (!pharmData.QueueID && !pharmData.ID && !pharmData.id)) {
      console.error("[PharmacySubmit] API error:", pharmData)
      return res.status(502).json({ message: pharmData.Message || "Pharmacy API error" })
    }

    const queueId = String(pharmData.ID || pharmData.QueueID || pharmData.id)

    // 7. Save QueueID to order_workflow
    await pg.raw(
      `UPDATE order_workflow
       SET pharmacy_queue_id = ?, pharmacy_submitted_at = NOW(), pharmacy_status = 'submitted', updated_at = NOW()
       WHERE id = ?`,
      [queueId, order.workflow_id]
    )

    console.log(`[PharmacySubmit] Order ${orderId} submitted to pharmacy. QueueID: ${queueId}`)
    return res.json({ success: true, queueId, message: pharmData.Message || "Submitted successfully" })
  } catch (err: any) {
    console.error("[PharmacySubmit] Error:", err.message)
    return res.status(500).json({ message: err.message })
  }
}
