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
    src: "src/api/admin/dashboard/route.ts",
    dst: ".medusa/server/src/api/admin/dashboard/route.js",
    content: `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GET = GET;
async function GET(req, res) {
  try {
    const pg = req.scope.resolve("__pg_connection__");
    let { clinicId, dateFrom, dateTo } = req.query || {};

    const actorId = req.session?.auth_context?.actor_id;
    let callerRole = "super_admin";
    let callerClinicId = null;
    if (actorId) {
      const userResult = await pg.raw('SELECT email FROM "user" WHERE id = ? LIMIT 1', [actorId]);
      const email = userResult.rows[0]?.email;
      if (email) {
        const staffResult = await pg.raw(
          'SELECT cs.role, c.id AS clinic_id FROM clinic_staff cs JOIN clinic c ON cs.tenant_domain = ANY(c.domains) WHERE cs.email = ? AND cs.is_active = true AND cs.deleted_at IS NULL LIMIT 1',
          [email]
        );
        if (staffResult.rows.length) {
          callerRole = staffResult.rows[0].role;
          callerClinicId = staffResult.rows[0].clinic_id;
        }
      }
    }
    if (callerRole !== "super_admin" && callerClinicId) clinicId = callerClinicId;

    const conditions = ["ow.deleted_at IS NULL"];
    const bindings = [];
    if (clinicId) { conditions.push("c.id = ?"); bindings.push(clinicId); }
    if (dateFrom) { conditions.push("o.created_at >= ?"); bindings.push(dateFrom); }
    if (dateTo)   { conditions.push("o.created_at <= ?"); bindings.push(dateTo + "T23:59:59Z"); }
    const where = "WHERE " + conditions.join(" AND ");

    const clinicJoin = \`JOIN clinic c ON (
      ow.tenant_domain = ANY(c.domains)
      OR ow.tenant_domain = ANY(SELECT split_part(d,':',1) FROM unnest(c.domains) AS d)
      OR o.sales_channel_id = c.sales_channel_id
    )\`;
    const txSubquery = \`LEFT JOIN (
      SELECT order_id, SUM(amount) AS amount
      FROM order_transaction
      WHERE reference = 'capture' AND deleted_at IS NULL
      GROUP BY order_id
    ) tx ON tx.order_id = o.id\`;

    const byStatus = await pg.raw(
      \`SELECT ow.status, COUNT(DISTINCT o.id)::int AS count, COALESCE(SUM(tx.amount), 0) AS total
       FROM order_workflow ow
       JOIN "order" o ON o.id = ow.order_id
       \${txSubquery} \${clinicJoin} \${where}
       GROUP BY ow.status ORDER BY count DESC\`,
      bindings
    );
    const byProduct = await pg.raw(
      \`SELECT li.title AS product, COUNT(DISTINCT o.id)::int AS count, COALESCE(SUM(DISTINCT tx.amount), 0) AS total
       FROM order_workflow ow
       JOIN "order" o ON o.id = ow.order_id
       \${txSubquery} \${clinicJoin}
       JOIN order_item oi ON oi.order_id = o.id
       JOIN order_line_item li ON li.id = oi.item_id
       \${where}
       GROUP BY li.title ORDER BY count DESC LIMIT 10\`,
      bindings
    );
    const summary = await pg.raw(
      \`SELECT COUNT(DISTINCT o.id)::int AS total_orders, COALESCE(SUM(tx.amount), 0) AS total_revenue
       FROM order_workflow ow
       JOIN "order" o ON o.id = ow.order_id
       \${txSubquery} \${clinicJoin} \${where}\`,
      bindings
    );

    let clinics = [];
    if (callerRole === "super_admin") {
      const cr = await pg.raw("SELECT id, name FROM clinic WHERE deleted_at IS NULL ORDER BY name");
      clinics = cr.rows;
    }

    return res.json({
      byStatus: byStatus.rows,
      byProduct: byProduct.rows,
      summary: summary.rows[0],
      clinics,
      role: callerRole,
      scopedClinicId: callerRole !== "super_admin" ? clinicId : null,
    });
  } catch (err) {
    console.error("[Dashboard] Error:", err.message);
    return res.status(500).json({ message: err.message });
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
  {
    src: "src/api/admin/clinics/[id]/promotions/route.ts",
    dst: ".medusa/server/src/api/admin/clinics/[id]/promotions/route.js",
    content: `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GET = GET;
