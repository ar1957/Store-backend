import { normalizePhone } from "./normalize-phone"
import { submitToRmm } from "./pharmacy-submit-rmm"
import { submitToRxVortex, type PharmacySubmitOpts } from "./pharmacy-submit-rxvortex"
import { savePharmacySubmissionLog } from "./pharmacy-submission-log"

/**
 * Shared pharmacy submission helper.
 * Called when an order transitions to 'processing_pharmacy' status.
 * Handles DigitalRX, RMM, and RxVortex pharmacies.
 *
 * A clinic can have multiple configured pharmacies (clinic_pharmacy table) —
 * each product routes to whichever pharmacy its product_treatment_map row
 * points at (clinic_pharmacy_id), falling back to the clinic's default
 * pharmacy for unmapped products. The overwhelmingly common case is every
 * product in an order resolving to the same single pharmacy (either because
 * the clinic only has one, or because the order just happens not to mix
 * products from different ones) — that path submits exactly as it always
 * has, one call, one order_workflow update. Only when an order's products
 * genuinely span multiple pharmacies does this fan out into one submission
 * per pharmacy, each recorded as its own set of pharmacy_sub_order rows.
 */

interface ClinicPharmacyRow {
  id: string
  pharmacy_type: string | null
  is_default: boolean
  is_enabled: boolean
  pharmacy_api_key: string | null
  pharmacy_store_id: string | null
  pharmacy_api_url: string | null
  pharmacy_vendor_name: string | null
  pharmacy_doctor_first_name: string | null
  pharmacy_doctor_last_name: string | null
  pharmacy_doctor_npi: string | null
  pharmacy_username: string | null
  pharmacy_password: string | null
  pharmacy_prescriber_id: string | null
  pharmacy_prescriber_address: string | null
  pharmacy_prescriber_city: string | null
  pharmacy_prescriber_state: string | null
  pharmacy_prescriber_zip: string | null
  pharmacy_prescriber_phone: string | null
  pharmacy_prescriber_dea: string | null
  pharmacy_ship_type: string | null
  pharmacy_ship_rate: string | null
  pharmacy_pay_type: string | null
  pharmacy_client_id: string | null
  pharmacy_client_secret: string | null
  pharmacy_subdomain: string | null
  pharmacy_preset_catalog_id: string | null
}

function hasCredentials(p: ClinicPharmacyRow): boolean {
  const isRmm = p.pharmacy_type === "rmm"
  const isRxVortex = p.pharmacy_type === "rxvortex"
  if (isRmm) return !!(p.pharmacy_username && p.pharmacy_password)
  if (isRxVortex) return !!(p.pharmacy_client_id && p.pharmacy_client_secret)
  return !!(p.pharmacy_api_key && p.pharmacy_store_id)
}

// Whether this pharmacy should have automatic API submission attempted at
// all — distinct from whether it's a valid routing/visibility target (a
// disabled or manual/no-API pharmacy is still a legitimate place to route a
// product for a pharmacist to fulfill by hand; see resolveOrderClinicPharmacyId).
function canAutoSubmit(p: ClinicPharmacyRow): boolean {
  return p.is_enabled && hasCredentials(p)
}

