/**
 * POST /admin/clinics/:id/orders/:orderId/md-decision
 * File: src/api/admin/clinics/[id]/orders/[orderId]/md-decision/route.ts
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { INotificationModuleService } from "@medusajs/framework/types"
import { submitToPharmacyIfEnabled } from "../../../../../utils/pharmacy-submit"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId, orderId } = req.params
    const { decision, notes, md_user_id, user_email, user_name } = req.body as any

    if (!["approved", "denied"].includes(decision)) {
      return res.status(400).json({ message: "Invalid decision. Must be 'approved' or 'denied'" })
    }

    // Get workflow
    const wf = await pg.raw(
      `SELECT id, status FROM order_workflow WHERE order_id = ? LIMIT 1`,
      [orderId]
    )
    if (!wf.rows.length) {
      return res.status(404).json({ message: "Order workflow not found" })
    }

    const workflow = wf.rows[0]
    const newStatus = decision === "approved" ? "processing_pharmacy" : "md_denied"

    // Update workflow
    await pg.raw(
      `UPDATE order_workflow 
       SET status = ?, md_decision = ?, md_notes = ?, md_user_id = ?, 
           md_decided_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [newStatus, decision, notes || null, md_user_id || null, workflow.id]
    )

    // Auto-submit to pharmacy if approved and clinic has pharmacy API enabled
    if (decision === "approved") {
      const wfDosages = await pg.raw(`SELECT treatment_dosages FROM order_workflow WHERE id = ? LIMIT 1`, [workflow.id])
      const dosages = wfDosages.rows[0]?.treatment_dosages || []
      submitToPharmacyIfEnabled(pg, clinicId, orderId, workflow.id, dosages)
        .catch(e => console.error("[MD Decision] Pharmacy submit error:", e.message))
    }

    // Save notes as a comment if provided
    if (notes?.trim()) {
      try {
        const commentId = `cmt_${Date.now()}`
        await pg.raw(
          `INSERT INTO order_comment 
           (id, order_workflow_id, user_id, user_email, user_name, role, comment, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
          [commentId, workflow.id, md_user_id || "unknown", user_email || "", user_name || "Medical Director", "medical_director", notes.trim()]
        )
      } catch (commentErr) {
        console.error("[MD Decision] Comment save error:", commentErr)
      }
    }

    // If denied, mark refund in workflow
    if (decision === "denied") {
      try {
        const orderResult = await pg.raw(
          `SELECT o.id FROM "order" o WHERE o.id = ? LIMIT 1`,
          [orderId]
        )
        if (orderResult.rows.length) {
          await pg.raw(
            `UPDATE order_workflow 
             SET refund_reason = ?, refund_issued_at = NOW(), updated_at = NOW()
             WHERE id = ?`,
            [notes || "MD denied treatment", workflow.id]
          )
        }
      } catch (refundErr) {
        console.error("[MD Decision] Refund error:", refundErr)
      }
    }

    // ── Send status update email to patient ──────────────────────────────
    try {
      const orderResult = await pg.raw(
        `SELECT
          o.display_id,
          o.email,
          c.first_name AS customer_first_name,
          c.last_name  AS customer_last_name,
          oa.first_name AS shipping_first_name,
          oa.last_name  AS shipping_last_name,
          sc.name AS clinic_name,
          cl.from_email AS clinic_from_email,
          cl.from_name  AS clinic_from_name,
          cl.reply_to   AS clinic_reply_to
        FROM "order" o
        LEFT JOIN "customer" c       ON c.id = o.customer_id
        LEFT JOIN "order_address" oa ON oa.id = o.shipping_address_id
        LEFT JOIN "sales_channel" sc ON sc.id = o.sales_channel_id
        LEFT JOIN "clinic" cl        ON cl.id = ?
        WHERE o.id = ? LIMIT 1`,
        [clinicId, orderId]
      )

      if (orderResult.rows.length && orderResult.rows[0].email) {
        const row = orderResult.rows[0]
        const firstName = row.shipping_first_name || row.customer_first_name || ""
        const lastName = row.shipping_last_name || row.customer_last_name || ""
        const patientName = `${firstName} ${lastName}`.trim() || "Patient"

        const notificationService: INotificationModuleService =
          req.scope.resolve(Modules.NOTIFICATION)

        const template = decision === "approved" ? "order.status_update" : "order.md_denied"

        await notificationService.createNotifications({
          to: row.email,
          channel: "email",
          template,
          data: {
            patient_name: patientName,
            order_display_id: row.display_id,
            clinic_name: row.clinic_name,
            status: newStatus,
            md_notes: notes || null,
            from_email: row.clinic_from_email || undefined,
            from_name: row.clinic_from_name || undefined,
            reply_to: row.clinic_reply_to || undefined,
          },
        })
      }
    } catch (emailErr: any) {
      console.error("[MD Decision] Email notification error:", emailErr.message)
    }

    return res.json({ 
      success: true, 
      status: newStatus,
      message: decision === "approved" 
        ? "Order approved and sent to pharmacy" 
        : "Order denied and refund initiated"
    })
  } catch (err: any) {
    console.error("[MD Decision] Error:", err)
    return res.status(500).json({ message: err.message })
  }
}