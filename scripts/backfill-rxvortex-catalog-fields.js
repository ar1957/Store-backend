/**
 * scripts/backfill-rxvortex-catalog-fields.js
 *
 * Migration20240101000026 added rxvortex_medication_form / rxvortex_quantity_units
 * / rxvortex_quantity to product_treatment_map and treatment_dosage_catalog_map,
 * but only fills them in going forward — every mapping an admin picked in
 * provider-settings *before* that migration has these columns NULL, so
 * pharmacy-submit-rxvortex.ts silently falls back to the old flat defaults
 * ("each" / 30 days / cart quantity) for them instead of the correct
 * per-medication values. This is a plain standalone script (not `medusa exec`)
 * for the same reason as manual-migrate.js/recover-order-workflow.js:
 * production doesn't have ts-node installed.
 *
 * For every clinic_pharmacy of pharmacy_type='rxvortex', fetches that
 * pharmacy's live preset catalog and backfills any mapping row whose
 * rxvortex_preset_catalog_id matches a catalog item, but only where
 * rxvortex_medication_form is still NULL — never overwrites a value an
 * admin (or a prior run of this script) already set. Catalog IDs are
 * RxVortex-generated UUIDs, effectively globally unique, so catalogs from
 * multiple pharmacies are safely merged into one lookup.
 *
 * Safe to re-run — idempotent (only touches NULL rows), and read-only against
 * RxVortex (GET catalog only, no orders submitted).
 *
 * Usage (on the server):
 *   export DATABASE_URL=$(/opt/elasticbeanstalk/bin/get-config environment --key DATABASE_URL)
 *   node /var/app/current/scripts/backfill-rxvortex-catalog-fields.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") })
const { Pool } = require("pg")

const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 })

function resolveBaseUrl(pharmacy) {
  if (pharmacy.pharmacy_api_url?.trim()) return pharmacy.pharmacy_api_url.trim().replace(/\/$/, "")
  if (pharmacy.pharmacy_subdomain?.trim()) {
    const sub = pharmacy.pharmacy_subdomain.trim()
    return sub.includes(".") ? `https://${sub}` : `https://${sub}.rxvortex.net`
  }
  return "https://sandbox.rxvortex.net"
}

async function fetchCatalogForPharmacy(pharmacy) {
  const baseUrl = resolveBaseUrl(pharmacy)
  const tokRes = await fetch(`${baseUrl}/api/v1/generate-access-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: pharmacy.pharmacy_client_id, client_secret: pharmacy.pharmacy_client_secret }),
  })
  const tokData = await tokRes.json()
  if (!tokRes.ok || !tokData.access_token) {
    throw new Error(`auth failed (HTTP ${tokRes.status}): ${JSON.stringify(tokData).slice(0, 200)}`)
  }
  const catRes = await fetch(`${baseUrl}/api/v1/preset-catalog-items`, {
    headers: { "Authorization": `Bearer ${tokData.access_token}`, "Content-Type": "application/json" },
  })
  const catData = await catRes.json()
  if (!catRes.ok) throw new Error(`catalog fetch failed (HTTP ${catRes.status}): ${JSON.stringify(catData).slice(0, 200)}`)
  const items = Array.isArray(catData) ? catData : (catData.items || catData.data || [])
  return items
}

async function main() {
  const client = await pool.connect()
  try {
    const { rows: pharmacies } = await client.query(
      `SELECT id, name, pharmacy_api_url, pharmacy_client_id, pharmacy_client_secret, pharmacy_subdomain
       FROM clinic_pharmacy
       WHERE pharmacy_type = 'rxvortex' AND deleted_at IS NULL
         AND pharmacy_client_id IS NOT NULL AND pharmacy_client_id <> ''`
    )
    console.log(`Found ${pharmacies.length} RxVortex pharmacy configs.`)

    // catalog_id -> { medication_form, quantity_units, quantity }
    const catalogLookup = new Map()
    for (const pharmacy of pharmacies) {
      try {
        const items = await fetchCatalogForPharmacy(pharmacy)
        for (const item of items) {
          if (!item.catalog_id || catalogLookup.has(item.catalog_id)) continue
          catalogLookup.set(item.catalog_id, {
            medication_form: item.medication_form || null,
            quantity_units: item.quantity_units || null,
            quantity: item.quantity != null ? String(item.quantity) : null,
          })
        }
        console.log(`  [${pharmacy.name}] fetched ${items.length} catalog items.`)
      } catch (err) {
        console.error(`  [${pharmacy.name}] SKIPPED — ${err.message}`)
      }
    }
    console.log(`Merged catalog lookup: ${catalogLookup.size} unique catalog IDs.\n`)

    for (const [table, idCol] of [
      ["product_treatment_map", "id"],
      ["treatment_dosage_catalog_map", "id"],
    ]) {
      const { rows } = await client.query(
        `SELECT ${idCol}, rxvortex_preset_catalog_id FROM ${table}
         WHERE rxvortex_preset_catalog_id IS NOT NULL AND rxvortex_preset_catalog_id <> ''
           AND rxvortex_medication_form IS NULL
           ${table === "treatment_dosage_catalog_map" ? "AND deleted_at IS NULL" : ""}`
      )
      let updated = 0
      let unmatched = 0
      for (const row of rows) {
        const fields = catalogLookup.get(row.rxvortex_preset_catalog_id)
        if (!fields) { unmatched++; continue }
        await client.query(
          `UPDATE ${table} SET rxvortex_medication_form = $1, rxvortex_quantity_units = $2, rxvortex_quantity = $3, updated_at = NOW() WHERE ${idCol} = $4`,
          [fields.medication_form, fields.quantity_units, fields.quantity, row[idCol]]
        )
        updated++
      }
      console.log(`${table}: ${updated} updated, ${unmatched} unmatched (catalog ID not found in any fetched catalog — likely a retired/renamed item, needs manual re-pick), ${rows.length - updated - unmatched} skipped.`)
    }
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1) })
