/**
 * RxVortex (Strive) pharmacy submission handler.
 * Uses OAuth2 client_credentials — token obtained fresh each submission (TTL 1 hour).
 * Docs: https://docs.rxvortex.net/guides/basic/
 *
 * Product → medication mapping:
 *   Each product in the order is looked up in product_treatment_map to find
 *   its rxvortex_preset_catalog_id. Falls back to the clinic-level
 *   pharmacy_preset_catalog_id if not set at the product level.
 */
import { normalizePhone } from "./normalize-phone"

interface RxVortexClinic {
  pharmacy_api_url: string
  pharmacy_client_id: string
  pharmacy_client_secret: string
  pharmacy_subdomain: string
  pharmacy_preset_catalog_id: string   // clinic-level fallback
  pharmacy_doctor_first_name: string
  pharmacy_doctor_last_name: string
  pharmacy_doctor_npi: string
  pharmacy_prescriber_dea: string
  pharmacy_prescriber_address: string
  pharmacy_prescriber_city: string
  pharmacy_prescriber_state: string
  pharmacy_prescriber_zip: string
  pharmacy_prescriber_phone: string
  pharmacy_vendor_name: string
  pharmacy_pay_type: string
  pharmacy_ship_type: string
}

/**
 * Resolve the base URL for RxVortex.
 * - pharmacy_api_url if explicitly set (sandbox override).
 * - Otherwise build from subdomain: https://{subdomain}.rxvortex.net
 * - Final fallback: sandbox.
 */
function resolveBaseUrl(clinic: RxVortexClinic): string {
  if (clinic.pharmacy_api_url?.trim()) {
    return clinic.pharmacy_api_url.trim().replace(/\/$/, "")
  }
  if (clinic.pharmacy_subdomain?.trim()) {
    return `https://${clinic.pharmacy_subdomain.trim()}.rxvortex.net`
  }
  return "https://sandbox.rxvortex.net"
}

export async function getRxVortexToken(baseUrl: string, clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/generate-access-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`RxVortex auth failed: HTTP ${res.status} — ${text.slice(0, 200)}`)
  }
  const data = await res.json()
  if (data.error || !data.access_token) {
    throw new Error(`RxVortex auth error: ${data.msg || JSON.stringify(data)}`)
  }
  return data.access_token
}

