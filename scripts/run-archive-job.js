/**
 * run-archive-job.js
 * Manually runs the archive-old-orders logic without needing the Medusa container.
 * Use this to test archiving locally or to backfill existing environments.
 *
 * Usage:
 *   node scripts/run-archive-job.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") })
const { Pool } = require("pg")

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function run() {
  const client = await pool.connect()
  try {
    const result = await client.query(`
      UPDATE order_workflow
      SET archived_at = NOW(), updated_at = NOW()
      WHERE archived_at IS NULL
        AND deleted_at IS NULL
        AND (
          (status = 'shipped'
            AND shipped_at IS NOT NULL
            AND shipped_at < NOW() - INTERVAL '30 days')
          OR
          (status = 'refund_issued'
            AND refund_issued_at IS NOT NULL
            AND refund_issued_at < NOW() - INTERVAL '30 days')
        )
    `)
    console.log(`✓ Archived ${result.rowCount} order(s)`)
  } finally {
    client.release()
    await pool.end()
  }
}

run().catch(e => { console.error("Error:", e.message); process.exit(1) })
