import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const statusLabels: Record<string, string> = {
  pending_provider:    "Pending Provider Clearance",
  pending_md_review:   "Pending Physician Review",
  processing_pharmacy: "Processing by Pharmacy",
  shipped:             "Medication Shipped",
  refund_pending:      "Refund Processing",
  refunded:            "Refund Issued",
}

const statusDescriptions: Record<string, string> = {
  pending_provider:    "Your information has been submitted. A provider will review your consultation shortly.",
  pending_md_review:   "Your case has been referred to our Medical Director for additional review.",
  processing_pharmacy: "Your prescription has been approved and is being prepared by our pharmacy.",
  shipped:             "Your medication is on its way!",
  refund_pending:      "A refund is being processed for your order.",
  refunded:            "Your refund has been issued. Please allow 5-7 business days.",
}

function determineTreatmentOutcome(treatments: any[]): "approved" | "deferred" | "pending" {
  if (!treatments || treatments.length === 0) return "pending"
  const hasDefer = treatments.some((t: any) =>
    ["defer", "deferred"].includes((t.status || "").toLowerCase())
  )
  if (hasDefer) return "deferred"
  const allApproved = treatments.every((t: any) =>
    ["approve", "approved"].includes((t.status || "").toLowerCase())
  )
  if (allApproved) return "approved"
  return "pending"
}

function extractDosages(treatments: any[]): { treatmentId: number; treatmentName: string; dosage: string | null }[] {
  return treatments.map((t: any) => ({
    treatmentId: t.treatmentId,
    treatmentName: t.name || "",
    dosage: t.dosage ?? null,
  }))
}

/**
 * GET /store/orders/:gfeId/status
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pgConnection = req.scope.resolve("__pg_connection__") as any
    const clinicSvc = req.scope.resolve("clinic") as any
    const { gfeId } = req.params

    // Resolve the requesting clinic's domains for tenant scoping
    const host = (
      req.headers["x-forwarded-host"] ||
      req.headers["x-tenant-domain"] ||
      req.headers["host"] ||
      ""
    ) as string
    const domain = host.split(":")[0]
    const clinic = await clinicSvc.getClinicByDomain(host) || await clinicSvc.getClinicByDomain(domain)
    const allowedDomains: string[] = clinic?.domains ?? []
    if (clinic?.slug) allowedDomains.push(clinic.slug)

    // Build tenant filter — if we can't resolve a clinic, deny
    if (!clinic) {
      return res.status(404).json({ message: "Order not found" })
    }

    const result = await pgConnection.raw(`
      SELECT
        id, gfe_id, order_id, status,
        virtual_room_url, room_no,
        provider_status, provider_name, provider_reviewed_at,
        md_decision, md_notes, md_reviewed_at,
        tracking_number, carrier, shipped_at,
        treatment_dosages,
        refund_issued_at, refunded_at,
        created_at, updated_at
      FROM order_workflow
      WHERE (gfe_id = ? OR id = ?)
        AND (
          tenant_domain = ANY(?)
          OR order_id IN (
            SELECT id FROM "order" WHERE sales_channel_id = ?
          )
        )
      LIMIT 1
    `, [gfeId, gfeId, allowedDomains, clinic.sales_channel_id])

    if (!result.rows.length) {
      return res.status(404).json({ message: "Order not found" })
    }

    const order = result.rows[0]

    return res.json({
      gfeId: order.gfe_id,
      status: order.status,
      statusLabel: statusLabels[order.status] || order.status,
      statusDescription: statusDescriptions[order.status] || "",
      virtualRoomUrl: order.virtual_room_url,
      providerName: order.provider_name,
      treatmentDosages: order.treatment_dosages || [],
      tracking: order.tracking_number ? {
        trackingNumber: order.tracking_number,
        carrier: order.carrier,
        shippedAt: order.shipped_at,
      } : null,
      timeline: {
        submitted: order.created_at,
        providerReviewed: order.provider_reviewed_at,
        mdReviewed: order.md_reviewed_at,
        shipped: order.shipped_at,
        refunded: order.refunded_at,
      },
    })
  } catch (err: unknown) {
    console.error("Order status error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

/**
 * POST /store/orders/:gfeId/status
 * Manually trigger a GFE status check from provider API
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pgConnection = req.scope.resolve("__pg_connection__") as any
    const clinicSvc = req.scope.resolve("clinic") as any
    const { gfeId } = req.params

    const result = await pgConnection.raw(`
      SELECT * FROM order_workflow WHERE gfe_id = ? LIMIT 1
    `, [gfeId])

    if (!result.rows.length) return res.status(404).json({ message: "Order not found" })

    const workflow = result.rows[0]

    if (workflow.status !== "pending_provider") {
      return res.json({ status: workflow.status, message: "No refresh needed" })
    }

    const clinic = await clinicSvc.getClinicByDomain(workflow.tenant_domain)
    if (!clinic) return res.status(404).json({ message: "Clinic not found" })

    const token = await clinicSvc.getToken(clinic.id)
    const baseUrl = clinic.api_env === "prod"
      ? clinic.api_base_url_prod
      : clinic.api_base_url_test

    const gfeRes = await fetch(`${baseUrl}/gfe/status/${gfeId}`, {
      headers: { "Authorization": `Bearer ${token}` },
    })

    if (!gfeRes.ok) {
      return res.status(502).json({ message: "Failed to fetch status from provider" })
    }

    const gfeData = await gfeRes.json()
    const payload = gfeData?.payload

    // Array payload = still Pending
    if (Array.isArray(payload)) {
      return res.json({
        status: workflow.status,
        statusLabel: statusLabels[workflow.status],
        providerStatus: "Pending",
      })
    }

    const providerStatus = (payload?.status || "").toLowerCase()
    const treatments = payload?.treatments || []
    const providerName = payload?.providerName || null
    const outcome = determineTreatmentOutcome(treatments)
    const dosages = extractDosages(treatments)

    let newStatus = workflow.status

    if (providerStatus === "completed") {
      if (outcome === "approved") {
        newStatus = "processing_pharmacy"
        await pgConnection.raw(`
          UPDATE order_workflow
          SET status = 'processing_pharmacy',
              provider_status = 'approved',
              provider_name = ?,
              provider_reviewed_at = NOW(),
              treatment_dosages = ?::jsonb,
              updated_at = NOW()
          WHERE gfe_id = ?
        `, [providerName, JSON.stringify(dosages), gfeId])
      } else if (outcome === "deferred") {
        newStatus = "pending_md_review"
        await pgConnection.raw(`
          UPDATE order_workflow
          SET status = 'pending_md_review',
              provider_status = 'deferred',
              provider_name = ?,
              provider_reviewed_at = NOW(),
              treatment_dosages = ?::jsonb,
              updated_at = NOW()
          WHERE gfe_id = ?
        `, [providerName, JSON.stringify(dosages), gfeId])
      }
    }

    return res.json({
      status: newStatus,
      statusLabel: statusLabels[newStatus] || newStatus,
      providerStatus,
      outcome,
      treatmentDosages: dosages,
      treatments,
    })
  } catch (err: unknown) {
    console.error("Status refresh error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}