export async function submitToRxVortex(
  pg: any,
  clinic: RxVortexClinic,
  order: any,
  workflowId: string,
  drugName: string,
  rxNumber: string,
  treatmentDosages: any[]
): Promise<void> {
  const baseUrl = resolveBaseUrl(clinic)

  // Get OAuth access token
  const token = await getRxVortexToken(baseUrl, clinic.pharmacy_client_id, clinic.pharmacy_client_secret)

  const eligibility = (order.metadata || {}).eligibility || {}
  const dob = eligibility.dob
    ? new Date(eligibility.dob).toISOString().split("T")[0]
    : "1990-01-01"
  const gender = eligibility.sex === "female" ? "female" : "male"

  const dosages = Array.isArray(treatmentDosages) ? treatmentDosages : []

  // ── Fetch all line items for this order with their product IDs ─────────────
  const itemsResult = await pg.raw(`
    SELECT
      oli.id        AS line_item_id,
      oli.title     AS item_title,
      oi.quantity,
      oi.item_id,
      oli.product_id
    FROM order_item oi
    JOIN order_line_item oli ON oli.id = oi.item_id
    WHERE oi.order_id = ?
    ORDER BY oi.created_at
  `, [order.id])

  const lineItems = itemsResult.rows

  // ── Look up rxvortex_preset_catalog_id per product from product_treatment_map ──
  // We look up by tenant_domain (from order_workflow join) + product_id
  const tenantResult = await pg.raw(
    `SELECT tenant_domain FROM order_workflow WHERE id = ? LIMIT 1`,
    [workflowId]
  )
  const tenantDomain = tenantResult.rows[0]?.tenant_domain || ""

  // Build map: product_id → { preset_catalog_id, treatment_id, instructions }
  const productCatalogMap: Record<string, string> = {}
  const productTreatmentMap: Record<string, number> = {}
  const productInstructionMap: Record<string, string> = {}
  if (lineItems.length > 0 && tenantDomain) {
    const productIds = lineItems.map((li: any) => li.product_id).filter(Boolean)
    if (productIds.length > 0) {
      // Look up by any domain belonging to the same clinic, not just the order's
      // tenant_domain — mappings are stored under clinic.domains[0] which may differ
      // from the order's tenant_domain (e.g. spaderx.com vs spaderx.local).
      const mappingResult = await pg.raw(`
        SELECT product_id, treatment_id, rxvortex_preset_catalog_id, rxvortex_instructions
        FROM product_treatment_map
        WHERE product_id = ANY(?)
          AND tenant_domain IN (
            SELECT unnest(cl.domains)
            FROM clinic cl
            WHERE ? = ANY(cl.domains)
              AND cl.deleted_at IS NULL
            LIMIT 1
          )
      `, [productIds, tenantDomain])
      for (const row of mappingResult.rows) {
        productTreatmentMap[row.product_id] = Number(row.treatment_id)
        if (row.rxvortex_preset_catalog_id) {
          productCatalogMap[row.product_id] = row.rxvortex_preset_catalog_id
        }
        if (row.rxvortex_instructions) {
          productInstructionMap[row.product_id] = row.rxvortex_instructions
        }
      }
    }
  }

  // Build dosage lookup: treatmentId → dosage string
  const dosageByTreatmentId: Record<number, string> = {}
  for (const d of dosages) {
    if (d.treatmentId) {
      dosageByTreatmentId[Number(d.treatmentId)] = d.dosage || ""
    }
  }

  const clinicFallbackCatalogId = (clinic.pharmacy_preset_catalog_id || "").trim()

  // ── Build medication_requests — one per line item ─────────────────────────
  const medicationRequests = lineItems.map((li: any, idx: number) => {
    // Match dosage by treatment_id (precise) → fallback to first dosage
    const treatmentId = li.product_id ? productTreatmentMap[li.product_id] : undefined
    const matchedDosage = treatmentId
      ? (dosageByTreatmentId[treatmentId] || "")
      : (dosages[idx]?.dosage || dosages[0]?.dosage || "")

    // Use product-specific instructions from mapping, fall back to generic text.
    // Dosage from MHC is appended after a dash so the pharmacist sees both.
    const baseInstruction = (li.product_id && productInstructionMap[li.product_id])
      || "Take as directed"
    const instructions = matchedDosage
      ? `${baseInstruction} — ${matchedDosage}`
      : baseInstruction

    // note field carries dosage explicitly for pharmacist clarity
    const note = matchedDosage ? `Prescribed dosage: ${matchedDosage}` : ""

    // Resolve preset_catalog_id: per-product → clinic fallback
    const presetCatalogId = (li.product_id && productCatalogMap[li.product_id])
      || clinicFallbackCatalogId
      || null

    const request: Record<string, any> = {
      type: "new",
      refills: 0,
      sender_med_request_id: `${rxNumber}-${idx + 1}`,
      quantity: li.quantity || 1,
      quantity_units: "each",
      days_supply_duration: 30,
      instructions,
      authored_on_datetime: new Date().toISOString(),
    }

    if (note) request.note = note

    if (presetCatalogId) {
      request.preset_catalog_id = presetCatalogId
    } else {
      // Mark as missing — we'll abort the whole submission below rather than
      // sending a request RxVortex will always reject with "can't be blank".
      request._missing_catalog_id = true
      request._product_title = li.item_title || li.product_id || "unknown"
    }

    return request
  })

  // Abort if any item has no catalog ID — RxVortex requires preset_catalog_id
  // and will reject the whole order. Admin must set rxvortex_preset_catalog_id
  // in the product mapping tab before this order can be submitted.
  const missing = medicationRequests.filter((r: any) => r._missing_catalog_id)
  if (missing.length > 0) {
    const names = missing.map((r: any) => r._product_title).join(", ")
    throw new Error(
      `RxVortex submission blocked — preset_catalog_id not set for: ${names}. ` +
      `Set it in the product mapping tab for this clinic.`
    )
  }

  // If no line items were found, fall back to a single request using drug name
  if (medicationRequests.length === 0) {
    const fallbackDosage = dosages[0]?.dosage || ""
    const fallback: Record<string, any> = {
      type: "new",
      refills: 0,
      sender_med_request_id: `${rxNumber}-1`,
      quantity: 1,
      quantity_units: "each",
      days_supply_duration: 30,
      instructions: fallbackDosage ? `Take as directed — ${fallbackDosage}` : "Take as directed",
      authored_on_datetime: new Date().toISOString(),
    }
    if (fallbackDosage) fallback.note = `Prescribed dosage: ${fallbackDosage}`
    if (clinicFallbackCatalogId) {
      fallback.preset_catalog_id = clinicFallbackCatalogId
    } else {
      fallback.medication_name = drugName.replace(/[\n\t"\\]/g, "").trim()
    }
    medicationRequests.push(fallback)
  }

  // Phone: shipping address → billing address (already COALESCE'd in the caller query) →
  // customer record. RxVortex requires a non-blank phone.
  let patientPhone = normalizePhone(order.phone) || ""
  if (!patientPhone && order.email) {
    const custResult = await pg.raw(
      `SELECT phone FROM customer WHERE email = ? AND deleted_at IS NULL LIMIT 1`,
      [order.email]
    )
    patientPhone = normalizePhone(custResult.rows[0]?.phone) || ""
  }

  const shipTo = clinic.pharmacy_ship_type === "ship_to_clinic" ? "clinic" : "patient"

  const payload: Record<string, any> = {
    patient: {
      first_name: (order.first_name || "Patient").trim(),
      last_name: (order.last_name || ".").trim(),
      dob,
      gender,
      phone: patientPhone,
      email: order.email || "",
      address: {
        line1: order.address_1 || "",
        city: order.city || "",
        state: (order.province || "").toUpperCase(),
        postal_code: (order.postal_code || "").replace(/[^\d-]/g, ""),
      },
    },
    prescriber: {
      first_name: (clinic.pharmacy_doctor_first_name || "Provider").trim(),
      last_name: (clinic.pharmacy_doctor_last_name || ".").trim(),
      npi: (clinic.pharmacy_doctor_npi || "0000000000").replace(/\D/g, ""),
      dea_number: clinic.pharmacy_prescriber_dea || "",
      phone: normalizePhone(clinic.pharmacy_prescriber_phone) || "",
      address: {
        line1: clinic.pharmacy_prescriber_address || "",
        city: clinic.pharmacy_prescriber_city || "",
        state: (clinic.pharmacy_prescriber_state || "").toUpperCase(),
        postal_code: clinic.pharmacy_prescriber_zip || "",
      },
    },
    order: {
      bill_to: clinic.pharmacy_pay_type === "clinic_pay" ? "practice" : "patient",
      ship_to: shipTo,
      sender_order_id: rxNumber,
    },
    // RxVortex requires shipment object — use patient address when shipping to patient
    shipment: {
      recipient_type: shipTo,
      address: {
        line1: order.address_1 || "",
        city: order.city || "",
        state: (order.province || "").toUpperCase(),
        postal_code: (order.postal_code || "").replace(/[^\d-]/g, ""),
      },
    },
    medication_requests: medicationRequests,
  }

  console.log(`[PharmacySubmit-RxVortex] Sending payload:`, JSON.stringify(payload, null, 2))

  const res = await fetch(`${baseUrl}/api/v1/orders`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })

  const data = await res.json()
  console.log(`[PharmacySubmit-RxVortex] Response:`, JSON.stringify(data))

  if (!res.ok) {
    const errMsg = data.message || `RxVortex API error: HTTP ${res.status}`
    throw new Error(data.errors ? `${errMsg} — ${JSON.stringify(data.errors)}` : errMsg)
  }

  // Store rxNumber as pharmacy_queue_id — this is what RxVortex sends back as
  // sender_order_id in webhooks, so the webhook handler can look up the order.
  // Log RxVortex's own order_tracking_id (UUID) for support reference only.
  if (data.order_tracking_id) {
    console.log(`[PharmacySubmit-RxVortex] RxVortex order_tracking_id (internal ref): ${data.order_tracking_id}`)
  }

  await pg.raw(
    `UPDATE order_workflow
     SET pharmacy_queue_id = ?, pharmacy_submitted_at = NOW(), pharmacy_status = 'submitted', updated_at = NOW()
     WHERE id = ?`,
    [rxNumber, workflowId]
  )
  console.log(`[PharmacySubmit-RxVortex] Order submitted. Stored as pharmacy_queue_id: ${rxNumber}`)
}
