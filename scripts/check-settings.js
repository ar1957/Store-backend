require("dotenv").config()
const { Pool } = require("pg")
const p = new Pool({ connectionString: process.env.DATABASE_URL })
async function run() {
  const r = await p.query("SELECT tenant_domain, api_base_url, is_active, client_id FROM provider_settings ORDER BY tenant_domain")
  console.log("provider_settings rows:", r.rows.length)
  r.rows.forEach(x => console.log(JSON.stringify(x)))
  
  const r2 = await p.query("SELECT id, slug, domains, api_client_id, api_env, api_base_url_test FROM clinic WHERE deleted_at IS NULL")
  console.log("\nclinic rows:", r2.rows.length)
  r2.rows.forEach(x => console.log(JSON.stringify({id:x.id, slug:x.slug, domains:x.domains, has_creds:!!x.api_client_id, env:x.api_env})))
  p.end()
}
run().catch(e => { console.error(e.message); p.end() })
