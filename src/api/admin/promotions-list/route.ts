import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * GET /admin/promotions-list — list all Medusa promotions (for clinic assignment UI)
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any

    const result = await pg.raw(`
      SELECT id, code, type, status, is_automatic, created_at
      FROM promotion
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 200
    `)

    return res.json({ promotions: result.rows })
  } catch (err: unknown) {
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
