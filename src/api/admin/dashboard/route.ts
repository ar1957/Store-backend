/**
 * GET /admin/dashboard
 * Returns order stats grouped by status and product for the Clinic Dashboard.
 * Supports ?clinicId=&dateFrom=&dateTo= filters.
 * clinic_admin / pharmacist / medical_director are auto-scoped to their own clinic.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    let { clinicId, dateFrom, dateTo } = req.query as Record<string, string>

    // ── Resolve caller's role and auto-scope non-super-admins ────────────────
    const actorId = (req as any).session?.auth_context?.actor_id
    let callerRole = "super_admin"
    let callerClinicId: string | null = null

    if (actorId) {
      const userResult = await pg.raw(`SELECT email FROM "user" WHERE id = ? LIMIT 1`, [actorId])
      const email = userResult.rows[0]?.email
      if (email) {
        const staffResult = await pg.raw(`
          SELECT cs.role, c.id AS clinic_id
          FROM clinic_staff cs
          JOIN clinic c ON cs.tenant_domain = ANY(c.domains)
          WHERE cs.email = ? AND cs.is_active = true AND cs.deleted_at IS NULL
          LIMIT 1
        `, [email])
        if (staffResult.rows.length) {
          callerRole = staffResult.rows[0].role
          callerClinicId = staffResult.rows[0].clinic_id
        }
      }
    }

    // Non-super-admins always see only their clinic — ignore any clinicId param
    if (callerRole !== "super_admin" && callerClinicId) {
      clinicId = callerClinicId
    }

    // ── Build WHERE clauses ──────────────────────────────────────────────────
    const conditions: string[] = ["ow.deleted_at IS NULL"]
    const bindings: any[] = []

    if (clinicId) {
      conditions.push(`c.id = ?`)
      bindings.push(clinicId)
    }
    if (dateFrom) {
      conditions.push(`o.created_at >= ?`)
      bindings.push(dateFrom)
    }
    if (dateTo) {
      conditions.push(`o.created_at <= ?`)
      bindings.push(dateTo + "T23:59:59Z")
    }

    const where = `WHERE ${conditions.join(" AND ")}`

    // Orders by status — count distinct orders per status
    const byStatus = await pg.raw(`
      SELECT
        ow.status,
        COUNT(DISTINCT o.id)::int AS count,
        COALESCE(SUM(tx.amount), 0) AS total
      FROM order_workflow ow
      JOIN "order" o ON o.id = ow.order_id
      LEFT JOIN (
        SELECT order_id, SUM(amount) AS amount
        FROM order_transaction
        WHERE reference = 'capture' AND deleted_at IS NULL
        GROUP BY order_id
      ) tx ON tx.order_id = o.id
      JOIN clinic c ON (
        ow.tenant_domain = ANY(c.domains)
        OR ow.tenant_domain = ANY(SELECT split_part(d,':',1) FROM unnest(c.domains) AS d)
      )
      ${where}
      GROUP BY ow.status
      ORDER BY count DESC
    `, bindings)

    // Orders by product — count distinct orders per product title
    const byProduct = await pg.raw(`
      SELECT
        li.title AS product,
        COUNT(DISTINCT o.id)::int AS count,
        COALESCE(SUM(DISTINCT tx.amount), 0) AS total
      FROM order_workflow ow
      JOIN "order" o ON o.id = ow.order_id
      LEFT JOIN (
        SELECT order_id, SUM(amount) AS amount
        FROM order_transaction
        WHERE reference = 'capture' AND deleted_at IS NULL
        GROUP BY order_id
      ) tx ON tx.order_id = o.id
      JOIN clinic c ON (
        ow.tenant_domain = ANY(c.domains)
        OR ow.tenant_domain = ANY(SELECT split_part(d,':',1) FROM unnest(c.domains) AS d)
      )
      JOIN order_item oi ON oi.order_id = o.id
      JOIN order_line_item li ON li.id = oi.item_id
      ${where}
      GROUP BY li.title
      ORDER BY count DESC
      LIMIT 10
    `, bindings)

    // Summary totals
    const summary = await pg.raw(`
      SELECT
        COUNT(DISTINCT o.id)::int AS total_orders,
        COALESCE(SUM(tx.amount), 0) AS total_revenue
      FROM order_workflow ow
      JOIN "order" o ON o.id = ow.order_id
      LEFT JOIN (
        SELECT order_id, SUM(amount) AS amount
        FROM order_transaction
        WHERE reference = 'capture' AND deleted_at IS NULL
        GROUP BY order_id
      ) tx ON tx.order_id = o.id
      JOIN clinic c ON (
        ow.tenant_domain = ANY(c.domains)
        OR ow.tenant_domain = ANY(SELECT split_part(d,':',1) FROM unnest(c.domains) AS d)
      )
      ${where}
    `, bindings)

    // Clinic list — only for super_admin
    let clinics: any[] = []
    if (callerRole === "super_admin") {
      const clinicsResult = await pg.raw(`SELECT id, name FROM clinic WHERE deleted_at IS NULL ORDER BY name`)
      clinics = clinicsResult.rows
    }

    return res.json({
      byStatus: byStatus.rows,
      byProduct: byProduct.rows,
      summary: summary.rows[0],
      clinics,
      role: callerRole,
      scopedClinicId: callerRole !== "super_admin" ? clinicId : null,
    })
  } catch (err: any) {
    console.error("[Dashboard] Error:", err.message)
    return res.status(500).json({ message: err.message })
  }
}