// Submits to a single resolved pharmacy — dispatches to the provider-specific
// handler, or runs the DigitalRX request inline (DigitalRX has no separate
// submit-*.ts file; it never grew split-order support the way RMM/RxVortex did).
async function submitOneGroup(
  pg: any,
  clinicId: string,
  pharmacy: ClinicPharmacyRow,
  order: any,
  workflowId: string,
  drugName: string,
  rxNumber: string,
  treatmentDosages: any[],
  opts?: PharmacySubmitOpts
): Promise<{ queueId: string | null }> {
  const isRmm = pharmacy.pharmacy_type === "rmm"
  const isRxVortex = pharmacy.pharmacy_type === "rxvortex"

  if (isRmm) {
    return await submitToRmm(pg, clinicId, pharmacy as any, order, workflowId, drugName, rxNumber, treatmentDosages, opts)
  }
  if (isRxVortex) {
    return await submitToRxVortex(pg, pharmacy as any, order, workflowId, drugName, rxNumber, treatmentDosages, opts)
  }

  // ── DigitalRX path ────────────────────────────────────────────────────────
  const eligibility = (order.metadata || {}).eligibility || {}
  const dob = eligibility.dob ? new Date(eligibility.dob).toISOString().split("T")[0] : "1990-01-01"
  const sex = eligibility.sex === "female" ? "F" : "M"
  const apiUrl = (pharmacy.pharmacy_api_url || "https://www.dbswebserver.com/DBSRestApi/API").replace(/\/$/, "")

  const payload = {
    StoreID: (pharmacy.pharmacy_store_id || "").trim(),
    VendorName: (pharmacy.pharmacy_vendor_name || "MHC Store").trim(),
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
      DoctorFirstName: (pharmacy.pharmacy_doctor_first_name || "Provider").trim(),
      DoctorLastName: (pharmacy.pharmacy_doctor_last_name || ".").trim(),
      DoctorNpi: (pharmacy.pharmacy_doctor_npi || "0000000000").replace(/\D/g, ""),
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
    headers: { "Authorization": pharmacy.pharmacy_api_key || "", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })

  const pharmData = await pharmRes.json()
  console.log(`[PharmacySubmit] Response for order ${order.id}:`, JSON.stringify(pharmData))
  await savePharmacySubmissionLog(pg, workflowId, payload, pharmData)

  // API returns { "ID": "12345" } — field is "ID" not "QueueID"
  const queueId = pharmData.ID || pharmData.QueueID || pharmData.id

  if (!pharmRes.ok || !queueId) {
    // DigitalRX has never thrown on failure here — only logged — so a bad
    // response doesn't block the outer try/catch in submitToPharmacyIfEnabled.
    // Preserved as-is for the single-pharmacy case; the multi-pharmacy caller
    // below checks the returned queueId explicitly instead of relying on a throw.
    console.error(`[PharmacySubmit] DigitalRX error for order ${order.id}:`, pharmData)
    return { queueId: null }
  }

  if (!opts?.skipWorkflowUpdate) {
    await pg.raw(
      `UPDATE order_workflow SET pharmacy_queue_id = ?, pharmacy_submitted_at = NOW(), pharmacy_status = 'submitted', clinic_pharmacy_id = ?, updated_at = NOW() WHERE id = ?`,
      [String(queueId), opts?.clinicPharmacyId ?? pharmacy.id, workflowId]
    )
  }
  console.log(`[PharmacySubmit] Order ${order.id} submitted to DigitalRX. QueueID: ${queueId}`)
  return { queueId: String(queueId) }
}

/**
 * Resolves a single "primary" pharmacy for an order at creation time, purely
 * for visibility (which pharmacist can see this order) — independent of
 * whether that pharmacy has API auto-submission configured at all. Called
 * from order-placed.ts, since submitToPharmacyIfEnabled above only tags
 * clinic_pharmacy_id on a *successful* API submission, and a manual/no-API
 * pharmacy (a pharmacist who fulfills by hand, no credentials configured)
 * never has one — without this, orders routed to a manual pharmacy would
 * never get tagged and that pharmacist would never see them.
 *
 * Returns null when the order's products span multiple distinct pharmacies
 * (ambiguous at the order_workflow level — pharmacy_sub_order carries the
 * correct per-item attribution instead, once/if that order is actually
 * submitted) or when the clinic has no pharmacy configured yet.
 */
export async function resolveOrderClinicPharmacyId(pg: any, clinicId: string, orderId: string): Promise<string | null> {
  try {
    // Deliberately not filtered by is_enabled — a disabled/no-API pharmacy
    // (e.g. manual fulfillment) is still a valid, explicit routing target for
    // a product and must still be honored for visibility. is_enabled only
    // controls whether automatic API submission is attempted (see
    // submitToPharmacyIfEnabled below), not whether the pharmacy "counts."
    const pharmaciesResult = await pg.raw(
      `SELECT id, is_default FROM clinic_pharmacy WHERE clinic_id = ? AND deleted_at IS NULL`,
      [clinicId]
    )
    const pharmacies = pharmaciesResult.rows
    if (pharmacies.length === 0) return null
    const defaultPharmacy = pharmacies.find((p: any) => p.is_default) || pharmacies[0]

    const productsResult = await pg.raw(
      `SELECT DISTINCT oli.product_id
       FROM order_item oi
       JOIN order_line_item oli ON oli.id = oi.item_id
       WHERE oi.order_id = ? AND oli.product_id IS NOT NULL`,
      [orderId]
    )
    const productIds: string[] = productsResult.rows.map((r: any) => r.product_id)
    if (productIds.length === 0) return defaultPharmacy.id

    // product_treatment_map.clinic_id is never actually populated by the
    // existing mapping-creation code (only tenant_domain is set) — matching
    // via tenant_domain against the clinic's domains array instead, same
    // pattern already used in pharmacy-submit-rxvortex.ts.
    const mapResult = await pg.raw(
      `SELECT product_id, clinic_pharmacy_id FROM product_treatment_map
       WHERE product_id = ANY(?) AND deleted_at IS NULL
         AND tenant_domain IN (SELECT unnest(domains) FROM clinic WHERE id = ? AND deleted_at IS NULL)`,
      [productIds, clinicId]
    )
    const pharmacyIdSet = new Set(pharmacies.map((p: any) => p.id))
    const productPharmacyMap: Record<string, string> = {}
    for (const row of mapResult.rows) {
      if (row.clinic_pharmacy_id) productPharmacyMap[row.product_id] = row.clinic_pharmacy_id
    }

    const resolvedIds = new Set(
      productIds.map(pid => {
        const mapped = productPharmacyMap[pid]
        return mapped && pharmacyIdSet.has(mapped) ? mapped : defaultPharmacy.id
      })
    )
    return resolvedIds.size === 1 ? [...resolvedIds][0] : null
  } catch {
    return null
  }
}

