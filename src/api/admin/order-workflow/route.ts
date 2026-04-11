import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * GET /admin/order-workflow?limit=20&offset=0&q=search
 *
 * Returns paginated orders joined with workflow data, sorted newest first.
 * Filters by clinic based on the logged-in user's role:
 *   - Super admin (not in clinic_staff) → all orders
 *   - Clinic admin / MD / Pharmacist → only their assigned clinic(s)
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any

    const limit = parseInt((req.query?.limit as string) ?? "20", 10)
    const offset = parseInt((req.query?.offset as string) ?? "0", 10)
    const q = ((req.query?.q as string) ?? "").trim()
    const statusParam = ((req.query?.status as string) ?? "").trim()

    // ── 1. Get logged-in user's email ─────────────────────────────────────
    const actorId = (req.session as any)?.auth_context?.actor_id
    if (!actorId) {
      return res.status(401).json({ message: "Unauthorized" })
    }

    const userResult = await pg.raw(
      `SELECT email FROM "user" WHERE id = ? LIMIT 1`,
      [actorId]
    )
    const userEmail = userResult.rows[0]?.email
    if (!userEmail) {
      return res.status(401).json({ message: "User not found" })
    }

    // ── 2. Look up clinic_staff rows for this user ────────────────────────
    const staffResult = await pg.raw(
      `SELECT clinic_id, role, tenant_domain
       FROM clinic_staff
       WHERE email = ?
         AND is_active = true
         AND deleted_at IS NULL`,
      [userEmail]
    )
    const staffRows = staffResult.rows ?? []

    // Super admin = not in clinic_staff at all
    const isSuperAdmin = staffRows.length === 0

    // ── 3. Build clinic filter ────────────────────────────────────────────
    // clinic_staff has tenant_domain (e.g. 'spaderx.com')
    // clinic.domains is an array (e.g. {spaderx.com, localhost:8000})
    // order_workflow.tenant_domain may be any value in that array
    // So we: staff.tenant_domain → ANY(clinic.domains) → get clinic ids
    //        then filter wf.tenant_domain = ANY(clinic.domains) for those clinics
    let clinicFilter = ""
    let clinicParams: string[] = []

    if (!isSuperAdmin) {
      const staffDomains: string[] = staffRows.map((r: any) => r.tenant_domain).filter(Boolean)
      if (staffDomains.length === 0) {
        return res.json({ orders: [], count: 0, limit, offset })
      }

      // Find clinic IDs where any of the user's tenant_domains appear in clinic.domains
      const domainPlaceholders = staffDomains.map(() => "?").join(", ")
      const clinicIdResult = await pg.raw(
        `SELECT DISTINCT id FROM clinic
         WHERE deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM unnest(domains) AS d
             WHERE d = ANY(ARRAY[${domainPlaceholders}]::text[])
           )`,
        staffDomains
      )
      const clinicIds: string[] = (clinicIdResult.rows ?? []).map((r: any) => r.id)

      if (clinicIds.length === 0) {
        return res.json({ orders: [], count: 0, limit, offset })
      }

      // Filter orders: wf.tenant_domain must be in the domains of those clinics
      // OR order's sales_channel_id matches the clinic's sales_channel_id
      const safeIds = clinicIds.map(id => `'${id.replace(/'/g, "''")}'`).join(", ")
      clinicFilter = `AND EXISTS (
        SELECT 1 FROM clinic cl
        WHERE cl.id IN (${safeIds})
          AND cl.deleted_at IS NULL
          AND (
            wf.tenant_domain = ANY(cl.domains)
            OR o.sales_channel_id = cl.sales_channel_id
          )
      )`
      clinicParams = [] // no params needed — IDs are inlined
    }

    // ── 4. Build search filter ────────────────────────────────────────────
    const searchFilter = q
      ? `AND (
          CAST(o.display_id AS TEXT) ILIKE ?
          OR c.first_name ILIKE ?
          OR c.last_name ILIKE ?
          OR c.email ILIKE ?
          OR oa.first_name ILIKE ?
          OR oa.last_name ILIKE ?
        )`
      : ""
    const searchParams = q ? Array(6).fill(`%${q}%`) : []

    const statusFilter2 = statusParam ? `AND wf.status = ?` : ""
    const statusParams = statusParam ? [statusParam] : []

    // ── 5. Count ──────────────────────────────────────────────────────────
    const countSql = `SELECT COUNT(DISTINCT o.id) AS total
       FROM "order" o
       LEFT JOIN "customer" c     ON c.id  = o.customer_id
       LEFT JOIN "order_address" oa ON oa.id = o.shipping_address_id
       INNER JOIN "order_workflow" wf ON wf.order_id = o.id AND wf.deleted_at IS NULL
       WHERE o.deleted_at IS NULL
         AND o.is_draft_order = false
         ${clinicFilter}
         ${searchFilter}
         ${statusFilter2}`
    const countBindings = [...clinicParams, ...searchParams, ...statusParams]

    const countResult = await pg.raw(countSql, countBindings)
    const total = parseInt(countResult.rows[0]?.total ?? "0", 10)

    // ── 6. Main query ─────────────────────────────────────────────────────
    const dataResult = await pg.raw(
      `SELECT
        o.id,
        o.display_id,
        o.created_at,
        o.currency_code,
        c.first_name          AS customer_first_name,
        c.last_name           AS customer_last_name,
        c.email               AS customer_email,
        oa.first_name         AS shipping_first_name,
        oa.last_name          AS shipping_last_name,
        oa.province           AS shipping_province,
        sc.name               AS sales_channel_name,
        os.totals             AS order_totals,
        wf.id                 AS wf_id,
        wf.status             AS wf_status,
        wf.provider_status,
        wf.treatment_dosages,
        wf.shipped_at,
        wf.tracking_number,
        wf.carrier
       FROM "order" o
       LEFT JOIN "customer" c         ON c.id  = o.customer_id
       LEFT JOIN "order_address" oa   ON oa.id = o.shipping_address_id
       LEFT JOIN "sales_channel" sc   ON sc.id = o.sales_channel_id
       LEFT JOIN LATERAL (
         SELECT totals FROM "order_summary"
         WHERE order_id = o.id AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 1
       ) os ON true
       INNER JOIN "order_workflow" wf  ON wf.order_id = o.id AND wf.deleted_at IS NULL
       WHERE o.deleted_at IS NULL
         AND o.is_draft_order = false
         ${clinicFilter}
         ${searchFilter}
         ${statusFilter2}
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [...clinicParams, ...searchParams, ...statusParams, limit, offset]
    )

    const rows = dataResult.rows ?? []

    const orders = rows.map((row: any) => {
      let orderTotal = 0
      try {
        const totals = typeof row.order_totals === "string"
          ? JSON.parse(row.order_totals)
          : row.order_totals
        orderTotal =
          totals?.current_order_total ??
          totals?.original_order_total ??
          totals?.total ??
          0
      } catch { /* leave as 0 */ }

      const treatment_dosages =
        row.treatment_dosages && typeof row.treatment_dosages === "object"
          ? JSON.stringify(row.treatment_dosages)
          : row.treatment_dosages ?? null

      return {
        id: row.id,
        display_id: row.display_id,
        created_at: row.created_at,
        currency_code: row.currency_code ?? "usd",
        total: orderTotal,
        customer: {
          first_name: row.customer_first_name,
          last_name: row.customer_last_name,
          email: row.customer_email,
        },
        shipping_address: {
          first_name: row.shipping_first_name,
          last_name: row.shipping_last_name,
          province: row.shipping_province,
        },
        sales_channel: {
          name: row.sales_channel_name,
        },
        workflow: row.wf_id ? {
          id: row.wf_id,
          order_id: row.id,
          status: row.wf_status,
          provider_status: row.provider_status,
          treatment_dosages,
          shipped_at: row.shipped_at,
          tracking_number: row.tracking_number,
          carrier: row.carrier,
        } : null,
      }
    })

    return res.json({ orders, count: total, limit, offset })
  } catch (err: any) {
    console.error("[order-workflow] Error:", err.message)
    return res.status(500).json({ message: err.message })
  }
}