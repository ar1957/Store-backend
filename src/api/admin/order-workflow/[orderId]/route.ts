import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * GET /admin/order-workflow?order_ids=id1,id2,id3
 *
 * Batch-fetches order_workflow rows for a list of order IDs.
 * Used by the Clinic Orders list page to populate workflow columns
 * without making one request per row.
 *
 * Response: { workflows: OrderWorkflow[] }
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const orderIdsParam = req.query?.order_ids as string | undefined

  if (!orderIdsParam) {
    return res.status(400).json({ message: "order_ids query param is required" })
  }

  const orderIds = orderIdsParam
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)

  if (orderIds.length === 0) {
    return res.json({ workflows: [] })
  }

  try {
    let workflows: any[] = []

    // Build placeholders: $1, $2, ... for raw PG  OR  ? for knex
    const pgPlaceholders = orderIds.map((_, i) => `$${i + 1}`).join(", ")

    // ── Try raw pg client first ──────────────────────────────────────────
    try {
      const pgClient = req.scope.resolve("__pg_connection__") as any
      const result = await pgClient.raw(
        `SELECT
          id,
          order_id,
          status,
          provider_status,
          treatment_dosages,
          shipped_at,
          tracking_number,
          carrier,
          refund_id,
          created_at,
          updated_at
        FROM order_workflow
        WHERE order_id IN (${pgPlaceholders})
          AND deleted_at IS NULL`,
        orderIds
      )
      workflows = result?.rows ?? result ?? []
    } catch {
      // ── Fallback: knex ────────────────────────────────────────────────
      try {
        const knex = req.scope.resolve("__knex__") as any
        workflows = await knex("order_workflow")
          .select(
            "id",
            "order_id",
            "status",
            "provider_status",
            "treatment_dosages",
            "shipped_at",
            "tracking_number",
            "carrier",
            "refund_id",
            "created_at",
            "updated_at"
          )
          .whereIn("order_id", orderIds)
          .whereNull("deleted_at")
      } catch (knexErr) {
        console.error("[order-workflow] knex fallback failed:", knexErr)
        // Return empty rather than 500 — page degrades gracefully
        return res.json({ workflows: [] })
      }
    }

    // Ensure treatment_dosages is returned as a string so the frontend
    // can JSON.parse it (some drivers return it already parsed as object)
    const normalized = workflows.map((wf) => ({
      ...wf,
      treatment_dosages:
        wf.treatment_dosages && typeof wf.treatment_dosages === "object"
          ? JSON.stringify(wf.treatment_dosages)
          : wf.treatment_dosages ?? null,
    }))

    return res.json({ workflows: normalized })
  } catch (error: any) {
    console.error("[order-workflow route] Unexpected error:", error)
    return res.status(500).json({ message: error?.message ?? "Internal error" })
  }
}