export async function submitToPharmacyIfEnabled(
  pg: any,
  clinicId: string,
  orderId: string,
  workflowId: string,
  treatmentDosages: any[]
): Promise<void> {
  try {
    // ── Resolve this clinic's configured pharmacies ─────────────────────────
    // Not filtered by is_enabled here — a disabled/no-API pharmacy is still a
    // valid routing target (see canAutoSubmit, checked at dispatch time below).
    const pharmaciesResult = await pg.raw(
      `SELECT id, pharmacy_type, is_default, is_enabled,
              pharmacy_api_key, pharmacy_store_id, pharmacy_api_url, pharmacy_vendor_name,
              pharmacy_doctor_first_name, pharmacy_doctor_last_name, pharmacy_doctor_npi,
              pharmacy_username, pharmacy_password,
              pharmacy_prescriber_id, pharmacy_prescriber_address, pharmacy_prescriber_city,
              pharmacy_prescriber_state, pharmacy_prescriber_zip, pharmacy_prescriber_phone,
              pharmacy_prescriber_dea, pharmacy_ship_type, pharmacy_ship_rate, pharmacy_pay_type,
              pharmacy_client_id, pharmacy_client_secret, pharmacy_subdomain, pharmacy_preset_catalog_id
       FROM clinic_pharmacy WHERE clinic_id = ? AND deleted_at IS NULL`,
      [clinicId]
    )
    const pharmacies: ClinicPharmacyRow[] = pharmaciesResult.rows
    if (pharmacies.length === 0) return // no pharmacy configured for this clinic

    const defaultPharmacy = pharmacies.find(p => p.is_default) || pharmacies[0]

    // Check not already submitted
    const wfCheck = await pg.raw(`SELECT pharmacy_queue_id FROM order_workflow WHERE id = ? LIMIT 1`, [workflowId])
    if (wfCheck.rows[0]?.pharmacy_queue_id) return

    // Get order + patient details
    const orderResult = await pg.raw(
      `SELECT o.id, o.display_id, o.email, o.metadata,
              oa.first_name, oa.last_name, oa.address_1, oa.city, oa.province, oa.postal_code,
              COALESCE(oa.phone, ba.phone) AS phone
       FROM "order" o
       LEFT JOIN order_address oa ON oa.id = o.shipping_address_id
       LEFT JOIN order_address ba ON ba.id = o.billing_address_id
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
          .replace(/^(?:E-Commerce|Pharmacy(?:\s+Returning)?)\s+Online\s+Order:\s*/i, "")
          .replace(/\s*-\s*\d+\s*month\s*supply.*/i, "")
          .trim()
        drugName = d.dosage ? `RXI-${name} - ${d.dosage}` : `RXI-${name}`
      } else if (item?.title) {
        drugName = `RXI-${item.title}`
      }
    } catch {}

    const rxNumber = `RX-${order.display_id}-${Date.now().toString().slice(-6)}`

    // ── Resolve which pharmacy each product routes to ───────────────────────
    const productsResult = await pg.raw(
      `SELECT DISTINCT oli.product_id
       FROM order_item oi
       JOIN order_line_item oli ON oli.id = oi.item_id
       WHERE oi.order_id = ? AND oli.product_id IS NOT NULL`,
      [orderId]
    )
    const productIds: string[] = productsResult.rows.map((r: any) => r.product_id)

    const productPharmacyMap: Record<string, string> = {}
    if (productIds.length > 0) {
      // product_treatment_map.clinic_id is never actually populated by the
      // existing mapping-creation code (only tenant_domain is set) — matching
      // via tenant_domain against the clinic's domains array instead, same
      // pattern already used in pharmacy-submit-rxvortex.ts.
      const mapResult = await pg.raw(
        `SELECT product_id, clinic_pharmacy_id FROM product_treatment_map
         WHERE product_id = ANY(?) AND deleted_at IS NULL
           AND tenant_domain IN (SELECT unnest(domains) FROM clinic WHERE id = ? AND deleted_at IS NULL)`,
        [productIds, clinicId]
      )
      for (const row of mapResult.rows) {
        if (row.clinic_pharmacy_id) productPharmacyMap[row.product_id] = row.clinic_pharmacy_id
      }
    }

    const pharmacyById: Record<string, ClinicPharmacyRow> = {}
    for (const p of pharmacies) pharmacyById[p.id] = p

    // Group product IDs by resolved pharmacy — unmapped products, or products
    // mapped to a pharmacy that's since been disabled/removed, fall back to
    // the clinic's default pharmacy.
    const groups: Record<string, string[]> = {}
    if (productIds.length === 0) {
      groups[defaultPharmacy.id] = []
    } else {
      for (const pid of productIds) {
        const mappedId = productPharmacyMap[pid]
        const resolvedId = mappedId && pharmacyById[mappedId] ? mappedId : defaultPharmacy.id
        if (!groups[resolvedId]) groups[resolvedId] = []
        groups[resolvedId].push(pid)
      }
    }

    const groupPharmacyIds = Object.keys(groups)

    // ── Single pharmacy (the common case, including every clinic that predates
    // this feature) — submit exactly as always: one call, one workflow update ──
    if (groupPharmacyIds.length <= 1) {
      const pharmacy = pharmacyById[groupPharmacyIds[0]] || defaultPharmacy
      if (!canAutoSubmit(pharmacy)) return // disabled or no credentials — manual fulfillment, nothing to auto-submit
      await submitOneGroup(pg, clinicId, pharmacy, order, workflowId, drugName, rxNumber, treatmentDosages, undefined)
      return
    }

    // ── Order's products span multiple pharmacies — submit each group
    // separately (each gets its own sub-order split-index range so they can't
    // collide on the pharmacy_sub_order unique constraint), then aggregate ──
    const errors: string[] = []
    const queueIds: string[] = []
    let splitIndexBase = 0
    let groupIndex = 0
    for (const pharmacyId of groupPharmacyIds) {
      groupIndex++
      const pharmacy = pharmacyById[pharmacyId]
      const groupProductIds = groups[pharmacyId]
      if (!canAutoSubmit(pharmacy)) {
        // Disabled/manual pharmacy in a mixed order — skip silently rather
        // than blocking the other (auto-submittable) groups forever; this
        // group's line items are still correctly tagged for visibility via
        // resolveOrderClinicPharmacyId at order-creation time, just never
        // auto-submitted since there's no API to call.
        splitIndexBase += 1000
        continue
      }
      const groupRxNumber = `${rxNumber}-P${groupIndex}`
      try {
        const result = await submitOneGroup(
          pg, clinicId, pharmacy, order, workflowId, drugName, groupRxNumber, treatmentDosages,
          { productIdFilter: groupProductIds, splitIndexBase, skipWorkflowUpdate: true, clinicPharmacyId: pharmacy.id }
        )
        if (result?.queueId) {
          queueIds.push(result.queueId)
        } else {
          errors.push(`Pharmacy "${pharmacy.pharmacy_vendor_name || pharmacyId}": submission did not return a queue id`)
        }
      } catch (err: any) {
        errors.push(`Pharmacy "${pharmacy.pharmacy_vendor_name || pharmacyId}": ${err.message}`)
      }
      splitIndexBase += 1000
    }

    if (errors.length > 0) {
      // Successful groups already have their pharmacy_sub_order rows recorded
      // and are idempotently skipped on retry — only what failed needs redoing.
      throw new Error(`Multi-pharmacy submission incomplete — ${errors.join(" | ")}`)
    }

    // Split across multiple pharmacies — pharmacy_sub_order.clinic_pharmacy_id
    // is the source of truth for which pharmacy handled what; leave the
    // order_workflow-level clinic_pharmacy_id NULL rather than picking one.
    await pg.raw(
      `UPDATE order_workflow SET pharmacy_queue_id = ?, pharmacy_submitted_at = NOW(), pharmacy_status = 'submitted', updated_at = NOW() WHERE id = ?`,
      [queueIds.join(","), workflowId]
    )
    console.log(`[PharmacySubmit] Order ${orderId} submitted across ${groupPharmacyIds.length} pharmacies: ${queueIds.join(", ")}`)
  } catch (err: any) {
    console.error(`[PharmacySubmit] Error for order ${orderId}:`, err.message)
    throw err
  }
}
