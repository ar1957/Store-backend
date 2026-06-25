require("dotenv").config()
const { Pool } = require("pg")
const p = new Pool({ connectionString: process.env.DATABASE_URL })

async function run() {
  const r = await p.query(`
    SELECT ow.id, ow.order_id, ow.status, ow.gfe_id, ow.tenant_domain
    FROM order_workflow ow WHERE ow.gfe_id = '78789' AND ow.deleted_at IS NULL LIMIT 1
  `)
  const row = r.rows[0]
  if (!row) { console.log("No workflow found"); p.end(); return }
  console.log("Workflow:", JSON.stringify(row))

  // Get settings from provider_settings table (what getToken actually uses)
  const sr = await p.query(`SELECT * FROM provider_settings WHERE tenant_domain = $1 LIMIT 1`, [row.tenant_domain])
  const settings = sr.rows[0]
  if (!settings) {
    console.log("No provider_settings for domain:", row.tenant_domain)
    // Try clinic table directly
    const cr = await p.query(`SELECT * FROM clinic WHERE $1 = ANY(domains) OR slug = $1 LIMIT 1`, [row.tenant_domain])
    console.log("Clinic:", cr.rows[0] ? `id=${cr.rows[0].id} env=${cr.rows[0].api_env}` : "not found")
    p.end(); return
  }
  console.log("Settings found, api_base_url:", settings.api_base_url, "env:", settings.api_env)

  // Get token
  const authRes = await fetch(`${settings.api_base_url}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: settings.client_id, clientSecret: settings.client_secret })
  })
  if (!authRes.ok) { console.log("Auth failed:", authRes.status, await authRes.text()); p.end(); return }
  const authData = await authRes.json()
  const token = authData?.token || authData?.payload?.token
  console.log("Token:", token ? "obtained" : "missing")

  // Get GFE status
  const gfeRes = await fetch(`${settings.api_base_url}/gfe/status/78789`, {
    headers: { "Authorization": `Bearer ${token}` }
  })
  const gfeText = await gfeRes.text()
  console.log("GFE HTTP status:", gfeRes.status)
  console.log("GFE response:", gfeText.slice(0, 1000))
  p.end()
}
run().catch(e => { console.error(e.message); p.end() })
