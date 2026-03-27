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
