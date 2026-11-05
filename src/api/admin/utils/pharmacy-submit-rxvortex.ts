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
 *   how many monthly prescriptions the product expands into (0 = one rx at
 *   the approved dose). With N > 0 it becomes N medication_requests, one per
 *   month, each at the next dosage tier up from the approved starting dose.
 *   Since 2026-11 (Strive's request) ALL of an order's prescriptions — regular
 *   items and every split month — go in ONE RxVortex order so they ship
 *   together; previously each split month was its own RxVortex order.
 *   Dosage tiers come entirely from treatment_dosage_catalog_map (never a
 *   live MHC call at submission time). One pharmacy_sub_order row is written
 *   per RxVortex order; a retry that finds it already recorded is a no-op.
 */
import { normalizePhone } from "./normalize-phone"
import { savePharmacySubmissionLog, saveSubOrder } from "./pharmacy-submission-log"

// Per Strive: GLP-1 vials have a ~70-day beyond-use date, so a single order
// can carry at most 2 months of a titrated medication.
const MAX_TITRATED_MONTHS_PER_ORDER = 2

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

// True for an open-ended maintenance tier label — "Month 6+", "Month 5 +",
// "Month 8+" — i.e. the dose a patient stays on from that month onward.
// Only these may be reused past the end of the mapped tiers.
function isOpenEndedTier(dosageKey: string | null | undefined): boolean {
  return /\+\s*$/.test((dosageKey || "").trim())
}

// Extracts the leading numeric dose from a dosage string ("14 mg (x4)" -> 14).
// Used only to decide whether an unmapped dose is a continuation PAST the
// highest configured tier (safe to reuse that tier's vial, same "Month 6+
// stays on this dose" convention already used for split orders) vs.
// genuinely unmapped for some other reason (e.g. below the lowest tier) —
// never safe to guess a vial for that case, so it still fails closed.
function parseDoseNumber(dosage: string | null | undefined): number | null {
  const m = (dosage || "").match(/(\d+(?:\.\d+)?)/)
  return m ? parseFloat(m[1]) : null
}

// RxVortex requires quantity_units to be exactly "each" / "ML" / "grams".
// The value stored on the mapping comes straight from their own catalog
// item (captured when the admin picked it in provider-settings), so this
// only normalizes formatting drift (case, "gm"/"g" abbreviations) — it never
// guesses a unit that wasn't already on the catalog item. No mapping stored
// (legacy mappings picked before this field existed, or a manually-typed
// catalog ID) falls back to "each", matching the previous flat behavior.
function normalizeQuantityUnits(raw: string | null | undefined): "each" | "ML" | "grams" {
  const v = (raw || "").trim().toLowerCase()
  if (v === "ml") return "ML"
  if (["g", "gm", "gram", "grams"].includes(v)) return "grams"
  if (["each", "ea", "unit", "units"].includes(v)) return "each"
  return "each"
}

// Strive's medication_form values for injectables all contain "inj" (e.g.
// "Subq Inj", "IM Injection") — matching on that substring rather than an
// exact enum avoids depending on us knowing every form string in their
// catalog. Unknown/missing form is treated as non-injectable (keeps the
// prior 30-day behavior) rather than guessed as injectable.
function isInjectableForm(medicationForm: string | null | undefined): boolean {
  return /inj/i.test(medicationForm || "")
}

// Per Strive feedback: injectables are capped at 28 days_supply_duration
// (multi-dose vial safety window) instead of the flat 30 used for everything
// else.
function resolveDaysSupply(medicationForm: string | null | undefined): number {
  return isInjectableForm(medicationForm) ? 28 : 30
}

// Per Strive feedback: quantity must match the product volume/count on the
// catalog item itself — e.g. a 2ML vial submits quantity: 2 — not the number
// of units the patient added to their cart. The catalog's own `quantity`
// field (captured at mapping-pick-time, same as medication_form/quantity_units
// above) is that number; cart quantity multiplies it only for the edge case
// of a patient legitimately ordering more than one of the same line item.
// Falls back to cart quantity alone when no catalog quantity was captured
// (legacy mappings), matching the previous behavior exactly.
//
// manualOverride (rxvortex_quantity_override) takes priority over the
// catalog's own quantity when set — Strive's catalog only has discrete vial
// sizes, which don't always cover every dose on a clinic's real titration
// schedule (e.g. an 11mg Tirzepatide dose needs 4.4mL total for a 4-week
// supply, but no catalog item is labeled that size). This lets an admin
// reuse a clinically-appropriate existing catalog item (right drug/form/
// concentration) with the correct total volume, instead of requiring a new
// Strive catalog item or a new MHC treatment for every dose that doesn't
// land on an exact vial breakpoint. Does NOT affect days_supply_duration —
// that stays hardcoded to 28 for injectables regardless of quantity
// (resolveDaysSupply), independently satisfying the 28-day multi-dose vial
// puncture rule no matter what quantity is submitted here.
function resolveQuantity(manualOverride: string | null | undefined, catalogQuantity: string | null | undefined, cartQuantity: number): number {
  const overrideParsed = manualOverride != null ? parseFloat(String(manualOverride)) : NaN
  if (Number.isFinite(overrideParsed) && overrideParsed > 0) return overrideParsed * (cartQuantity || 1)
  const catalogParsed = catalogQuantity != null ? parseFloat(String(catalogQuantity)) : NaN
  if (!Number.isFinite(catalogParsed) || catalogParsed <= 0) return cartQuantity || 1
  return catalogParsed * (cartQuantity || 1)
}

// Per Strive: when submitting with preset_catalog_id, whatever is sent in
// `instructions` OVERRIDES their catalog template's own instruction text —
// sending a generic placeholder caused a real order to get flagged for
// pharmacist clarification (see request log for RX-86-896367). Priority:
// 1. An admin's manually-typed override (rxvortex_instructions) — sent
//    verbatim, exactly as typed. Originally this had the patient's dose
//    appended, but an admin typing a full, precise instruction (matching
//    Strive's own phrasing convention, e.g. "Inject 140 units (1.4 mL)
//    subcutaneously once weekly for 4 weeks") doesn't need or want a
//    redundant "— 14 mg (x4)" tacked on — that's the same class of "extra
//    text confusing pharmacists" problem this whole fix exists to prevent.
// 2. The catalog item's own instruction template (rxvortex_catalog_instruction,
//    captured verbatim from Strive's GET /preset-catalog-items at mapping-pick
//    time) — also sent as-is, same reasoning.
// 3. Generic "Take as directed — {dose}" fallback, only when neither of the
//    above was ever captured (legacy mapping) — the dose is appended here
//    only because the placeholder text alone is meaningless without it.
function resolveInstructions(manualOverride: string | null | undefined, catalogInstruction: string | null | undefined, dose: string): string {
  if (manualOverride) return manualOverride
  if (catalogInstruction) return catalogInstruction
  return dose ? `Take as directed — ${dose}` : "Take as directed"
}

// Splits a free-text eligibility answer into discrete DUR entries. Only
// splits on newlines/semicolons (deliberate item separators), never commas —
// a single condition/allergy description often contains a comma itself
// ("Type 2 Diabetes, well controlled"), and splitting on it would fragment
// one entry into garbled pieces. Guarantees at least one entry whenever the
// caller determined there's real content, per RxVortex's schema requirement
// that entries be non-empty when the matching has_known_* flag is true.
function toClinicalEntries(text: string): { description: string }[] {
  const parts = text.split(/[\n;]+/).map(s => s.trim()).filter(Boolean)
  const list = parts.length > 0 ? parts : [text.trim()]
  return list.map(description => ({ description }))
}

// Strive requires a separate `clinical` body (for pharmacist Drug Utilization
// Review), structured per their documented schema
// (https://docs.rxvortex.net/api/operations/rxvortexweborderscontrollercreate/)
// as three nested objects — allergies/diseases/medications — each with its
// own has_known_* boolean and an `entries` array of {description} required
// whenever that boolean is true. Booleans are explicitly False when the data
// isn't known/wasn't checked, never guessed true. Sourced from the same
// eligibility answers already collected at checkout (order-placed.ts stores
// "None" as the empty sentinel, matched here the same way).
function buildClinicalBody(eligibility: Record<string, any>): Record<string, any> {
  const hasValue = (v: any) => typeof v === "string" && v.trim() !== "" && v.trim() !== "None"
  const hasAllergies = hasValue(eligibility.allergies)
  const hasDiseases = hasValue(eligibility.medicalHistory)
  const hasMedications = hasValue(eligibility.currentMedications)
  return {
    allergies: {
      has_known_allergies: hasAllergies,
      ...(hasAllergies ? { entries: toClinicalEntries(eligibility.allergies) } : {}),
    },
    diseases: {
      has_known_diseases: hasDiseases,
      ...(hasDiseases ? { entries: toClinicalEntries(eligibility.medicalHistory) } : {}),
    },
    medications: {
      has_known_medications: hasMedications,
      ...(hasMedications ? { entries: toClinicalEntries(eligibility.currentMedications) } : {}),
    },
  }
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

export interface PharmacySubmitOpts {
  // When set, only line items whose product_id is in this list are submitted
  // — used when an order's products are split across multiple pharmacies and
  // this call handles just one pharmacy's share.
  productIdFilter?: string[] | null
  // Offsets every pharmacy_sub_order.split_index this call creates, so
  // multiple calls against the same order_workflow (one per pharmacy group)
  // never collide on the (order_workflow_id, split_index) unique constraint.
  splitIndexBase?: number
  // When true, skip this function's own order_workflow UPDATE — the caller
  // is aggregating results across multiple pharmacy groups and will do a
  // single UPDATE itself once all groups are attempted.
  skipWorkflowUpdate?: boolean
  // Which clinic_pharmacy this submission belongs to, recorded on every
  // pharmacy_sub_order row it creates.
  clinicPharmacyId?: string | null
}

export async function submitToRxVortex(
  pg: any,
  clinic: RxVortexClinic,
  order: any,
  workflowId: string,
  drugName: string,
  rxNumber: string,
  treatmentDosages: any[],
  opts?: PharmacySubmitOpts
): Promise<{ queueId: string | null }> {
  const base = opts?.splitIndexBase || 0
  const baseUrl = resolveBaseUrl(clinic)

  // Get OAuth access token
  const token = await getRxVortexToken(baseUrl, clinic.pharmacy_client_id, clinic.pharmacy_client_secret)

  const eligibility = (order.metadata || {}).eligibility || {}
  const dob = eligibility.dob
    ? new Date(eligibility.dob).toISOString().split("T")[0]
    : "1990-01-01"
  const gender = eligibility.sex === "female" ? "female" : "male"
  const clinical = buildClinicalBody(eligibility)

  const dosages = Array.isArray(treatmentDosages) ? treatmentDosages : []

  // ── Fetch line items for this order with their product IDs (optionally
  // scoped to just the products this pharmacy group is responsible for) ─────
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
    ${opts?.productIdFilter ? "AND oli.product_id = ANY(?)" : ""}
    ORDER BY oi.created_at
  `, opts?.productIdFilter ? [order.id, opts.productIdFilter] : [order.id])

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
  const productMedFormMap: Record<string, string> = {}
  const productQtyUnitsMap: Record<string, string> = {}
  const productQtyMap: Record<string, string> = {}
  // The RxVortex catalog item's OWN instruction template (e.g. "Inject 140
  // units (1.4 mL) subcutaneously once weekly for 4 weeks") — distinct from
  // productInstructionMap above, which is an admin's manually-typed override.
  // Per Strive: whatever is sent in `instructions` overrides their template
  // entirely, so this is preferred verbatim (no dose text appended) whenever
  // no manual override is set — see resolveInstructions below.
  const productCatalogInstructionMap: Record<string, string> = {}
  const productQtyOverrideMap: Record<string, string> = {}
  if (lineItems.length > 0 && tenantDomain) {
    const productIds = lineItems.map((li: any) => li.product_id).filter(Boolean)
    if (productIds.length > 0) {
      // Look up by any domain belonging to the same clinic, not just the order's
      // tenant_domain — mappings are stored under clinic.domains[0] which may differ
      // from the order's tenant_domain (e.g. spaderx.com vs spaderx.local).
      // Matches the clinic tolerant of a port suffix on tenantDomain (e.g.
      // local dev's "spaderx.local:8000" vs the registered "spaderx.local")
      // — same fallback already used in Migration20240101000025's backfill.
      // LIMIT 1 is applied to the clinic row BEFORE unnest(), not after —
      // unnest() in the SELECT list turns 1 clinic row into N domain rows,
      // so a LIMIT 1 placed outside this inner subquery would silently
      // truncate to just one of the clinic's domains instead of one clinic.
      const mappingResult = await pg.raw(`
        SELECT product_id, treatment_id, rxvortex_preset_catalog_id, rxvortex_instructions, order_split_count,
               rxvortex_medication_form, rxvortex_quantity_units, rxvortex_quantity, rxvortex_catalog_instruction,
               rxvortex_quantity_override
        FROM product_treatment_map
        WHERE product_id = ANY(?)
          AND tenant_domain IN (
            SELECT unnest(cl.domains)
            FROM (
              SELECT domains FROM clinic
              WHERE (? = ANY(domains) OR split_part(?, ':', 1) = ANY(domains))
                AND deleted_at IS NULL
              LIMIT 1
            ) cl
          )
      `, [productIds, tenantDomain, tenantDomain])
      for (const row of mappingResult.rows) {
        productTreatmentMap[row.product_id] = Number(row.treatment_id)
        if (row.rxvortex_preset_catalog_id) {
          productCatalogMap[row.product_id] = row.rxvortex_preset_catalog_id
        }
        if (row.rxvortex_instructions) {
          productInstructionMap[row.product_id] = row.rxvortex_instructions
        }
        productSplitCountMap[row.product_id] = Number(row.order_split_count) || 0
        if (row.rxvortex_medication_form) productMedFormMap[row.product_id] = row.rxvortex_medication_form
        if (row.rxvortex_quantity_units) productQtyUnitsMap[row.product_id] = row.rxvortex_quantity_units
        if (row.rxvortex_quantity) productQtyMap[row.product_id] = row.rxvortex_quantity
        if (row.rxvortex_catalog_instruction) productCatalogInstructionMap[row.product_id] = row.rxvortex_catalog_instruction
        if (row.rxvortex_quantity_override) productQtyOverrideMap[row.product_id] = row.rxvortex_quantity_override
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
  const dosageMedFormMap: Record<string, string> = {}
  const dosageQtyUnitsMap: Record<string, string> = {}
  const dosageQtyMap: Record<string, string> = {}
  const dosageCatalogInstructionMap: Record<string, string> = {}
  const dosageQtyOverrideMap: Record<string, string> = {}
  // Treatments that have ANY row in treatment_dosage_catalog_map are treated
  // as dosage-driven — a single "default" catalog ID can't be clinically
  // correct for a drug that's titrated, so these must resolve strictly via
  // the dosage table with no silent fallback to the general/clinic ID.
  const treatmentsWithDosageMapping = new Set<number>()
  // Ordered dosage tiers per treatment (sorted by dosage_key's month number),
  // used to resolve split orders — the next tier up from the approved dose.
  const dosageTiersByTreatment: Record<number, { dosage: string; dosageKey: string | null; catalogId: string; instructions: string | null; medicationForm: string | null; quantityUnits: string | null; quantity: string | null; catalogInstruction: string | null; quantityOverride: string | null }[]> = {}
  const treatmentIds = [...new Set(Object.keys(dosageByTreatmentId).map(Number))]
  if (treatmentIds.length > 0 && tenantDomain) {
    // Same port-tolerant clinic match + LIMIT-before-unnest fix as above.
    const dosageMappingResult = await pg.raw(`
      SELECT treatment_id, dosage, dosage_key, rxvortex_preset_catalog_id, rxvortex_instructions,
             rxvortex_medication_form, rxvortex_quantity_units, rxvortex_quantity, rxvortex_catalog_instruction,
             rxvortex_quantity_override
      FROM treatment_dosage_catalog_map
      WHERE treatment_id = ANY(?)
        AND deleted_at IS NULL
        AND tenant_domain IN (
          SELECT unnest(cl.domains)
          FROM (
            SELECT domains FROM clinic
            WHERE (? = ANY(domains) OR split_part(?, ':', 1) = ANY(domains))
              AND deleted_at IS NULL
            LIMIT 1
          ) cl
        )
    `, [treatmentIds, tenantDomain, tenantDomain])
    for (const row of dosageMappingResult.rows) {
      const tid = Number(row.treatment_id)
      const key = `${tid}::${normalizeDosage(row.dosage)}`
      dosageCatalogMap[key] = row.rxvortex_preset_catalog_id
      if (row.rxvortex_instructions) dosageInstructionMap[key] = row.rxvortex_instructions
      if (row.rxvortex_medication_form) dosageMedFormMap[key] = row.rxvortex_medication_form
      if (row.rxvortex_quantity_units) dosageQtyUnitsMap[key] = row.rxvortex_quantity_units
      if (row.rxvortex_quantity) dosageQtyMap[key] = row.rxvortex_quantity
      if (row.rxvortex_catalog_instruction) dosageCatalogInstructionMap[key] = row.rxvortex_catalog_instruction
      if (row.rxvortex_quantity_override) dosageQtyOverrideMap[key] = row.rxvortex_quantity_override
      treatmentsWithDosageMapping.add(tid)

      if (!dosageTiersByTreatment[tid]) dosageTiersByTreatment[tid] = []
      dosageTiersByTreatment[tid].push({
        dosage: row.dosage,
        dosageKey: row.dosage_key,
        catalogId: row.rxvortex_preset_catalog_id,
        instructions: row.rxvortex_instructions,
        medicationForm: row.rxvortex_medication_form || null,
        quantityUnits: row.rxvortex_quantity_units || null,
        quantity: row.rxvortex_quantity || null,
        catalogInstruction: row.rxvortex_catalog_instruction || null,
        quantityOverride: row.rxvortex_quantity_override || null,
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

  // "practice"/"patient" per RxVortex's documented enum for order.ship_to
  // (https://docs.rxvortex.net/api/operations/rxvortexweborderscontrollercreate/)
  // — "clinic" isn't a valid value there.
  const shipTo = clinic.pharmacy_ship_type === "ship_to_clinic" ? "practice" : "patient"

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
  // recipient_first_name/last_name/phone are required by RxVortex's shipment
  // schema (recipient_type isn't a real field there at all — dropped). When
  // shipping to the practice, the recipient is the prescriber; otherwise the
  // patient, matching who order.ship_to/bill_to already designate.
  const baseShipment = {
    recipient_first_name: shipTo === "practice"
      ? (clinic.pharmacy_doctor_first_name || "Provider").trim()
      : (order.first_name || "Patient").trim(),
    recipient_last_name: shipTo === "practice"
      ? (clinic.pharmacy_doctor_last_name || ".").trim()
      : (order.last_name || ".").trim(),
    recipient_phone: shipTo === "practice"
      ? (normalizePhone(clinic.pharmacy_prescriber_phone) || patientPhone)
      : patientPhone,
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
      clinical,
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
      id: `pso_${Date.now()}`, workflowId, splitIndex: base + 1, splitCount: 1,
      treatmentId: null, productId: null, dosage: fallbackDosage || null, dosageKey: null,
      catalogId: fallback.preset_catalog_id || null, queueId: rxNumber, payload, response: data,
      clinicPharmacyId: opts?.clinicPharmacyId ?? null,
    })
    if (!opts?.skipWorkflowUpdate) {
      await pg.raw(
        `UPDATE order_workflow SET pharmacy_queue_id = ?, pharmacy_submitted_at = NOW(), pharmacy_status = 'submitted', clinic_pharmacy_id = ?, updated_at = NOW() WHERE id = ?`,
        [rxNumber, opts?.clinicPharmacyId ?? null, workflowId]
      )
    }
    console.log(`[PharmacySubmit-RxVortex] Order submitted. Stored as pharmacy_queue_id: ${rxNumber}`)
    return { queueId: rxNumber }
  }

  // ── Single combined order ─────────────────────────────────────────────────
  // Per Strive (2026-11): every prescription for this order — regular line
  // items AND every month of a split product — goes out as ONE RxVortex
  // order with multiple medication_requests, so the pharmacy ships them
  // together under one tracking number. (Previously each split month was its
  // own RxVortex order; that's no longer wanted.) order_split_count still
  // controls how many monthly prescriptions a product expands into, and the
  // dosage tiers are still resolved entirely from treatment_dosage_catalog_map.
  //
  // All-or-nothing: if any prescription can't be resolved, nothing is sent.

  const errors: string[] = []
  const medicationRequests: Record<string, any>[] = []
  // Months of dosage-titrated medication (the treatments in
  // treatment_dosage_catalog_map, i.e. GLP-1s) in this one order. Counted
  // per cart unit, since cart quantity multiplies each vial's volume.
  let titratedMonths = 0
  let seq = 0
  const nextMedRequestId = () => `${rxNumber}-${++seq}`

  // Line items keep their original order; bundled items come first so a
  // non-split order produces exactly the same sender_med_request_ids as
  // before (`${rxNumber}-1`, `-2`, …).
  const splitLineItems: any[] = []
  const bundledLineItems: any[] = []
  for (const li of lineItems) {
    const splitCount = li.product_id ? (productSplitCountMap[li.product_id] || 0) : 0
    if (splitCount > 0) splitLineItems.push({ ...li, splitCount })
    else bundledLineItems.push(li)
  }

  // ── Regular (non-split) line items — one medication_request each ──────────
  bundledLineItems.forEach((li: any, idx: number) => {
    const mappedTreatmentId = li.product_id ? productTreatmentMap[li.product_id] : undefined
    // The product's statically-mapped treatment_id can go stale — MHC's
    // provider system sometimes supersedes a treatment with a renamed/
    // renumbered one (mirrors how the product itself gets renamed), and
    // an order's own treatment_dosages snapshot then carries the OLD
    // treatment_id forever, even after product_treatment_map is updated
    // to point at the new one. When the mapped id has no corresponding
    // entry in this order's own dosage data, but the order carries
    // exactly one treatment record, there's no ambiguity about which
    // line item it belongs to — trust the order's own treatment_id
    // instead of the (possibly stale) static mapping. Multi-treatment
    // orders keep the strict/fail-closed behavior unchanged.
    const treatmentId = (mappedTreatmentId !== undefined && dosageByTreatmentId[mappedTreatmentId] !== undefined)
      ? mappedTreatmentId
      : (dosages.length === 1 && dosages[0]?.treatmentId ? Number(dosages[0].treatmentId) : mappedTreatmentId)
    const matchedDosage = treatmentId
      ? (dosageByTreatmentId[treatmentId] || "")
      : (dosages[idx]?.dosage || dosages[0]?.dosage || "")

    const dosageKey = treatmentId ? `${treatmentId}::${normalizeDosage(matchedDosage)}` : ""

    const note = matchedDosage ? `Prescribed dosage: ${matchedDosage}` : ""

    const isDosageDriven = treatmentId ? treatmentsWithDosageMapping.has(treatmentId) : false
    if (isDosageDriven) titratedMonths += Number(li.quantity) || 1
    let presetCatalogId = isDosageDriven
      ? ((dosageKey && dosageCatalogMap[dosageKey]) || null)
      : ((li.product_id && productCatalogMap[li.product_id]) || clinicFallbackCatalogId || null)
    let medicationForm = isDosageDriven
      ? ((dosageKey && dosageMedFormMap[dosageKey]) || null)
      : ((li.product_id && productMedFormMap[li.product_id]) || null)
    let quantityUnits = isDosageDriven
      ? ((dosageKey && dosageQtyUnitsMap[dosageKey]) || null)
      : ((li.product_id && productQtyUnitsMap[li.product_id]) || null)
    let catalogQuantity = isDosageDriven
      ? ((dosageKey && dosageQtyMap[dosageKey]) || null)
      : ((li.product_id && productQtyMap[li.product_id]) || null)
    let catalogInstruction = isDosageDriven
      ? ((dosageKey && dosageCatalogInstructionMap[dosageKey]) || null)
      : ((li.product_id && productCatalogInstructionMap[li.product_id]) || null)
    let quantityOverride = isDosageDriven
      ? ((dosageKey && dosageQtyOverrideMap[dosageKey]) || null)
      : ((li.product_id && productQtyOverrideMap[li.product_id]) || null)

    // Terminal-tier fallback: a dosage-driven treatment with no exact
    // match for the patient's approved dose, where that dose is at or
    // above the highest configured tier, is a titration that's
    // continued past the last dose the pharmacy has a distinct catalog
    // item for (e.g. Strive has no dedicated 14mg item, only up to
    // 13mg/"Month 6+"). Reuses that terminal tier's catalog item —
    // same convention already used for split orders — rather than
    // failing closed on every dose increase beyond the mapped range.
    if (isDosageDriven && !presetCatalogId && treatmentId) {
      const tiers = dosageTiersByTreatment[treatmentId] || []
      const terminal = tiers[tiers.length - 1]
      const approvedNum = parseDoseNumber(matchedDosage)
      const terminalNum = terminal ? parseDoseNumber(terminal.dosage) : null
      // Same open-ended ("+") requirement as split orders: only reuse the
      // last tier when it's explicitly the dose patients stay on.
      if (terminal && isOpenEndedTier(terminal.dosageKey) && approvedNum !== null && terminalNum !== null && approvedNum >= terminalNum) {
        presetCatalogId = terminal.catalogId
        medicationForm = terminal.medicationForm
        quantityUnits = terminal.quantityUnits
        catalogQuantity = terminal.quantity
        catalogInstruction = terminal.catalogInstruction
        quantityOverride = terminal.quantityOverride
      }
    }

    if (!presetCatalogId) {
      errors.push(
        `${li.item_title || li.product_id || "unknown"}: preset_catalog_id not set. Set it in the product mapping tab for this clinic.`
      )
      return
    }

    const manualInstruction = (dosageKey && dosageInstructionMap[dosageKey])
      || (li.product_id && productInstructionMap[li.product_id])
      || null
    const instructions = resolveInstructions(manualInstruction, catalogInstruction, matchedDosage)

    const request: Record<string, any> = {
      type: "new", refills: 0,
      sender_med_request_id: nextMedRequestId(),
      quantity: resolveQuantity(quantityOverride, catalogQuantity, li.quantity || 1),
      quantity_units: normalizeQuantityUnits(quantityUnits),
      days_supply_duration: resolveDaysSupply(medicationForm),
      instructions, authored_on_datetime: new Date().toISOString(),
      preset_catalog_id: presetCatalogId,
    }
    if (note) request.note = note
    medicationRequests.push(request)
  })

  // ── Split products — one medication_request per month, same order ─────────
  for (const li of splitLineItems) {
    const treatmentId = li.product_id ? productTreatmentMap[li.product_id] : undefined
    if (!treatmentId) {
      errors.push(`${li.item_title || li.product_id}: no treatment mapping found, cannot determine dosage sequence.`)
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
      continue
    }

    titratedMonths += li.splitCount * (Number(li.quantity) || 1)
    for (let i = 0; i < li.splitCount; i++) {
      // Tiers beyond the mapped list reuse the last tier ONLY when it's an
      // open-ended maintenance tier ("Month 8+" = the dose the patient stays
      // on). If the last mapped tier is a plain "Month 3", the patient is due
      // to step UP next month and that tier simply isn't mapped yet —
      // repeating the current dose would be a guess, so block instead.
      const tierIdx = startIdx + i
      if (tierIdx >= tiers.length && !isOpenEndedTier(tiers[tiers.length - 1].dosageKey)) {
        const last = tiers[tiers.length - 1]
        errors.push(
          `${li.item_title || li.product_id} month ${i + 1}/${li.splitCount}: needs the next dosage level after ` +
          `"${last.dosageKey || last.dosage}" (${last.dosage}), but none is mapped for treatment ${treatmentId}. ` +
          `Map the next level in Dosage → Catalog Mapping (or label the last level with "+", e.g. "Month 6+", if patients stay on that dose).`
        )
        continue
      }
      const tier = tiers[Math.min(tierIdx, tiers.length - 1)]
      if (!tier.catalogId) {
        errors.push(`${li.item_title || li.product_id} month ${i + 1}/${li.splitCount}: dosage "${tier.dosage}" has no catalog ID mapped.`)
        continue
      }
      const manualInstruction = tier.instructions || (li.product_id && productInstructionMap[li.product_id]) || null
      const instructions = resolveInstructions(manualInstruction, tier.catalogInstruction, tier.dosage)
      medicationRequests.push({
        type: "new", refills: 0,
        sender_med_request_id: nextMedRequestId(),
        quantity: resolveQuantity(tier.quantityOverride, tier.quantity, li.quantity || 1),
        quantity_units: normalizeQuantityUnits(tier.quantityUnits),
        days_supply_duration: resolveDaysSupply(tier.medicationForm),
        instructions,
        note: `Prescribed dosage: ${tier.dosage} (month ${i + 1} of ${li.splitCount})`,
        authored_on_datetime: new Date().toISOString(),
        preset_catalog_id: tier.catalogId,
      })
    }
  }

  // Strive (2026-11): GLP-1 beyond-use date is ~70 days, so one order may
  // hold at most 2 months — a 3rd vial shipped together would expire before
  // it's used. Fail closed; never trim the order to fit.
  if (titratedMonths > MAX_TITRATED_MONTHS_PER_ORDER) {
    errors.push(
      `Order contains ${titratedMonths} months of titrated medication; Strive allows at most ` +
      `${MAX_TITRATED_MONTHS_PER_ORDER} per order (vial beyond-use date). Check the product's order_split_count and cart quantities.`
    )
  }

  if (errors.length > 0) {
    throw new Error(`RxVortex submission blocked — ${errors.join(" | ")}`)
  }

  // ── Idempotency / legacy guard ────────────────────────────────────────────
  // Look at every sub-order already recorded for THIS pharmacy group's index
  // range (multi-pharmacy groups are spaced 1000 apart by the caller).
  //   • none                         → submit the combined order now
  //   • they already cover every rx  → already done (retry / manual re-click)
  //   • they cover only some rx      → an order that was partially submitted
  //     under the OLD one-order-per-split scheme. Real pharmacy orders were
  //     placed for some months; resending the combined order would duplicate
  //     them. Fail closed for a human to resolve.
  const existingResult = await pg.raw(
    `SELECT split_index, pharmacy_queue_id, pharmacy_submission_payload
       FROM pharmacy_sub_order
      WHERE order_workflow_id = ? AND split_index > ? AND split_index <= ?
        AND pharmacy_queue_id IS NOT NULL
      ORDER BY split_index`,
    [workflowId, base, base + 999]
  )
  const existingRows = existingResult.rows || []
  if (existingRows.length > 0) {
    const alreadySent = existingRows.reduce((sum: number, r: any) => {
      const reqs = r.pharmacy_submission_payload?.medication_requests
      return sum + (Array.isArray(reqs) ? reqs.length : 0)
    }, 0)
    if (alreadySent >= medicationRequests.length) {
      const queueId = existingRows[0].pharmacy_queue_id
      console.log(`[PharmacySubmit-RxVortex] Already submitted (${existingRows.length} order(s), ${alreadySent} rx) — skipping. queue id: ${queueId}`)
      if (!opts?.skipWorkflowUpdate) {
        await pg.raw(
          `UPDATE order_workflow SET pharmacy_queue_id = ?, pharmacy_submitted_at = COALESCE(pharmacy_submitted_at, NOW()), pharmacy_status = COALESCE(pharmacy_status, 'submitted'), clinic_pharmacy_id = ?, updated_at = NOW() WHERE id = ?`,
          [queueId, opts?.clinicPharmacyId ?? null, workflowId]
        )
      }
      return { queueId }
    }
    throw new Error(
      `RxVortex submission blocked — this order was partially submitted under the old one-order-per-split format ` +
      `(${alreadySent} of ${medicationRequests.length} prescriptions already sent as: ${existingRows.map((r: any) => r.pharmacy_queue_id).join(", ")}). ` +
      `Resolve the remaining prescriptions manually with the pharmacy.`
    )
  }

  // ── Send the one combined order ───────────────────────────────────────────
  const payload = {
    patient: basePatient, prescriber: basePrescriber,
    order: { bill_to: clinic.pharmacy_pay_type === "clinic_pay" ? "practice" : "patient", ship_to: shipTo, sender_order_id: rxNumber },
    shipment: baseShipment,
    clinical,
    medication_requests: medicationRequests,
  }
  console.log(`[PharmacySubmit-RxVortex] Sending payload (${medicationRequests.length} rx in one order):`, JSON.stringify(payload, null, 2))
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

  // One pharmacy order → one pharmacy_sub_order row. Webhook / status poll /
  // admin + customer tracking views all iterate sub-order rows generically,
  // so they now simply show a single shipment.
  const single = splitLineItems.length === 1 && bundledLineItems.length === 0 ? splitLineItems[0] : null
  await saveSubOrder(pg, {
    id: `pso_${Date.now()}_${base + 1}`, workflowId, splitIndex: base + 1, splitCount: 1,
    treatmentId: single ? (productTreatmentMap[single.product_id] ?? null) : null,
    productId: single ? single.product_id : null,
    dosage: null, dosageKey: null, catalogId: null,
    queueId: rxNumber, payload, response: data,
    clinicPharmacyId: opts?.clinicPharmacyId ?? null,
  })

  if (!opts?.skipWorkflowUpdate) {
    await pg.raw(
      `UPDATE order_workflow SET pharmacy_queue_id = ?, pharmacy_submitted_at = NOW(), pharmacy_status = 'submitted', clinic_pharmacy_id = ?, updated_at = NOW() WHERE id = ?`,
      [rxNumber, opts?.clinicPharmacyId ?? null, workflowId]
    )
  }
  console.log(`[PharmacySubmit-RxVortex] Order submitted as one RxVortex order (${medicationRequests.length} rx). pharmacy_queue_id: ${rxNumber}`)
  return { queueId: rxNumber }
}
