/**
 * POST /admin/clinics/:id/orders/:orderId/ship
 * File: src/api/admin/clinics/[id]/orders/[orderId]/ship/route.ts
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { INotificationModuleService } from "@medusajs/framework/types"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { orderId } = req.params
    const { tracking_number, carrier, pharmacist_user_id } = req.body as any

    if (!tracking_number) {
      return res.status(400).json({ message: "Tracking number is required" })
    }

    // Get workflow
    const wf = await pg.raw(
      `SELECT id FROM order_workflow WHERE order_id = ? LIMIT 1`,
      [orderId]
    )
    if (!wf.rows.length) {
      return res.status(404).json({ message: "Order workflow not found" })
    }

    await pg.raw(
      `UPDATE order_workflow 
       SET status = 'shipped', 
           tracking_number = ?, 
           carrier = ?,
           pharmacist_user_id = ?,
           shipped_at = NOW(),
           updated_at = NOW()
       WHERE id = ?`,
      [tracking_number, carrier || "UPS", pharmacist_user_id || null, wf.rows[0].id]
    )

    // ── Send shipped email to patient ────────────────────────────────────
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
          wf.treatment_dosages
        FROM "order" o
        LEFT JOIN "customer" c       ON c.id = o.customer_id
        LEFT JOIN "order_address" oa ON oa.id = o.shipping_address_id
        LEFT JOIN "sales_channel" sc ON sc.id = o.sales_channel_id
        LEFT JOIN "order_workflow" wf ON wf.order_id = o.id AND wf.deleted_at IS NULL
        WHERE o.id = ? LIMIT 1`,
        [orderId]
      )

      if (orderResult.rows.length && orderResult.rows[0].email) {
        const row = orderResult.rows[0]
        const firstName = row.shipping_first_name || row.customer_first_name || ""
        const lastName = row.shipping_last_name || row.customer_last_name || ""
        const patientName = `${firstName} ${lastName}`.trim() || "Patient"

        const notificationService: INotificationModuleService =
          req.scope.resolve(Modules.NOTIFICATION)

        await notificationService.createNotifications({
          to: row.email,
          channel: "email",
          template: "order.shipped",
          data: {
            patient_name: patientName,
            order_display_id: row.display_id,
            clinic_name: row.clinic_name,
            status: "shipped",
            tracking_number,
            carrier: carrier || "UPS",
          },
        })
      }
    } catch (emailErr: any) {
      console.error("[Ship] Email notification error:", emailErr.message)
    }

    return res.json({ 
      success: true,
      message: "Order marked as shipped"
    })
  } catch (err: any) {
    console.error("[Ship] Error:", err)
    return res.status(500).json({ message: err.message })
  }
}