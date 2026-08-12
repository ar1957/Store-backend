/**
 * RxVortex (Strive) pharmacy submission handler.
 * Uses OAuth2 client_credentials — token obtained fresh each submission (TTL 1 hour).
 * Docs: https://docs.rxvortex.net/guides/basic/
 *
 * Product → medication mapping:
 *   Each product in the order is looked up in product_treatment_map to find
 *   its rxvortex_preset_catalog_id. Falls back to the clinic-level
 *   pharmacy_preset_catalog_id if not set at the product level.
 *
 * Split orders:
 *   A product's order_split_count (set in product_treatment_map) controls
 *   whether it submits as one bundled order (0, default — unchanged behavior)
 *   or as N separate pharmacy orders, one per month, each at the next dosage
 *   tier up from the provider-approved starting dose. Each split is its own
 *   RxVortex order (own sender_order_id, own tracking) rather than just its
 *   own line item within one order, because the pharmacy staggers shipping
 *   per order, not per line item. Dosage tiers for a split come entirely from
 *   treatment_dosage_catalog_map (never a live MHC call at submission time),
 *   so every tier picked is guaranteed to already have a mapped catalog ID.
 *   Every attempted order (bundled or split) gets a row in pharmacy_sub_order;
 *   retries are idempotent — a split that already has a pharmacy_queue_id is
 *   skipped, only unsubmitted ones are retried.
 */
import { normalizePhone } from "./normalize-phone"
import { savePharmacySubmissionLog, saveSubOrder, getExistingSubOrderQueueIds } from "./pharmacy-submission-log"

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
    const sub = clinic.pharmacy_subdomain.trim()
    // If the stored value is already a full domain (contains a dot), use it directly
    if (sub.includes(".")) return `https://${sub}`.replace(/\/$/, "")
    return `https://${sub}.rxvortex.net`
  }
  return "https://sandbox.rxvortex.net"
}

// Normalizes a dosage string for matching against treatment_dosage_catalog_map
// so minor formatting drift (extra spaces, casing) between the GFE-synced
// dosage and the admin-entered mapping doesn't cause a spurious fallback.
function normalizeDosage(dosage: string): string {
  return (dosage || "").toLowerCase().replace(/\s+/g, " ").trim()
}

