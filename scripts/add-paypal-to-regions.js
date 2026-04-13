/**
 * Adds the PayPal payment provider to all regions.
 * Run after restarting the backend with PAYPAL_CLIENT_ID set.
 * 
 * Usage:
 *   set DATABASE_URL=postgres://postgres:2190@localhost/medusa-my-medusa-store && node scripts/add-paypal-to-regions.js
 */
const { Pool } = require("pg")

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function run() {
  const client = await pool.connect()
  try {
    // Check if PayPal provider exists in payment_provider table
    const providerCheck = await client.query(
      `SELECT id FROM payment_provider WHERE id LIKE '%paypal%' LIMIT 5`
    )
    console.log("PayPal providers found:", providerCheck.rows)

    if (!providerCheck.rows.length) {
      console.log("❌ PayPal provider not registered yet.")
      console.log("   Make sure PAYPAL_CLIENT_ID is set and the backend has been restarted.")
      return
    }

    const paypalProviderId = providerCheck.rows[0].id
    console.log(`Using provider: ${paypalProviderId}`)

    // Get all regions
    const regions = await client.query(
      `SELECT id, name FROM region WHERE deleted_at IS NULL`
    )
    console.log(`Found ${regions.rows.length} region(s):`, regions.rows.map(r => r.name))

    for (const region of regions.rows) {
      // Check if already linked
      const existing = await client.query(
        `SELECT 1 FROM region_payment_provider WHERE region_id = $1 AND payment_provider_id = $2`,
        [region.id, paypalProviderId]
      )
      if (existing.rows.length) {
        console.log(`✓ ${region.name}: PayPal already linked`)
        continue
      }

      await client.query(
        `INSERT INTO region_payment_provider (id, region_id, payment_provider_id) VALUES ($1, $2, $3)`,
        [`rpp_paypal_${region.id}`, region.id, paypalProviderId]
      )
      console.log(`✓ ${region.name}: PayPal added`)
    }

    console.log("\n✅ Done. PayPal is now available in all regions.")
  } finally {
    client.release()
    await pool.end()
  }
}

run().catch(e => { console.error("Fatal:", e.message); process.exit(1) })