exports.POST = POST;
async function GET(req, res) {
  try {
    const pg = req.scope.resolve("__pg_connection__");
    const { id: clinicId } = req.params;
    const result = await pg.raw(\`
      SELECT cp.id AS assignment_id, cp.clinic_id, cp.promotion_id, cp.created_at AS assigned_at,
             p.code, p.type, p.status, p.is_automatic, p.created_at AS promotion_created_at
      FROM clinic_promotion cp
      LEFT JOIN promotion p ON p.id = cp.promotion_id
      WHERE cp.clinic_id = ?
      ORDER BY cp.created_at DESC
    \`, [clinicId]);
    return res.json({ promotions: result.rows });
  } catch (err) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" });
  }
}
async function POST(req, res) {
  try {
    const pg = req.scope.resolve("__pg_connection__");
    const { id: clinicId } = req.params;
    const { promotion_id } = req.body || {};
    if (!promotion_id) return res.status(400).json({ message: "promotion_id is required" });
    const promoCheck = await pg.raw("SELECT id FROM promotion WHERE id = ? LIMIT 1", [promotion_id]);
    if (!promoCheck.rows.length) return res.status(404).json({ message: "Promotion not found" });
    const id = "cprom_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    await pg.raw("INSERT INTO clinic_promotion (id, clinic_id, promotion_id) VALUES (?, ?, ?) ON CONFLICT (clinic_id, promotion_id) DO NOTHING", [id, clinicId, promotion_id]);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" });
  }
}
`,
  },
  {
    src: "src/api/admin/clinics/[id]/promotions/[promotionId]/route.ts",
    dst: ".medusa/server/src/api/admin/clinics/[id]/promotions/[promotionId]/route.js",
    content: `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DELETE = DELETE;
async function DELETE(req, res) {
  try {
    const pg = req.scope.resolve("__pg_connection__");
    const { id: clinicId, promotionId } = req.params;
    await pg.raw("DELETE FROM clinic_promotion WHERE clinic_id = ? AND promotion_id = ?", [clinicId, promotionId]);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" });
  }
}
`,
  },
  {
    src: "src/api/admin/clinics/[id]/orders/[orderId]/send-reminder/route.ts",
    dst: ".medusa/server/src/api/admin/clinics/[id]/orders/[orderId]/send-reminder/route.js",
    content: `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.POST = POST;
const framework_utils_1 = require("@medusajs/framework/utils");
async function POST(req, res) {
  try {
    const pg = req.scope.resolve("__pg_connection__");
    const notificationService = req.scope.resolve(framework_utils_1.Modules.NOTIFICATION);
    const { orderId } = req.params;
    const result = await pg.raw(\`
      SELECT ow.id AS workflow_id, ow.gfe_id, ow.order_id, ow.tenant_domain, ow.virtual_room_url,
             ow.created_at AS order_created_at, ow.status, o.email, o.display_id,
             oa.first_name, oa.last_name, c.name AS clinic_name, c.logo_url,
             c.from_email, c.from_name, c.reply_to, c.domains
      FROM order_workflow ow
      JOIN "order" o ON o.id = ow.order_id
      LEFT JOIN order_address oa ON oa.id = o.shipping_address_id
      JOIN clinic c ON (ow.tenant_domain = ANY(c.domains) OR ow.tenant_domain = ANY(SELECT split_part(d,':',1) FROM unnest(c.domains) AS d) OR o.sales_channel_id = c.sales_channel_id)
      WHERE o.id = ? AND ow.deleted_at IS NULL LIMIT 1
    \`, [orderId]);
    if (!result.rows.length) return res.status(404).json({ message: "Order not found" });
    const row = result.rows[0];
    if (row.status !== "pending_provider") return res.status(400).json({ message: \`Reminder only for pending_provider orders. Current: \${row.status}\` });
    if (!row.email) return res.status(400).json({ message: "No patient email on this order" });
    const domain = (row.domains || []).find(d => !d.includes("localhost") && !d.includes(".local")) || row.tenant_domain;
    const cleanDomain = domain.split(":")[0];
    const trackOrderUrl = \`https://\${cleanDomain}/us/order/status/\${row.gfe_id || row.order_id}\`;
    const patientName = [row.first_name, row.last_name].filter(Boolean).join(" ") || "Patient";
    const daysPending = Math.floor((Date.now() - new Date(row.order_created_at).getTime()) / 86400000);
    await notificationService.createNotifications({
      to: row.email, channel: "email", template: "order.pending_provider_reminder",
      data: { patient_name: patientName, patient_email: row.email, order_display_id: row.display_id,
              clinic_name: row.clinic_name, logo_url: row.logo_url || null, from_email: row.from_email || null,
              from_name: row.from_name || null, reply_to: row.reply_to || null, track_order_url: trackOrderUrl,
              virtual_room_url: row.virtual_room_url || null, days_pending: daysPending, status: "pending_provider" },
    });
    return res.json({ success: true, message: \`Reminder sent to \${row.email}\` });
  } catch (err) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" });
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
  // Always overwrite — ensures updates are applied on every deploy
  fs.writeFileSync(route.dst, route.content)
  console.log(`[postbuild] Wrote: ${route.dst}`)
}

console.log("[postbuild] Done.")

// ── Patch admin login page branding ──────────────────────────────────────────
const adminDist = path.join(".medusa", "server", "public", "admin", "assets")
if (fs.existsSync(adminDist)) {
  const files = fs.readdirSync(adminDist).filter(f => f.endsWith(".js"))
  let patched = false
  for (const file of files) {
    const filePath = path.join(adminDist, file)
    let content = fs.readFileSync(filePath, "utf8")
    if (content.includes("Welcome to Medusa")) {
      content = content.replace(/Welcome to Medusa/g, "MHC Clinic Administration")
      content = content.replace(/Sign in to access the account area/g, "Sign in to access the admin portal")
      fs.writeFileSync(filePath, content)
      console.log(`[postbuild] Patched login branding in ${file}`)
      patched = true
      break
    }
  }
  if (!patched) console.log("[postbuild] Warning: 'Welcome to Medusa' string not found in any admin asset")
}
