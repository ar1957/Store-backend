/**
 * RMM (RequestMyMeds.net / "Partell Pharmacy") submission handler.
 * Uses JWT authentication — token obtained fresh each submission.
 * Per their API doc v2.1.1: POST /prescriptions accepts EITHER a single
 * object OR an array of objects sharing the same prescription_order_id —
 * unlike RxVortex, RMM natively supports multiple scripts in one request,
 * so a split order here is one POST call, not N separate calls.
 *
 * Split orders:
 *   Same order_split_count product config as RxVortex. RMM has no catalog
 *   ID system — the `drug` field is free text a pharmacist reads directly —
 *   so the dosage sequence for a split is resolved via a live call to the
 *   MHC dosage API at submission time (not from treatment_dosage_catalog_map,
 *   which is Strive-catalog-ID-oriented). This is a deliberately different
 *   risk tradeoff than RxVortex: a wrong catalog ID there could mean the
 *   wrong physical medication auto-dispensed with no human check; here it's
 *   a free-text name a pharmacist reads before filling, so a live lookup is
 *   an acceptable convenience rather than "guessing at a binding ID."
 */
import { normalizePhone } from "./normalize-phone"
import { savePharmacySubmissionLog, saveSubOrder, getExistingSubOrderQueueIds } from "./pharmacy-submission-log"
import type { PharmacySubmitOpts } from "./pharmacy-submit-rxvortex"

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

// Same auth flow as clinicSvc.getToken() (POST /login, Basic auth + explicit
// ClientId/ClientSecret headers) — reimplemented here with raw SQL since
// this file only has `pg`, not the clinic module service.
async function getMhcToken(pg: any, clinicId: string): Promise<{ token: string; baseUrl: string }> {
  const clinicResult = await pg.raw(
    `SELECT api_client_id, api_client_secret, api_env, api_base_url_test, api_base_url_prod
     FROM clinic WHERE id = ? LIMIT 1`,
    [clinicId]
  )
  const c = clinicResult.rows[0]
  if (!c?.api_client_id || !c?.api_client_secret) {
    throw new Error("No MHC API credentials configured for this clinic — needed to resolve the dosage sequence for a split order")
  }
  const apiBaseUrl = c.api_env === "prod" ? c.api_base_url_prod : c.api_base_url_test
  const basicAuth = Buffer.from(`${c.api_client_id}:${c.api_client_secret}`).toString("base64")
  const res = await fetch(`${apiBaseUrl}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${basicAuth}`,
      "ClientId": c.api_client_id,
      "ClientSecret": c.api_client_secret,
    },
  })
  if (!res.ok) throw new Error(`MHC auth failed: HTTP ${res.status}`)
  const data = await res.json()
  const token = data?.token || data?.payload?.token
  if (!token) throw new Error("No token returned from MHC login")
  return { token, baseUrl: apiBaseUrl }
}

function parseMonthNumber(dosageKey: string | null | undefined): number {
  if (!dosageKey) return Number.MAX_SAFE_INTEGER
  const m = dosageKey.match(/(\d+)/)
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER
}

