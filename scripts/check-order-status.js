require("dotenv").config()
const { Pool } = require("pg")
const p = new Pool({ connectionString: process.env.DATABASE_URL })
async function run() {
  // Get the 5 most recent orders with their workflow status
  const r = await p.query(`
    SELECT 
      ow.id, ow.order_id, ow.status, ow.gfe_id, ow.provider_status,
      ow.md_decision, ow.pharmacy_queue_id, ow.pharmacy_status,
      ow.treatment_dosages, ow.created_at, ow.updated_at
    FROM order_workflow ow
    WHERE ow.deleted_at IS NULL
    ORDER BY ow.created_at DESC
    LIMIT 5
  `)
  r.rows.forEach(row => {
    console.log("---")
    console.log("order_id:       ", row.order_id)
    console.log("status:         ", row.status)
    console.log("gfe_id:         ", row.gfe_id)
    console.log("provider_status:", row.provider_status)
    console.log("md_decision:    ", row.md_decision)
    console.log("pharmacy_q_id:  ", row.pharmacy_queue_id)
    console.log("pharmacy_status:", row.pharmacy_status)
    console.log("updated_at:     ", row.updated_at)
  })
  p.end()
}
run().catch(e => { console.error(e.message); p.end() })
