/**
 * POST /admin/clinics/:id/orders/:orderId/update-tracking
 * Updates tracking number + carrier on an already-shipped order
 * and sends a correction email to the patient.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { INotificationModuleService } from "@medusajs/framework/types"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id: clinicId, orderId } = req.params
    const { tracking_number, carrier } = req.body as any

    if (!tracking_number?.trim()) {
      return res.status(400).json({ message: "Tracking number is required" })
    }

    // Only allow update on shipped orders
    const wf = await pg.raw(
      `SELECT id, status FROM order_workflow WHERE order_id = ? AND deleted_at IS NULL LIMIT 1`,
      [orderId]
    )
    if (!wf.rows.length) {
      return res.status(404).json({ message: "Order workflow not found" })
    }
    if (wf.rows[0].status !== "shipped") {
      return res.status(400).json({ message: "Tracking can only be updated on shipped orders" })
    }

    await pg.raw(
      `UPDATE order_workflow
       SET tracking_number = ?, carrier = ?, updated_at = NOW()
       WHERE id = ?`,
      [tracking_number.trim(), carrier || "UPS", wf.rows[0].id]
    )

    // Send correction email to patient
    try {
      const orderResult = await pg.raw(
        `SELECT
          o.display_id,
          o.email,
          c.first_name  AS customer_first_name,
          c.last_name   AS customer_last_name,
          oa.first_name AS shipping_first_name,
          oa.last_name  AS shipping_last_name,
          sc.name       AS clinic_name,
          cl.from_email AS clinic_from_email,
          cl.from_name  AS clinic_from_name,
          cl.reply_to   AS clinic_reply_to
        FROM "order" o
        LEFT JOIN "customer" c       ON c.id  = o.customer_id
        LEFT JOIN "order_address" oa ON oa.id = o.shipping_address_id
        LEFT JOIN "sales_channel" sc ON sc.id = o.sales_channel_id
        LEFT JOIN "clinic" cl        ON cl.id = ?
        WHERE o.id = ? LIMIT 1`,
        [clinicId, orderId]
      )

      if (orderResult.rows.length && orderResult.rows[0].email) {
        const row = orderResult.rows[0]
        const firstName = row.shipping_first_name || row.customer_first_name || ""
        const lastName  = row.shipping_last_name  || row.customer_last_name  || ""
        const patientName = `${firstName} ${lastName}`.trim() || "Patient"

        const notificationService: INotificationModuleService =
          req.scope.resolve(Modules.NOTIFICATION)

        await notificationService.createNotifications({
          to: row.email,
          channel: "email",
          template: "order.shipped",
          data: {
            patient_name:     patientName,
            order_display_id: row.display_id,
            clinic_name:      row.clinic_name,
            status:           "shipped",
            tracking_number:  tracking_number.trim(),
            carrier:          carrier || "UPS",
            is_correction:    true,
            from_email:       row.clinic_from_email || undefined,
            from_name:        row.clinic_from_name  || undefined,
            reply_to:         row.clinic_reply_to   || undefined,
          },
        })
      }
    } catch (emailErr: any) {
      console.error("[UpdateTracking] Email error:", emailErr.message)
    }

    return res.json({ success: true, message: "Tracking number updated" })
  } catch (err: any) {
    console.error("[UpdateTracking] Error:", err)
    return res.status(500).json({ message: err.message })
  }
}
