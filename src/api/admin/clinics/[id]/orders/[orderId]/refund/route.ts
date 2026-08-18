/**
 * GET  /admin/clinics/:id/orders/:orderId/refund — remaining refundable amount
 * POST /admin/clinics/:id/orders/:orderId/refund — issue a refund
 *
 * Issues a real Stripe/PayPal/Authorize.net refund using the clinic's own
 * gateway credentials (since payments go through pp_system_default, Medusa's
 * refundPaymentWorkflow won't call the gateway — we must do it directly).
 *
 * Supports partial refunds: `amount` (in dollars) may be any value greater
 * than $0 and up to the payment's remaining refundable amount (captured
 * amount minus any refunds already issued against it). Omitting `amount`
 * refunds the full remaining amount, preserving old callers' behavior.
 *
 * The actual gateway/DB logic lives in utils/issue-refund.ts — shared with
 * the delete/cancel-order route so both paths issue refunds identically.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { getRefundableAmount, issueRefund } from "../../../../../utils/issue-refund"

// GET /admin/clinics/:id/orders/:orderId/refund
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const info = await getRefundableAmount(pg, req.params.orderId)
    if (!info) return res.status(404).json({ message: "No payment found for this order" })

    return res.json({
      captured: Number(info.capturedDollars.toFixed(2)),
      already_refunded: Number(info.refundedDollars.toFixed(2)),
      remaining: Number(Math.max(0, info.remainingDollars).toFixed(2)),
      currency: info.currency,
    })
  } catch (err: any) {
    return res.status(500).json({ message: err.message })
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId, orderId } = req.params
    const { reason, amount } = req.body as any

    if (!reason?.trim()) {
      return res.status(400).json({ message: "Refund reason is required" })
    }

    const result = await issueRefund(req, pg, clinicId, orderId, reason, amount)
    if (!result.success) {
      return res.status(result.status).json({ message: result.message })
    }

    return res.json(result)
  } catch (err: any) {
    console.error("[Refund] Error:", err.message)
    return res.status(500).json({ message: err.message })
  }
}