async function getMhcDosageTiers(pg: any, clinicId: string, treatmentId: number): Promise<{ key: string; value: string }[]> {
  const { token, baseUrl } = await getMhcToken(pg, clinicId)
  const dosageBaseUrl = baseUrl.replace(/\/endpoint\/v2\/?$/, "")
  const res = await fetch(`${dosageBaseUrl}/api/dosage/treatment/${treatmentId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`MHC dosage fetch failed: HTTP ${res.status}`)
  const data = await res.json()
  const tiers: any[] = Array.isArray(data?.payload) ? data.payload : []
  return tiers
    .map((t: any) => ({ key: String(t.key || ""), value: String(t.value || "") }))
    .sort((a, b) => parseMonthNumber(a.key) - parseMonthNumber(b.key))
}

function normalizeDosage(dosage: string): string {
  return (dosage || "").toLowerCase().replace(/\s+/g, " ").trim()
}

function cleanTreatmentName(name: string): string {
  return (name || "Medication")
    .replace(/^(?:E-Commerce|Pharmacy(?:\s+Returning)?)\s+Online\s+Order:\s*/i, "")
    .replace(/\s*-\s*\d+\s*month\s*supply.*/i, "")
    .trim()
}

// Since RMM has no catalog ID, this free-text name IS the only thing that
// tells a pharmacist which script in a split sequence they're looking at —
// e.g. "Tirzepatide (Subq Inj) - Month 4 - 8 mg (x4)".
function buildMedicationName(treatmentName: string, dosageKey: string | null, dosage: string | null): string {
  const parts = [cleanTreatmentName(treatmentName)]
  if (dosageKey) parts.push(dosageKey)
  if (dosage) parts.push(dosage)
  return parts.join(" - ")
}

interface RmmPrescriptionItem {
  splitIndex: number
  treatmentId: number | null
  productId: string | null
  dosage: string | null
  dosageKey: string | null
  drug: string
  sig: string
  rxUniqueId: string
}

export async function submitToRmm(
  pg: any,
  clinicId: string,
  clinic: RmmClinic,
  order: any,
  workflowId: string,
  drugName: string,
  rxNumber: string,
  treatmentDosages: any[],
  opts?: PharmacySubmitOpts
): Promise<{ queueId: string | null }> {
  const base = opts?.splitIndexBase || 0
  const baseUrl = (clinic.pharmacy_api_url || "https://requestmymeds.net/api/v2").replace(/\/$/, "")

  const token = await getRmmToken(baseUrl, clinic.pharmacy_username, clinic.pharmacy_password)

  const eligibility = (order.metadata || {}).eligibility || {}
  const dob = eligibility.dob
    ? new Date(eligibility.dob).toISOString()
    : "1990-01-01T00:00:00Z"
  const gender = eligibility.sex === "female" ? "F" : "M"

  const dosages = Array.isArray(treatmentDosages) ? treatmentDosages : []

  const buildBasePayload = (item: RmmPrescriptionItem, totalScripts: number) => ({
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
    num_scripts: totalScripts,
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
    rx_unique_id: item.rxUniqueId,
    drug: item.drug.replace(/[\n\t"\\]/g, "").trim(),
    quantity: "1",
    refills: "0",
    sig: item.sig.replace(/[\n\t"\\]/g, "").trim(),
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
  })

  // ── Fetch line items (optionally scoped to just this pharmacy group's products) ──
  const itemsResult = await pg.raw(`
    SELECT oli.id AS line_item_id, oli.title AS item_title, oi.quantity, oli.product_id
    FROM order_item oi
    JOIN order_line_item oli ON oli.id = oi.item_id
    WHERE oi.order_id = ?
    ${opts?.productIdFilter ? "AND oli.product_id = ANY(?)" : ""}
    ORDER BY oi.created_at
  `, opts?.productIdFilter ? [order.id, opts.productIdFilter] : [order.id])
  const lineItems = itemsResult.rows

  // ── No line items at all — single free-text fallback (matches RxVortex) ──
  if (lineItems.length === 0) {
    const fallbackDosage = dosages[0]?.dosage || ""
    const item: RmmPrescriptionItem = {
      splitIndex: 1, treatmentId: null, productId: null,
      dosage: fallbackDosage || null, dosageKey: null,
      drug: drugName, sig: fallbackDosage ? `Take as directed - ${fallbackDosage}` : "Take as directed",
      rxUniqueId: rxNumber,
    }
    const payload = buildBasePayload(item, 1)
    console.log(`[PharmacySubmit-RMM] Sending payload:`, JSON.stringify(payload, null, 2))
    const res = await fetch(`${baseUrl}/prescriptions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    console.log(`[PharmacySubmit-RMM] Response:`, JSON.stringify(data))
    await savePharmacySubmissionLog(pg, workflowId, payload, data)
    if (!res.ok) throw new Error(data.error || `RMM API error: ${res.status}`)
    const queueId = data.rx_unique_id || item.rxUniqueId
    await saveSubOrder(pg, {
      id: `pso_${Date.now()}_1`, workflowId, splitIndex: base + 1, splitCount: 1,
      treatmentId: null, productId: null, dosage: item.dosage, dosageKey: null,
      catalogId: null, queueId, payload, response: data,
      clinicPharmacyId: opts?.clinicPharmacyId ?? null,
    })
    if (!opts?.skipWorkflowUpdate) {
      await pg.raw(
        `UPDATE order_workflow SET pharmacy_queue_id = ?, pharmacy_submitted_at = NOW(), pharmacy_status = 'submitted', clinic_pharmacy_id = ?, updated_at = NOW() WHERE id = ?`,
        [String(queueId), opts?.clinicPharmacyId ?? null, workflowId]
      )
    }
    console.log(`[PharmacySubmit-RMM] Order submitted. rx_unique_id: ${queueId}`)
    return { queueId: String(queueId) }
  }

  // ── Look up product → treatment + order_split_count ────────────────────
  const tenantResult = await pg.raw(`SELECT tenant_domain FROM order_workflow WHERE id = ? LIMIT 1`, [workflowId])
  const tenantDomain = tenantResult.rows[0]?.tenant_domain || ""

  const productTreatmentMap: Record<string, number> = {}
  const productSplitCountMap: Record<string, number> = {}
  if (tenantDomain) {
    const productIds = lineItems.map((li: any) => li.product_id).filter(Boolean)
    if (productIds.length > 0) {
      const mappingResult = await pg.raw(`
        SELECT product_id, treatment_id, order_split_count
        FROM product_treatment_map
        WHERE product_id = ANY(?)
          AND tenant_domain IN (
            SELECT unnest(cl.domains) FROM clinic cl WHERE ? = ANY(cl.domains) AND cl.deleted_at IS NULL LIMIT 1
          )
      `, [productIds, tenantDomain])
      for (const row of mappingResult.rows) {
        productTreatmentMap[row.product_id] = Number(row.treatment_id)
        productSplitCountMap[row.product_id] = Number(row.order_split_count) || 0
      }
    }
  }

  const dosageByTreatmentId: Record<number, string> = {}
  const treatmentNameById: Record<number, string> = {}
  for (const d of dosages) {
    if (d.treatmentId) {
      dosageByTreatmentId[Number(d.treatmentId)] = d.dosage || ""
      treatmentNameById[Number(d.treatmentId)] = d.treatmentName || ""
    }
  }

  // ── Build the flat list of prescriptions to submit (split items expand to N) ──
  const existingByIndex = await getExistingSubOrderQueueIds(pg, workflowId)
  const errors: string[] = []
  const allItems: RmmPrescriptionItem[] = []
  const toSubmit: RmmPrescriptionItem[] = []

  let splitIndexCounter = base + 1
  for (const li of lineItems) {
    const treatmentId = li.product_id ? productTreatmentMap[li.product_id] : undefined
    const splitCount = li.product_id ? (productSplitCountMap[li.product_id] || 0) : 0
    const treatmentNameRaw = (treatmentId && treatmentNameById[treatmentId]) || li.item_title || "Medication"

    if (splitCount > 0) {
      if (!treatmentId) {
        errors.push(`${li.item_title || li.product_id}: no treatment mapping found, cannot determine dosage sequence`)
        splitIndexCounter += splitCount
        continue
      }
      let tiers: { key: string; value: string }[]
      try {
        tiers = await getMhcDosageTiers(pg, clinicId, treatmentId)
      } catch (err: any) {
        errors.push(`${li.item_title}: failed to fetch dosage sequence from MHC — ${err.message}`)
        splitIndexCounter += splitCount
        continue
      }
      const approvedDosage = dosageByTreatmentId[treatmentId] || ""
      const startIdx = tiers.findIndex(t => normalizeDosage(t.value) === normalizeDosage(approvedDosage))
      if (startIdx === -1) {
        errors.push(`${li.item_title}: approved dosage "${approvedDosage}" was not found in the MHC dosage sequence for treatment ${treatmentId}`)
        splitIndexCounter += splitCount
        continue
      }
      for (let i = 0; i < splitCount; i++) {
        const splitIndex = splitIndexCounter++
        const tierIdx = Math.min(startIdx + i, tiers.length - 1)
        const tier = tiers[tierIdx]
        const item: RmmPrescriptionItem = {
          splitIndex, treatmentId, productId: li.product_id,
          dosage: tier.value, dosageKey: tier.key,
          drug: buildMedicationName(treatmentNameRaw, tier.key, tier.value),
          sig: `Take as directed - ${tier.value}`,
          rxUniqueId: `${rxNumber}-S${splitIndex}`,
        }
        allItems.push(item)
        if (!existingByIndex.get(splitIndex)) toSubmit.push(item)
      }
    } else {
      const splitIndex = splitIndexCounter++
      const matchedDosage = treatmentId ? (dosageByTreatmentId[treatmentId] || "") : (dosages[0]?.dosage || "")
      const item: RmmPrescriptionItem = {
        splitIndex, treatmentId: treatmentId ?? null, productId: li.product_id,
        dosage: matchedDosage || null, dosageKey: null,
        drug: buildMedicationName(treatmentNameRaw, null, matchedDosage || null),
        sig: matchedDosage ? `Take as directed - ${matchedDosage}` : "Take as directed",
        rxUniqueId: `${rxNumber}-${splitIndex}`,
      }
      allItems.push(item)
      if (!existingByIndex.get(splitIndex)) toSubmit.push(item)
    }
  }

  const totalScripts = allItems.length

  // ── Submit whatever's left (idempotent — already-succeeded items are skipped) ──
  if (toSubmit.length > 0) {
    const payloads = toSubmit.map(item => buildBasePayload(item, totalScripts))
    const requestBody: any = payloads.length === 1 ? payloads[0] : payloads
    console.log(`[PharmacySubmit-RMM] Sending payload (${payloads.length} script(s)):`, JSON.stringify(requestBody, null, 2))

    const res = await fetch(`${baseUrl}/prescriptions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    })
    const data = await res.json()
    console.log(`[PharmacySubmit-RMM] Response:`, JSON.stringify(data))
    await savePharmacySubmissionLog(pg, workflowId, requestBody, data)

    if (payloads.length === 1) {
      if (!res.ok) {
        errors.push(`${toSubmit[0].drug}: ${data.error || `RMM API error: ${res.status}`}`)
      } else {
        const queueId = data.rx_unique_id || toSubmit[0].rxUniqueId
        await saveSubOrder(pg, {
          id: `pso_${Date.now()}_${toSubmit[0].splitIndex}`, workflowId,
          splitIndex: toSubmit[0].splitIndex, splitCount: totalScripts,
          treatmentId: toSubmit[0].treatmentId, productId: toSubmit[0].productId,
          dosage: toSubmit[0].dosage, dosageKey: toSubmit[0].dosageKey,
          catalogId: null, queueId, payload: requestBody, response: data,
          clinicPharmacyId: opts?.clinicPharmacyId ?? null,
        })
      }
    } else {
      // Array submission — per-item results in the same order as the request array.
      const results: any[] = Array.isArray(data) ? data : []
      for (let i = 0; i < toSubmit.length; i++) {
        const item = toSubmit[i]
        const itemResult = results[i]
        if (!itemResult || itemResult.error) {
          errors.push(`${item.drug}: ${itemResult?.error || data.error || `RMM API error: ${res.status}`}`)
          continue
        }
        const queueId = itemResult.rx_unique_id || item.rxUniqueId
        await saveSubOrder(pg, {
          id: `pso_${Date.now()}_${item.splitIndex}`, workflowId,
          splitIndex: item.splitIndex, splitCount: totalScripts,
          treatmentId: item.treatmentId, productId: item.productId,
          dosage: item.dosage, dosageKey: item.dosageKey,
          catalogId: null, queueId, payload: payloads[i], response: itemResult,
          clinicPharmacyId: opts?.clinicPharmacyId ?? null,
        })
      }
    }
  }

  // Any failure blocks marking the order fully submitted — successful
  // scripts stay recorded (already placed with the pharmacy, rx_unique_id
  // can't be resubmitted) and are skipped as already-done on the next retry.
  if (errors.length > 0) {
    throw new Error(`RMM submission incomplete — ${errors.join(" | ")}`)
  }

  const firstQueueId = allItems[0]?.rxUniqueId || rxNumber
  if (!opts?.skipWorkflowUpdate) {
    await pg.raw(
      `UPDATE order_workflow SET pharmacy_queue_id = ?, pharmacy_submitted_at = NOW(), pharmacy_status = 'submitted', clinic_pharmacy_id = ?, updated_at = NOW() WHERE id = ?`,
      [firstQueueId, opts?.clinicPharmacyId ?? null, workflowId]
    )
  }
  console.log(`[PharmacySubmit-RMM] Order fully submitted (${totalScripts} script(s)). Primary pharmacy_queue_id: ${firstQueueId}`)
  return { queueId: firstQueueId }
}
