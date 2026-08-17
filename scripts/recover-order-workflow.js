/**
 * scripts/recover-order-workflow.js
 *
 * One-off recovery for order_01M04A8QG4V1WJ3QQTZ4BMV9VK — the order.placed
 * event was lost (in-memory event bus + instance replacement between this
 * order's payment and now — see feedback memory / conversation), so
 * order_workflow was never created and GFE/patient creation never ran.
 *
 * This is a plain standalone script (not `medusa exec`) because production
 * doesn't have ts-node installed — same reasoning as manual-migrate.js and
 * backfill-stripe-order-metadata.js. It faithfully replicates the eligibility
 * branch of src/subscribers/order-placed.ts step-by-step (clinic lookup via
 * domain, MHC token, patient creation, treatment mapping lookup, GFE
 * creation, order_workflow insert, ledger entries) using raw pg + fetch —
 * same logic, no Medusa container needed.
 *
 * Deliberately does NOT touch Medusa's event bus, since email-notifications.ts
 * also listens for "order.placed" and re-emitting it would send the customer
 * a duplicate order-confirmation email days later.
 *
 * SAFETY: aborts if order_workflow already exists for this order. This WILL
 * make a real API call to create a patient + GFE in the MHC provider system.
 *
 * Usage (on the server):
 *   export DATABASE_URL=$(/opt/elasticbeanstalk/bin/get-config environment --key DATABASE_URL)
 *   node /var/app/current/scripts/recover-order-workflow.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") })
const { Pool } = require("pg")

const ORDER_ID = "order_01M04A8QG4V1WJ3QQTZ4BMV9VK"

const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 })

// Mirrors ClinicModuleService.getClinicByDomain's 3-tier fallback matching.
function matchClinic(clinics, domain) {
  let match = clinics.find(c => (c.domains || []).includes(domain))
  if (match) return match

  const domainNoPort = domain.split(":")[0]
  match = clinics.find(c => (c.domains || []).some(d => d.split(":")[0] === domainNoPort))
  if (match) return match

  const localMatch = domainNoPort.replace(/\.local$/, "")
  match = clinics.find(c => (c.domains || []).some(d => {
    const dNoPort = d.split(":")[0]
    const dNoTld = dNoPort.replace(/\.(com|net|org|io)$/, "")
    return dNoTld === localMatch
  }))
  return match || null
}

async function resolveOrderClinicPharmacyId(pg, clinicId, orderId) {
  try {
    const pharmaciesResult = await pg.query(
      `SELECT id, is_default FROM clinic_pharmacy WHERE clinic_id = $1 AND deleted_at IS NULL`,
      [clinicId]
    )
    const pharmacies = pharmaciesResult.rows
    if (pharmacies.length === 0) return null
    const defaultPharmacy = pharmacies.find(p => p.is_default) || pharmacies[0]

    const productsResult = await pg.query(
      `SELECT DISTINCT oli.product_id
       FROM order_item oi
       JOIN order_line_item oli ON oli.id = oi.item_id
       WHERE oi.order_id = $1 AND oli.product_id IS NOT NULL`,
      [orderId]
    )
    const productIds = productsResult.rows.map(r => r.product_id)
    if (productIds.length === 0) return defaultPharmacy.id

    const mapResult = await pg.query(
      `SELECT product_id, clinic_pharmacy_id FROM product_treatment_map
       WHERE product_id = ANY($1) AND deleted_at IS NULL
         AND tenant_domain IN (SELECT unnest(domains) FROM clinic WHERE id = $2 AND deleted_at IS NULL)`,
      [productIds, clinicId]
    )
    const pharmacyIdSet = new Set(pharmacies.map(p => p.id))
    const productPharmacyMap = {}
    for (const row of mapResult.rows) {
      if (row.clinic_pharmacy_id) productPharmacyMap[row.product_id] = row.clinic_pharmacy_id
    }
    const resolvedIds = new Set(productIds.map(pid => {
      const mapped = productPharmacyMap[pid]
      return mapped && pharmacyIdSet.has(mapped) ? mapped : defaultPharmacy.id
    }))
    return resolvedIds.size === 1 ? [...resolvedIds][0] : null
  } catch {
    return null
  }
}

async function createLedgerEntries(pg, clinicId, orderId, orderTotal) {
  try {
    const itemsRes = await pg.query(`
      SELECT ol.product_id, oi.quantity
      FROM order_line_item ol
      INNER JOIN order_item oi ON oi.item_id = ol.id
      WHERE oi.order_id = $1 AND ol.product_id IS NOT NULL
    `, [orderId])
    if (!itemsRes.rows.length) return

    const productIds = [...new Set(itemsRes.rows.map(r => r.product_id))]
    const costsRes = await pg.query(
      `SELECT product_id, pharmacy_cost FROM product_payout_cost WHERE clinic_id = $1 AND product_id = ANY($2)`,
      [clinicId, productIds]
    )
    if (!costsRes.rows.length) return

    const costMap = new Map(costsRes.rows.map(r => [r.product_id, Number(r.pharmacy_cost)]))
    let pharmacyAmount = 0
    for (const item of itemsRes.rows) {
      const cost = costMap.get(item.product_id) ?? 0
      pharmacyAmount += cost * (Number(item.quantity) || 1)
    }
    pharmacyAmount = Number(pharmacyAmount.toFixed(2))
    const clinicAmount = Number(Math.max(0, orderTotal - pharmacyAmount).toFixed(2))

    const ts = Date.now()
    if (pharmacyAmount > 0) {
      await pg.query(
        `INSERT INTO vendor_ledger (id, clinic_id, vendor_type, order_id, order_total, amount_owed, currency, status)
         VALUES ($1, $2, 'pharmacy', $3, $4, $5, 'usd', 'pending') ON CONFLICT DO NOTHING`,
        [`vl_${ts}_pharmacy_${orderId.slice(-6)}`, clinicId, orderId, orderTotal, pharmacyAmount]
      )
    }
    if (clinicAmount > 0) {
      await pg.query(
        `INSERT INTO vendor_ledger (id, clinic_id, vendor_type, order_id, order_total, amount_owed, currency, status)
         VALUES ($1, $2, 'clinic', $3, $4, $5, 'usd', 'pending') ON CONFLICT DO NOTHING`,
        [`vl_${ts + 1}_clinic_${orderId.slice(-6)}`, clinicId, orderId, orderTotal, clinicAmount]
      )
    }
    console.log(`  ✓ Ledger entries — pharmacy $${pharmacyAmount} / clinic $${clinicAmount}`)
  } catch (e) {
    console.error(`  ⚠ Failed to create ledger entries (non-fatal): ${e.message}`)
  }
}

async function run() {
  const client = await pool.connect()
  try {
    const existing = await client.query(`SELECT id FROM order_workflow WHERE order_id = $1 LIMIT 1`, [ORDER_ID])
    if (existing.rows.length > 0) {
      console.log(`Order ${ORDER_ID} already has order_workflow ${existing.rows[0].id} — nothing to do, aborting.`)
      return
    }

    const orderResult = await client.query(`
      SELECT o.id, o.display_id, o.metadata, o.email,
             COALESCE(
               (os.totals->>'current_order_total')::numeric,
               (os.totals->>'original_order_total')::numeric,
               (os.totals->>'total')::numeric, 0
             ) AS total,
             oa.first_name, oa.last_name
      FROM "order" o
      LEFT JOIN order_address oa ON oa.id = o.shipping_address_id
      LEFT JOIN LATERAL (
        SELECT totals FROM order_summary WHERE order_id = o.id AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      ) os ON true
      WHERE o.id = $1 LIMIT 1
    `, [ORDER_ID])
    if (!orderResult.rows.length) {
      console.error(`Order ${ORDER_ID} not found.`)
      return
    }
    const order = orderResult.rows[0]
    const metadata = order.metadata || {}
    const eligibility = metadata.eligibility
    if (!eligibility) {
      console.error(`Order ${ORDER_ID} has no eligibility data in metadata — this script only handles the eligibility path. Stopping rather than guessing.`)
      return
    }

    const { domain, locationId, dob, sex, pregnancy,
      medicalHistory, allergies, currentMedications,
      heightFt, heightIn, weightLbs, goalWeightLbs, bmi } = eligibility

    // 2. Get clinic
    const clinicsRes = await client.query(`SELECT * FROM clinic WHERE deleted_at IS NULL`)
    const clinic = matchClinic(clinicsRes.rows, domain)
    if (!clinic) {
      console.error(`No clinic found for domain: ${domain}`)
      return
    }
    console.log(`Matched clinic: ${clinic.name} (${clinic.id})`)

    // 3. Get token
    const baseUrl = clinic.api_env === "prod" ? clinic.api_base_url_prod : clinic.api_base_url_test
    if (!clinic.api_client_id || !clinic.api_client_secret) {
      console.error(`No API credentials configured for clinic: ${clinic.id}`)
      return
    }
    const basicAuth = Buffer.from(`${clinic.api_client_id}:${clinic.api_client_secret}`).toString("base64")
    const loginRes = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Basic ${basicAuth}`, "ClientId": clinic.api_client_id, "ClientSecret": clinic.api_client_secret },
    })
    if (!loginRes.ok) {
      console.error(`Auth failed for ${clinic.name}: ${loginRes.status} ${await loginRes.text()}`)
      return
    }
    const loginData = await loginRes.json()
    const token = loginData?.token || loginData?.payload?.token
    if (!token) {
      console.error(`No token returned from MHC login`)
      return
    }
    console.log(`Got MHC token.`)

    // 4. Parse DOB
    const dobMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob)
    if (!dobMatch) {
      console.error(`Invalid date of birth "${dob}"`)
      return
    }
    const [, birthYear, birthMonth, birthDay] = dobMatch

    // 5. Create patient
    let firstName = order.first_name
    let lastName = order.last_name
    if (!firstName || !lastName) {
      const customerResult = await client.query(
        `SELECT first_name, last_name FROM customer WHERE email = $1 AND deleted_at IS NULL LIMIT 1`,
        [order.email]
      )
      const customerRow = customerResult.rows[0]
      if (customerRow) {
        firstName = firstName || customerRow.first_name
        lastName = lastName || customerRow.last_name
      }
    }
    firstName = firstName || (order.email ? order.email.split("@")[0] : "Patient")
    lastName = lastName || "."

    const patientPayload = {
      firstname: firstName,
      lastname: lastName,
      dob: `${birthYear}-${birthMonth}-${birthDay}`,
      medicalHistory: {
        "1": `BMI: ${bmi} | Height: ${heightFt}'${heightIn}" | Weight: ${weightLbs}lbs | Goal: ${goalWeightLbs}lbs`,
        "2": medicalHistory && medicalHistory !== "None" ? medicalHistory : "None",
        "3": allergies && allergies !== "None" ? allergies : "None",
        "4": currentMedications && currentMedications !== "None" ? currentMedications : "None",
        "5": "None",
        "6": sex === "female" && pregnancy && pregnancy !== "none" ? pregnancy : "false",
      },
    }
    console.log(`Patient request body: ${JSON.stringify(patientPayload)}`)

    const patientRes = await fetch(`${baseUrl}/patient`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify(patientPayload),
    })
    if (!patientRes.ok) {
      console.error(`Failed to create patient: ${await patientRes.text()}`)
      return
    }
    const patientData = await patientRes.json()
    console.log(`Patient API response: ${JSON.stringify(patientData)}`)
    const patientId = patientData?.payload?.id || patientData?.payload?.patientId || patientData?.patientId || patientData?.id
    if (!patientId) {
      console.error(`No patientId returned`)
      return
    }

    // 6. Look up treatment IDs
    const orderItemsResult = await client.query(`
      SELECT ol.variant_id, ol.product_id
      FROM order_line_item ol
      INNER JOIN order_item oi ON oi.item_id = ol.id
      WHERE oi.order_id = $1
    `, [ORDER_ID])
    const productIds = orderItemsResult.rows.map(r => r.product_id).filter(Boolean)

    let treatmentIds = []
    if (productIds.length > 0) {
      const allDomains = clinic.domains || [domain]
      if (!allDomains.includes(domain)) allDomains.push(domain)
      const mappingResult = await client.query(
        `SELECT DISTINCT treatment_id FROM product_treatment_map WHERE tenant_domain = ANY($1) AND product_id = ANY($2)`,
        [allDomains, productIds]
      )
      treatmentIds = mappingResult.rows.map(r => Number(r.treatment_id)).filter(Boolean)
    }

    if (treatmentIds.length === 0) {
      console.log(`No mapped treatments — recording as pending_pharmacy, skipping GFE creation`)
      const workflowId = `wf_${Date.now()}`
      const clinicPharmacyId = await resolveOrderClinicPharmacyId(client, clinic.id, ORDER_ID)
      await client.query(`
        INSERT INTO order_workflow
          (id, order_id, tenant_domain, gfe_id, patient_id, room_no, virtual_room_url, status, location_id, location_name, clinic_pharmacy_id, created_at, updated_at)
        VALUES ($1, $2, $3, NULL, NULL, NULL, NULL, 'pending_pharmacy', $4, $5, $6, NOW(), NOW())
        ON CONFLICT (order_id) DO NOTHING
      `, [workflowId, ORDER_ID, domain, metadata.location_id || null, metadata.location_name || null, clinicPharmacyId])
      await client.query(`UPDATE "order" SET metadata = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify({ ...metadata, workflowStatus: "pending_pharmacy" }), ORDER_ID])
      await createLedgerEntries(client, clinic.id, ORDER_ID, Number(order.total || 0))
      console.log(`✓ Order ${ORDER_ID} recorded as pending_pharmacy (no MHC GFE). workflow=${workflowId}`)
      return
    }

    // 7. Create GFE
    const gfeRes = await fetch(`${baseUrl}/gfe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ patientId, customerLocationId: Number(locationId), treatments: treatmentIds }),
    })
    if (!gfeRes.ok) {
      console.error(`Failed to create GFE: ${await gfeRes.text()}`)
      return
    }
    const gfeData = await gfeRes.json()
    console.log(`GFE API response: ${JSON.stringify(gfeData)}`)
    const gfeId = gfeData?.payload?.gfeId || gfeData?.gfeId
    const roomNo = gfeData?.payload?.roomNo || gfeData?.roomNo
    if (!gfeId || !roomNo) {
      console.error(`No gfeId/roomNo returned`)
      return
    }

    // 8. Build virtual room URL + save
    const connectBase = (clinic.api_env === "prod" ? clinic.connect_url_prod : clinic.connect_url_test).replace(/\/+$/, "")
    const redirectUrl = encodeURIComponent(clinic.redirect_url || `https://${domain}/us/order/status`)
    const virtualRoomUrl = `${connectBase}/connect/patient/${roomNo}${birthYear}?isFromExternal=true&redirectUrl=${redirectUrl}`

    const workflowId = `wf_${Date.now()}`
    const clinicPharmacyId = await resolveOrderClinicPharmacyId(client, clinic.id, ORDER_ID)
    await client.query(`
      INSERT INTO order_workflow
        (id, order_id, tenant_domain, gfe_id, patient_id, room_no, virtual_room_url, status, location_id, location_name, clinic_pharmacy_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_provider', $8, $9, $10, NOW(), NOW())
      ON CONFLICT (gfe_id) DO UPDATE SET order_id = EXCLUDED.order_id, updated_at = NOW()
    `, [workflowId, ORDER_ID, domain, String(gfeId), String(patientId), String(roomNo), virtualRoomUrl,
        metadata.location_id || null, metadata.location_name || null, clinicPharmacyId])

    await client.query(`UPDATE "order" SET metadata = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify({ ...metadata, gfeId: String(gfeId), virtualRoomUrl, workflowStatus: "pending_provider" }), ORDER_ID])

    await createLedgerEntries(client, clinic.id, ORDER_ID, Number(order.total || 0))
    console.log(`✓ Patient ${patientId} + GFE ${gfeId} created for order ${ORDER_ID}. workflow=${workflowId}`)
  } finally {
    client.release()
    await pool.end()
  }
}

run().catch(e => {
  console.error("Fatal:", e.message)
  process.exit(1)
})
