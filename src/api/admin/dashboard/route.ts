/**
 * GET /admin/dashboard
 * Returns order stats grouped by status and product for the Clinic Dashboard.
 * Supports ?clinicId=&dateFrom=&dateTo= filters.
 * clinic_admin / pharmacist / medical_director are auto-scoped to their own clinic.
 *
 * Clinic JOIN uses both tenant_domain AND sales_channel_id so historical orders
 * with old domains still match after domain changes.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

const CLINIC_JOIN = `
  JOIN clinic c ON (
    ow.tenant_domain = ANY(c.domains)
    OR ow.tenant_domain = ANY(SELECT split_part(d,':',1) FROM unnest(c.domains) AS d)
    OR o.sales_channel_id = c.sales_channel_id
  )
`

const TX_SUBQUERY = `
  LEFT JOIN (
    SELECT order_id, SUM(amount) AS amount
    FROM order_transaction
    WHERE reference = 'capture' AND deleted_at IS NULL
    GROUP BY order_id
  ) tx ON tx.order_id = o.id
`

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    let { clinicId, dateFrom, dateTo } = req.query as Record<string, string>

    // ── Resolve caller's role and auto-scope non-super-admins ────────────────
    const actorId = (req as any).session?.auth_context?.actor_id
    let callerRole = "super_admin"
    let callerClinicIds: string[] = []

    if (actorId) {
      const userResult = await pg.raw(`SELECT email FROM "user" WHERE id = ? LIMIT 1`, [actorId])
      const email = userResult.rows[0]?.email
      if (email) {
        const staffResult = await pg.raw(`
          SELECT cs.role, c.id AS clinic_id
          FROM clinic_staff cs
          JOIN clinic c ON cs.tenant_domain = ANY(c.domains)
          WHERE cs.email = ? AND cs.is_active = true AND cs.deleted_at IS NULL
        `, [email])
        if (staffResult.rows.length) {
          callerRole = staffResult.rows[0].role
          callerClinicIds = staffResult.rows.map((r: any) => r.clinic_id)
        }
      }
    }

    // For non-super-admins: if they pass a clinicId, validate it's one of theirs;
    // otherwise scope to all their clinics
    if (callerRole !== "super_admin") {
      if (clinicId && !callerClinicIds.includes(clinicId)) clinicId = ""
    }

    // ── Build WHERE clauses ──────────────────────────────────────────────────
    const conditions: string[] = ["ow.deleted_at IS NULL"]
    const bindings: any[] = []

    if (clinicId) {
      conditions.push(`c.id = ?`)
      bindings.push(clinicId)
    } else if (callerRole !== "super_admin" && callerClinicIds.length > 0) {
      const ids = callerClinicIds.map(() => "?").join(", ")
      conditions.push(`c.id IN (${ids})`)
      bindings.push(...callerClinicIds)
    }
    if (dateFrom) { conditions.push(`o.created_at >= ?`); bindings.push(dateFrom) }
    if (dateTo)   { conditions.push(`o.created_at <= ?`); bindings.push(dateTo + "T23:59:59Z") }

    const where = `WHERE ${conditions.join(" AND ")}`

    const byStatus = await pg.raw(`
      SELECT ow.status, COUNT(DISTINCT o.id)::int AS count, COALESCE(SUM(tx.amount), 0) AS total
      FROM order_workflow ow
      JOIN "order" o ON o.id = ow.order_id
      ${TX_SUBQUERY} ${CLINIC_JOIN} ${where}
      GROUP BY ow.status ORDER BY count DESC
    `, bindings)

    const byProduct = await pg.raw(`
      SELECT li.title AS product, COUNT(DISTINCT o.id)::int AS count, COALESCE(SUM(DISTINCT tx.amount), 0) AS total
      FROM order_workflow ow
      JOIN "order" o ON o.id = ow.order_id
      ${TX_SUBQUERY} ${CLINIC_JOIN}
      JOIN order_item oi ON oi.order_id = o.id
      JOIN order_line_item li ON li.id = oi.item_id
      ${where}
      GROUP BY li.title ORDER BY count DESC LIMIT 10
    `, bindings)

    const summary = await pg.raw(`
      SELECT COUNT(DISTINCT o.id)::int AS total_orders, COALESCE(SUM(tx.amount), 0) AS total_revenue
      FROM order_workflow ow
      JOIN "order" o ON o.id = ow.order_id
      ${TX_SUBQUERY} ${CLINIC_JOIN} ${where}
    `, bindings)

    let clinics: any[] = []
    if (callerRole === "super_admin") {
      const cr = await pg.raw(`SELECT id, name FROM clinic WHERE deleted_at IS NULL ORDER BY name`)
      clinics = cr.rows
    } else if (callerClinicIds.length > 1) {
      // Multi-clinic admin — return their clinics so the frontend can show a picker
      const ids = callerClinicIds.map(() => "?").join(", ")
      const cr = await pg.raw(
        `SELECT id, name FROM clinic WHERE id IN (${ids}) AND deleted_at IS NULL ORDER BY name`,
        callerClinicIds
      )
      clinics = cr.rows
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
