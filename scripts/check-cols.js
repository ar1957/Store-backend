require("dotenv").config()
const { Pool } = require("pg")
const p = new Pool({ connectionString: process.env.DATABASE_URL })
async function run() {
  const r1 = await p.query("SELECT column_name FROM information_schema.columns WHERE table_name='order_line_item'")
  console.log("order_line_item:", r1.rows.map(x => x.column_name).join(", "))
  const r2 = await p.query("SELECT column_name FROM information_schema.columns WHERE table_name='order_item'")
  console.log("order_item:", r2.rows.map(x => x.column_name).join(", "))
  p.end()
}
run().catch(e => { console.error(e.message); p.end() })