// Extracts the leading number from a dosage_key ("Month 8+" -> 8) for
// ordering tiers. Unlabeled rows sort last rather than crashing the sort.
function parseMonthNumber(dosageKey: string | null | undefined): number {
  if (!dosageKey) return Number.MAX_SAFE_INTEGER
  const m = dosageKey.match(/(\d+)/)
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER
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

// saveSubOrder / getExistingSubOrderQueueIds moved to pharmacy-submission-log.ts
// (shared with RMM, which uses the same pharmacy_sub_order tracking).

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

  // ── Look up rxvortex_preset_catalog_id + order_split_count per product ────
  const tenantResult = await pg.raw(
    `SELECT tenant_domain FROM order_workflow WHERE id = ? LIMIT 1`,
    [workflowId]
  )
  const tenantDomain = tenantResult.rows[0]?.tenant_domain || ""

  const productCatalogMap: Record<string, string> = {}
  const productTreatmentMap: Record<string, number> = {}
  const productInstructionMap: Record<string, string> = {}
  const productSplitCountMap: Record<string, number> = {}
  if (lineItems.length > 0 && tenantDomain) {
    const productIds = lineItems.map((li: any) => li.product_id).filter(Boolean)
    if (productIds.length > 0) {
      // Look up by any domain belonging to the same clinic, not just the order's
      // tenant_domain — mappings are stored under clinic.domains[0] which may differ
      // from the order's tenant_domain (e.g. spaderx.com vs spaderx.local).
      const mappingResult = await pg.raw(`
        SELECT product_id, treatment_id, rxvortex_preset_catalog_id, rxvortex_instructions, order_split_count
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
        productSplitCountMap[row.product_id] = Number(row.order_split_count) || 0
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

  // ── Look up dosage-specific catalog IDs from treatment_dosage_catalog_map ──
  // A product's catalog ID can vary by prescribed dosage (e.g. Strive has a
  // different catalog item per strength/month), so this takes priority over
  // the single per-product catalog ID above when a match exists.
  const dosageCatalogMap: Record<string, string> = {}
  const dosageInstructionMap: Record<string, string> = {}
  // Treatments that have ANY row in treatment_dosage_catalog_map are treated
  // as dosage-driven — a single "default" catalog ID can't be clinically
  // correct for a drug that's titrated, so these must resolve strictly via
  // the dosage table with no silent fallback to the general/clinic ID.
  const treatmentsWithDosageMapping = new Set<number>()
  // Ordered dosage tiers per treatment (sorted by dosage_key's month number),
  // used to resolve split orders — the next tier up from the approved dose.
  const dosageTiersByTreatment: Record<number, { dosage: string; dosageKey: string | null; catalogId: string; instructions: string | null }[]> = {}
  const treatmentIds = [...new Set(Object.keys(dosageByTreatmentId).map(Number))]
  if (treatmentIds.length > 0 && tenantDomain) {
    const dosageMappingResult = await pg.raw(`
      SELECT treatment_id, dosage, dosage_key, rxvortex_preset_catalog_id, rxvortex_instructions
      FROM treatment_dosage_catalog_map
      WHERE treatment_id = ANY(?)
        AND deleted_at IS NULL
        AND tenant_domain IN (
          SELECT unnest(cl.domains)
          FROM clinic cl
          WHERE ? = ANY(cl.domains)
            AND cl.deleted_at IS NULL
          LIMIT 1
        )
    `, [treatmentIds, tenantDomain])
    for (const row of dosageMappingResult.rows) {
      const tid = Number(row.treatment_id)
      const key = `${tid}::${normalizeDosage(row.dosage)}`
      dosageCatalogMap[key] = row.rxvortex_preset_catalog_id
      if (row.rxvortex_instructions) dosageInstructionMap[key] = row.rxvortex_instructions
      treatmentsWithDosageMapping.add(tid)

      if (!dosageTiersByTreatment[tid]) dosageTiersByTreatment[tid] = []
      dosageTiersByTreatment[tid].push({
        dosage: row.dosage,
        dosageKey: row.dosage_key,
        catalogId: row.rxvortex_preset_catalog_id,
        instructions: row.rxvortex_instructions,
      })
    }
    for (const tid of Object.keys(dosageTiersByTreatment)) {
      dosageTiersByTreatment[Number(tid)].sort((a, b) => parseMonthNumber(a.dosageKey) - parseMonthNumber(b.dosageKey))
    }
  }

  const clinicFallbackCatalogId = (clinic.pharmacy_preset_catalog_id || "").trim()

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

  const basePatient = {
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
  }
  const basePrescriber = {
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
  }
  const baseShipment = {
    recipient_type: shipTo,
    address: {
      line1: order.address_1 || "",
      city: order.city || "",
      state: (order.province || "").toUpperCase(),
      postal_code: (order.postal_code || "").replace(/[^\d-]/g, ""),
    },
  }

  // ── No line items at all — fall back to a single free-text request ────────
  if (lineItems.length === 0) {
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

    const payload = {
      patient: basePatient, prescriber: basePrescriber,
      order: { bill_to: clinic.pharmacy_pay_type === "clinic_pay" ? "practice" : "patient", ship_to: shipTo, sender_order_id: rxNumber },
      shipment: baseShipment,
      medication_requests: [fallback],
    }
    console.log(`[PharmacySubmit-RxVortex] Sending payload:`, JSON.stringify(payload, null, 2))
    const res = await fetch(`${baseUrl}/api/v1/orders`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    console.log(`[PharmacySubmit-RxVortex] Response:`, JSON.stringify(data))
    await savePharmacySubmissionLog(pg, workflowId, payload, data)
    if (!res.ok) {
      const errMsg = data.message || `RxVortex API error: HTTP ${res.status}`
      throw new Error(data.errors ? `${errMsg} — ${JSON.stringify(data.errors)}` : errMsg)
    }
    await saveSubOrder(pg, {
      id: `pso_${Date.now()}`, workflowId, splitIndex: 1, splitCount: 1,
      treatmentId: null, productId: null, dosage: fallbackDosage || null, dosageKey: null,
      catalogId: fallback.preset_catalog_id || null, queueId: rxNumber, payload, response: data,
    })
    await pg.raw(
      `UPDATE order_workflow SET pharmacy_queue_id = ?, pharmacy_submitted_at = NOW(), pharmacy_status = 'submitted', updated_at = NOW() WHERE id = ?`,
      [rxNumber, workflowId]
    )
    console.log(`[PharmacySubmit-RxVortex] Order submitted. Stored as pharmacy_queue_id: ${rxNumber}`)
    return
  }

  // ── Partition line items: split (own orders per month) vs bundled (today's behavior) ──
  const splitLineItems: any[] = []
  const bundledLineItems: any[] = []
  for (const li of lineItems) {
    const splitCount = li.product_id ? (productSplitCountMap[li.product_id] || 0) : 0
    if (splitCount > 0) splitLineItems.push({ ...li, splitCount })
    else bundledLineItems.push(li)
  }

  // ── Load already-submitted sub-orders for idempotent retry ────────────────
  const existingByIndex = await getExistingSubOrderQueueIds(pg, workflowId)

  const errors: string[] = []
  let firstQueueId: string | null = null
  let splitIndexCounter = bundledLineItems.length > 0 ? 2 : 1

  // ── Bundled order (index 1) — same medication_requests logic as before ────
  if (bundledLineItems.length > 0) {
    const existingQueueId = existingByIndex.get(1)
    if (existingQueueId) {
      firstQueueId = firstQueueId || existingQueueId
    } else {
      try {
        const medicationRequests = bundledLineItems.map((li: any, idx: number) => {
          const treatmentId = li.product_id ? productTreatmentMap[li.product_id] : undefined
          const matchedDosage = treatmentId
            ? (dosageByTreatmentId[treatmentId] || "")
            : (dosages[idx]?.dosage || dosages[0]?.dosage || "")

          const dosageKey = treatmentId ? `${treatmentId}::${normalizeDosage(matchedDosage)}` : ""

          const baseInstruction = (dosageKey && dosageInstructionMap[dosageKey])
            || (li.product_id && productInstructionMap[li.product_id])
            || "Take as directed"
          const instructions = matchedDosage ? `${baseInstruction} — ${matchedDosage}` : baseInstruction
          const note = matchedDosage ? `Prescribed dosage: ${matchedDosage}` : ""

          const isDosageDriven = treatmentId ? treatmentsWithDosageMapping.has(treatmentId) : false
          const presetCatalogId = isDosageDriven
            ? ((dosageKey && dosageCatalogMap[dosageKey]) || null)
            : ((li.product_id && productCatalogMap[li.product_id]) || clinicFallbackCatalogId || null)

          const request: Record<string, any> = {
            type: "new", refills: 0,
            sender_med_request_id: `${rxNumber}-${idx + 1}`,
            quantity: li.quantity || 1, quantity_units: "each", days_supply_duration: 30,
            instructions, authored_on_datetime: new Date().toISOString(),
          }
          if (note) request.note = note
          if (presetCatalogId) {
            request.preset_catalog_id = presetCatalogId
          } else {
            request._missing_catalog_id = true
            request._product_title = li.item_title || li.product_id || "unknown"
          }
          return request
        })

        const missing = medicationRequests.filter((r: any) => r._missing_catalog_id)
        if (missing.length > 0) {
          const names = missing.map((r: any) => r._product_title).join(", ")
          throw new Error(
            `preset_catalog_id not set for: ${names}. Set it in the product mapping tab for this clinic.`
          )
        }

        const payload = {
          patient: basePatient, prescriber: basePrescriber,
          order: { bill_to: clinic.pharmacy_pay_type === "clinic_pay" ? "practice" : "patient", ship_to: shipTo, sender_order_id: rxNumber },
          shipment: baseShipment,
          medication_requests: medicationRequests,
        }
        console.log(`[PharmacySubmit-RxVortex] Sending payload (bundled):`, JSON.stringify(payload, null, 2))
        const res = await fetch(`${baseUrl}/api/v1/orders`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
        const data = await res.json()
        console.log(`[PharmacySubmit-RxVortex] Response (bundled):`, JSON.stringify(data))
        await savePharmacySubmissionLog(pg, workflowId, payload, data)
        if (!res.ok) {
          const errMsg = data.message || `RxVortex API error: HTTP ${res.status}`
          throw new Error(data.errors ? `${errMsg} — ${JSON.stringify(data.errors)}` : errMsg)
        }
        await saveSubOrder(pg, {
          id: `pso_${Date.now()}_1`, workflowId, splitIndex: 1, splitCount: 1,
          treatmentId: null, productId: null, dosage: null, dosageKey: null,
          catalogId: null, queueId: rxNumber, payload, response: data,
        })
        firstQueueId = firstQueueId || rxNumber
      } catch (err: any) {
        errors.push(`Order: ${err.message}`)
      }
    }
  }

  // ── Split items — one separate RxVortex order per split ───────────────────
  for (const li of splitLineItems) {
    const treatmentId = li.product_id ? productTreatmentMap[li.product_id] : undefined
    if (!treatmentId) {
      errors.push(`${li.item_title || li.product_id}: no treatment mapping found, cannot determine dosage sequence.`)
      splitIndexCounter += li.splitCount
      continue
    }

    const approvedDosage = dosageByTreatmentId[treatmentId] || ""
    const tiers = dosageTiersByTreatment[treatmentId] || []
    const startIdx = tiers.findIndex(t => normalizeDosage(t.dosage) === normalizeDosage(approvedDosage))

    if (startIdx === -1) {
      errors.push(
        `${li.item_title || li.product_id}: approved dosage "${approvedDosage}" is not mapped in the dosage → catalog table for treatment ${treatmentId}. ` +
        `Map it in the product mapping tab before this order can be split and submitted.`
      )
      splitIndexCounter += li.splitCount
      continue
    }

    for (let i = 0; i < li.splitCount; i++) {
      const splitIndex = splitIndexCounter++
      const existingQueueId = existingByIndex.get(splitIndex)
      if (existingQueueId) {
        firstQueueId = firstQueueId || existingQueueId
        continue
      }

      // Tiers beyond the mapped list reuse the last (topped-out) tier —
      // e.g. "Month 8+" represents the terminal dose the patient stays on.
      const tierIdx = Math.min(startIdx + i, tiers.length - 1)
      const tier = tiers[tierIdx]

      try {
        const splitSenderOrderId = `${rxNumber}-S${splitIndex}`
        const baseInstruction = tier.instructions || (li.product_id && productInstructionMap[li.product_id]) || "Take as directed"
        const medicationRequest: Record<string, any> = {
          type: "new", refills: 0,
          sender_med_request_id: `${splitSenderOrderId}-1`,
          quantity: li.quantity || 1, quantity_units: "each", days_supply_duration: 30,
          instructions: `${baseInstruction} — ${tier.dosage}`,
          note: `Prescribed dosage: ${tier.dosage} (split ${i + 1} of ${li.splitCount})`,
          authored_on_datetime: new Date().toISOString(),
          preset_catalog_id: tier.catalogId,
        }

        const payload = {
          patient: basePatient, prescriber: basePrescriber,
          order: { bill_to: clinic.pharmacy_pay_type === "clinic_pay" ? "practice" : "patient", ship_to: shipTo, sender_order_id: splitSenderOrderId },
          shipment: baseShipment,
          medication_requests: [medicationRequest],
        }
        console.log(`[PharmacySubmit-RxVortex] Sending payload (split ${i + 1}/${li.splitCount}):`, JSON.stringify(payload, null, 2))
        const res = await fetch(`${baseUrl}/api/v1/orders`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
        const data = await res.json()
        console.log(`[PharmacySubmit-RxVortex] Response (split ${i + 1}/${li.splitCount}):`, JSON.stringify(data))
        if (!res.ok) {
          const errMsg = data.message || `RxVortex API error: HTTP ${res.status}`
          throw new Error(data.errors ? `${errMsg} — ${JSON.stringify(data.errors)}` : errMsg)
        }
        await saveSubOrder(pg, {
          id: `pso_${Date.now()}_${splitIndex}`, workflowId, splitIndex, splitCount: li.splitCount,
          treatmentId, productId: li.product_id, dosage: tier.dosage, dosageKey: tier.dosageKey,
          catalogId: tier.catalogId, queueId: splitSenderOrderId, payload, response: data,
        })
        firstQueueId = firstQueueId || splitSenderOrderId
      } catch (err: any) {
        errors.push(`${li.item_title || li.product_id} split ${i + 1}/${li.splitCount}: ${err.message}`)
      }
    }
  }

  // Any failure blocks marking the order as fully submitted — successful
  // sub-orders stay recorded (real pharmacy orders were placed and can't be
  // un-submitted) and are skipped as already-done on the next retry; only
  // what actually failed gets attempted again.
  if (errors.length > 0) {
    throw new Error(`RxVortex submission incomplete — ${errors.join(" | ")}`)
  }

  await pg.raw(
    `UPDATE order_workflow SET pharmacy_queue_id = ?, pharmacy_submitted_at = NOW(), pharmacy_status = 'submitted', updated_at = NOW() WHERE id = ?`,
    [firstQueueId, workflowId]
  )
  console.log(`[PharmacySubmit-RxVortex] Order fully submitted. Primary pharmacy_queue_id: ${firstQueueId}`)
}
