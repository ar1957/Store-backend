import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * GET /admin/order-workflow/:orderId/payout-status
 * Returns pharmacy payout status for a single order.
 * Used by the order detail widget to show ref # and paid date.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const { orderId } = req.params
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const result = await pg.raw(`
      SELECT
        vl.vendor_type,
        vl.amount_owed,
        vl.status,
        vp.reference_number,
        vp.paid_at,
        vp.notes
      FROM vendor_ledger vl
      LEFT JOIN vendor_payout vp ON vp.id = vl.payout_id
      WHERE vl.order_id = ?
        AND vl.vendor_type = 'pharmacy'
      ORDER BY vl.updated_at DESC
      LIMIT 1
    `, [orderId])

    const row = result.rows?.[0] ?? null
    return res.json({
      pharmacy: row ? {
        status:    row.status,
        amount:    row.amount_owed ? Number(row.amount_owed) : null,
        reference: row.reference_number ?? null,
        paid_at:   row.paid_at ?? null,
        notes:     row.notes ?? null,
      } : null,
    })
  } catch (err: unknown) {
    console.error("[payout-status]", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
