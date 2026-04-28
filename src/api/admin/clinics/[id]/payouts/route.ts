import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * GET /admin/clinics/:id/payouts?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Calculates pending pharmacy amounts live from order_workflow + product_payout_cost.
 * Matches orders to clinic via sales_channel_id (reliable — set by Medusa core).
 * An order counts as paid if vendor_ledger has a 'paid' row for it.
 * Pharmacy payouts: only shipped orders. Date filter: order_workflow.created_at.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id } = req.params
    const from = (req.query?.from as string) || null
    const to   = (req.query?.to   as string) || null

    // Get the clinic's sales_channel_id — this is how we tie orders to a clinic
    const clinicRes = await pg.raw(
      `SELECT sales_channel_id FROM clinic WHERE id = ? LIMIT 1`, [id]
    )
    const salesChannelId: string | null = clinicRes.rows[0]?.sales_channel_id || null

    const emptyResponse = {
      pending: {
        clinic:   { total: 0, count: 0, entries: [] },
        pharmacy: { total: 0, count: 0, entries: [] },
      },
      history: [],
    }

    if (!salesChannelId) return res.json(emptyResponse)

    const dateCondition = from && to
      ? `AND ow.created_at >= ?::date AND ow.created_at < (?::date + INTERVAL '1 day')`
      : from ? `AND ow.created_at >= ?::date`
      : to   ? `AND ow.created_at < (?::date + INTERVAL '1 day')`
      : ""
    const dateParams: string[] = from && to ? [from, to] : from ? [from] : to ? [to] : []

    const [ordersRes, historyRes] = await Promise.all([
      pg.raw(`
        SELECT
          ow.order_id,
          ow.status                  AS workflow_status,
          o.display_id,
          COALESCE(
            (os.totals->>'current_order_total')::numeric,
            (os.totals->>'original_order_total')::numeric,
            (os.totals->>'total')::numeric,
            0
          )                          AS order_total,
          ow.created_at,
          COALESCE((
            SELECT SUM(ppc.pharmacy_cost * oi.quantity)
            FROM order_item       oi
            JOIN order_line_item  oli ON oli.id = oi.item_id
            JOIN product_payout_cost ppc
              ON ppc.clinic_id = ? AND ppc.product_id = oli.product_id
            WHERE oi.order_id = o.id
          ), 0)                      AS pharmacy_amount,
          EXISTS(
            SELECT 1 FROM vendor_ledger
            WHERE order_id = ow.order_id AND clinic_id = ?
              AND vendor_type = 'pharmacy' AND status = 'paid'
          )                          AS pharmacy_paid
        FROM order_workflow ow
        JOIN "order" o
          ON o.id = ow.order_id
          AND o.sales_channel_id = ?
        LEFT JOIN LATERAL (
          SELECT totals FROM order_summary
          WHERE order_id = o.id AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 1
        ) os ON true
        WHERE ow.status != 'refund_issued'
          ${dateCondition}
        ORDER BY ow.created_at ASC
      `, [id, id, salesChannelId, ...dateParams]),

      pg.raw(`
        SELECT * FROM vendor_payout
        WHERE clinic_id = ?
        ORDER BY paid_at DESC
        LIMIT 100
      `, [id]),
    ])

    const pending: Record<string, { total: number; count: number; entries: any[] }> = {
      clinic:   { total: 0, count: 0, entries: [] },
      pharmacy: { total: 0, count: 0, entries: [] },
    }

    for (const row of ordersRes.rows) {
      const pharmacyAmt = Number(row.pharmacy_amount) || 0

      // Pharmacy only gets paid for shipped orders with a configured product cost
      if (!row.pharmacy_paid && pharmacyAmt > 0 && row.workflow_status === "shipped") {
        pending.pharmacy.total += pharmacyAmt
        pending.pharmacy.count++
        pending.pharmacy.entries.push({
          order_id:    row.order_id,
          display_id:  row.display_id,
          order_total: Number(row.order_total),
          amount_owed: pharmacyAmt,
          created_at:  row.created_at,
        })
      }
    }

    pending.pharmacy.total = Number(pending.pharmacy.total.toFixed(2))

    return res.json({ pending, history: historyRes.rows })
  } catch (err: unknown) {
    console.error("[payouts GET]", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

/**
 * POST /admin/clinics/:id/payouts
 * Records a manual pharmacy payout for all shipped+unpaid orders in the date range.
 * Creates ONE vendor_payout record with a reference number.
 * For each order: updates an existing pending vendor_ledger row to 'paid',
 * or inserts a new 'paid' row if the order has no ledger entry yet.
 * Body: { vendor_type, reference_number, notes, paid_by, from?, to? }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id } = req.params
    const { vendor_type, reference_number, notes, paid_by, from, to } = req.body as any

    if (!vendor_type || !["clinic", "pharmacy"].includes(vendor_type)) {
      return res.status(400).json({ message: "vendor_type must be 'clinic' or 'pharmacy'" })
    }
    if (!reference_number?.trim()) {
      return res.status(400).json({ message: "reference_number is required" })
    }

    const clinicRes = await pg.raw(
      `SELECT sales_channel_id FROM clinic WHERE id = ? LIMIT 1`, [id]
    )
    const salesChannelId: string | null = clinicRes.rows[0]?.sales_channel_id || null
    if (!salesChannelId) {
      return res.status(400).json({ message: "No sales channel configured for this clinic" })
    }

    const dateCondition = from && to
      ? `AND ow.created_at >= ?::date AND ow.created_at < (?::date + INTERVAL '1 day')`
      : from ? `AND ow.created_at >= ?::date`
      : to   ? `AND ow.created_at < (?::date + INTERVAL '1 day')`
      : ""
    const dateParams: string[] = from && to ? [from, to] : from ? [from] : to ? [to] : []

    // Pharmacy: shipped orders only. Clinic: all non-refunded.
    const statusCondition = vendor_type === "pharmacy"
      ? `AND ow.status = 'shipped'`
      : `AND ow.status != 'refund_issued'`

    const ordersRes = await pg.raw(`
      SELECT
        ow.order_id,
        COALESCE(
          (os.totals->>'current_order_total')::numeric,
          (os.totals->>'original_order_total')::numeric,
          (os.totals->>'total')::numeric,
          0
        ) AS order_total,
        COALESCE((
          SELECT SUM(ppc.pharmacy_cost * oi.quantity)
          FROM order_item       oi
          JOIN order_line_item  oli ON oli.id = oi.item_id
          JOIN product_payout_cost ppc
            ON ppc.clinic_id = ? AND ppc.product_id = oli.product_id
          WHERE oi.order_id = o.id
        ), 0) AS pharmacy_amount
      FROM order_workflow ow
      JOIN "order" o
        ON o.id = ow.order_id
        AND o.sales_channel_id = ?
      LEFT JOIN LATERAL (
        SELECT totals FROM order_summary
        WHERE order_id = o.id AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      ) os ON true
      WHERE TRUE
        ${statusCondition}
        AND NOT EXISTS (
          SELECT 1 FROM vendor_ledger
          WHERE order_id = ow.order_id AND clinic_id = ? AND vendor_type = ? AND status = 'paid'
        )
        ${dateCondition}
    `, [id, salesChannelId, id, vendor_type, ...dateParams])

    const entries = ordersRes.rows
      .map((row: any) => {
        const pharmacyAmt = Number(row.pharmacy_amount) || 0
        const clinicAmt   = Math.max(0, Number(row.order_total) - pharmacyAmt)
        return {
          order_id:    row.order_id,
          order_total: Number(row.order_total),
          amount_owed: Number((vendor_type === "pharmacy" ? pharmacyAmt : clinicAmt).toFixed(2)),
        }
      })
      .filter((e: any) => e.amount_owed > 0)

    if (entries.length === 0) {
      return res.status(400).json({ message: "No unpaid orders for this vendor in the selected range" })
    }

    const totalAmount  = Number(entries.reduce((s: number, e: any) => s + e.amount_owed, 0).toFixed(2))
    const rangeNote    = from || to ? `Period: ${from || "—"} to ${to || "—"}` : null
    const finalNotes   = [notes, rangeNote].filter(Boolean).join(" | ") || null
    const payoutId     = `payout_${Date.now()}_${vendor_type}`

    await pg.raw(`
      INSERT INTO vendor_payout
        (id, clinic_id, vendor_type, total_amount, currency,
         reference_number, transfer_method, notes, status, paid_at, paid_by)
      VALUES (?, ?, ?, ?, 'usd', ?, 'manual', ?, 'completed', NOW(), ?)
    `, [payoutId, id, vendor_type, totalAmount,
        reference_number.trim(), finalNotes, paid_by || null])

    // Update existing pending rows, or insert new paid rows for backfilled orders
    for (const entry of entries) {
      const updated = await pg.raw(`
        UPDATE vendor_ledger
        SET status = 'paid', payout_id = ?, updated_at = NOW()
        WHERE order_id = ? AND clinic_id = ? AND vendor_type = ? AND status = 'pending'
        RETURNING id
      `, [payoutId, entry.order_id, id, vendor_type])

      if ((updated.rows || []).length === 0) {
        const ledgerId = `vl_${id.slice(-8)}_${vendor_type[0]}_${entry.order_id.slice(-8)}`
        await pg.raw(`
          INSERT INTO vendor_ledger
            (id, clinic_id, vendor_type, order_id, order_total, amount_owed,
             currency, status, payout_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'usd', 'paid', ?, NOW(), NOW())
          ON CONFLICT (id) DO UPDATE
            SET status = 'paid', payout_id = EXCLUDED.payout_id, updated_at = NOW()
        `, [ledgerId, id, vendor_type, entry.order_id,
            entry.order_total, entry.amount_owed, payoutId])
      }
    }

    return res.json({
      success:      true,
      payout_id:    payoutId,
      total_paid:   totalAmount,
      entries_paid: entries.length,
    })
  } catch (err: unknown) {
    console.error("[payouts POST]", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
