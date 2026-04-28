import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * GET /admin/payouts/references?q=<search>
 * Returns payout records (id, reference_number, paid_at, total_amount, vendor_type, order_count)
 * for the reference-number lookahead dropdown in Clinic Orders.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const q = ((req.query?.q as string) ?? "").trim()

    const searchFilter = q ? `AND vp.reference_number ILIKE ?` : ""
    const searchParams = q ? [`%${q}%`] : []

    const result = await pg.raw(`
      SELECT
        vp.id,
        vp.reference_number,
        vp.paid_at,
        vp.total_amount,
        vp.vendor_type,
        COUNT(vl.id)::int AS order_count
      FROM vendor_payout vp
      LEFT JOIN vendor_ledger vl ON vl.payout_id = vp.id
      WHERE vp.reference_number IS NOT NULL
        AND vp.reference_number != ''
        ${searchFilter}
      GROUP BY vp.id, vp.reference_number, vp.paid_at, vp.total_amount, vp.vendor_type
      ORDER BY vp.paid_at DESC
      LIMIT 50
    `, searchParams)

    return res.json({ references: result.rows ?? [] })
  } catch (err: any) {
    console.error("[payouts/references]", err)
    return res.status(500).json({ message: err.message })
  }
}
