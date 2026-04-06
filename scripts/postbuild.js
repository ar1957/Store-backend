/**
 * postbuild.js
 * Ensures any routes that medusa build silently skips are manually compiled
 * into the .medusa/server output. Run after `medusa build`.
 */
const fs = require("fs")
const path = require("path")

const routes = [
  {
    src: "src/api/admin/clinics/[id]/test-connection/route.ts",
    dst: ".medusa/server/src/api/admin/clinics/[id]/test-connection/route.js",
    content: `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.POST = POST;
const CLINIC_MODULE = "clinic";
async function POST(req, res) {
  try {
    const clinicSvc = req.scope.resolve(CLINIC_MODULE);
    const clinic = await clinicSvc.getClinicById(req.params.id);
    if (!clinic) return res.status(404).json({ success: false, message: "Clinic not found" });
    const result = await clinicSvc.testConnection(clinic.id);
    return res.json(result);
  } catch (err) {
    return res.json({ success: false, message: err instanceof Error ? err.message : "Connection failed" });
  }
}
`,
  },
  {
    src: "src/api/admin/clinics/[id]/test-pharmacy/route.ts",
    dst: ".medusa/server/src/api/admin/clinics/[id]/test-pharmacy/route.js",
    content: `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.POST = POST;
async function safeJson(res) {
  const raw = await res.text();
  try { return { ok: true, data: JSON.parse(raw), raw }; } catch {}
  return { ok: false, data: null, raw: raw.slice(0, 200) };
}
async function POST(req, res) {
  try {
    const { pharmacy_type, pharmacy_api_url, pharmacy_api_key,
            pharmacy_store_id, pharmacy_username, pharmacy_password } = req.body || {};
    const baseUrl = (pharmacy_api_url || "").replace(/\\/$/, "");
    if (!baseUrl) return res.status(400).json({ success: false, message: "No pharmacy API URL configured" });
    if (pharmacy_type === "rmm") {
      const authUrl = baseUrl + "/getJWTkey";
      console.log("[TestPharmacy] RMM auth URL: " + authUrl);
      const authRes = await fetch(authUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: pharmacy_username, password: pharmacy_password }),
      });
      const { ok: isJson, data, raw } = await safeJson(authRes);
      console.log("[TestPharmacy] status=" + authRes.status + " isJson=" + isJson + " body=" + raw);
      if (!isJson) return res.status(400).json({ success: false, message: "RMM API returned non-JSON (HTTP " + authRes.status + "). Response: " + raw });
      if (authRes.ok && data && data.token) return res.json({ success: true, message: "Authentication successful" });
      return res.status(400).json({ success: false, message: (data && (data.error || data.message)) || ("Auth failed (HTTP " + authRes.status + ")") });
    } else {
      const testRes = await fetch(baseUrl + "/RxRequestStatus", {
        method: "POST",
        headers: { "Authorization": pharmacy_api_key, "Content-Type": "application/json" },
        body: JSON.stringify({ StoreID: pharmacy_store_id, QueueID: "test" }),
      });
      return res.json({ success: testRes.status < 500, message: "Connection status: " + testRes.status });
    }
  } catch (err) {
    console.error("[TestPharmacy] Error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}
`,
  },
]

for (const route of routes) {
  const dstDir = path.dirname(route.dst)
  if (!fs.existsSync(dstDir)) {
    fs.mkdirSync(dstDir, { recursive: true })
    console.log(`[postbuild] Created directory: ${dstDir}`)
  }
  if (!fs.existsSync(route.dst)) {
    fs.writeFileSync(route.dst, route.content)
    console.log(`[postbuild] Wrote: ${route.dst}`)
  } else {
    console.log(`[postbuild] Already exists, skipping: ${route.dst}`)
  }
}

console.log("[postbuild] Done.")
