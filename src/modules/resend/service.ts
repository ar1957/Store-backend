/**
 * File: src/modules/resend-notification/service.ts
 * Custom Resend notification provider for Medusa v2
 */
import {
  AbstractNotificationProviderService,
  MedusaError,
} from "@medusajs/framework/utils"
import { Logger } from "@medusajs/framework/types"
import { Resend } from "resend"
import { render } from "@react-email/render"
import * as React from "react"

// ── Email Templates ────────────────────────────────────────────────────────

function OrderConfirmationEmail({ data }: { data: any }) {
  return React.createElement("div", { style: { fontFamily: "Arial, sans-serif", maxWidth: "600px", margin: "0 auto" } },
    React.createElement("h1", { style: { color: "#111827" } }, "Order Confirmed"),
    React.createElement("p", null, `Hi ${data.patient_name || "there"},`),
    React.createElement("p", null, `Thank you for your order! Your order #${data.order_display_id} has been received and is being reviewed.`),
    React.createElement("div", { style: { background: "#F9FAFB", padding: "16px", borderRadius: "8px", margin: "16px 0" } },
      React.createElement("p", { style: { margin: 0, fontWeight: "bold" } }, `Order #${data.order_display_id}`),
      data.medication && React.createElement("p", { style: { margin: "8px 0 0" } }, `Medication: ${data.medication}`),
      React.createElement("p", { style: { margin: "8px 0 0" } }, `Total: ${data.total}`)
    ),
    React.createElement("p", null, "We will notify you as your order progresses through our review process."),
    React.createElement("p", null, `Clinic: ${data.clinic_name || ""}`),
    React.createElement("p", { style: { color: "#6B7280", fontSize: "12px" } }, "If you have any questions, please contact your clinic.")
  )
}

function OrderStatusEmail({ data }: { data: any }) {
  const statusMessages: Record<string, string> = {
    pending_provider: "Your order is awaiting provider review.",
    pending_md_review: "Your order is being reviewed by our medical director.",
    provider_deferred: "Your order is being reviewed by our medical director.",
    processing_pharmacy: "Your order has been approved and is being processed by our pharmacy.",
    shipped: `Your order has been shipped! Tracking: ${data.tracking_number || ""}${data.carrier ? ` (${data.carrier})` : ""}`,
    md_denied: "Unfortunately your order has been declined. A refund will be issued.",
    refund_issued: "Your refund has been processed.",
  }

  const message = statusMessages[data.status] || `Your order status has been updated to: ${data.status}`

  return React.createElement("div", { style: { fontFamily: "Arial, sans-serif", maxWidth: "600px", margin: "0 auto" } },
    React.createElement("h1", { style: { color: "#111827" } }, "Order Update"),
    React.createElement("p", null, `Hi ${data.patient_name || "there"},`),
    React.createElement("p", null, `We have an update on your order #${data.order_display_id}:`),
    React.createElement("div", { style: { background: "#F9FAFB", padding: "16px", borderRadius: "8px", margin: "16px 0" } },
      React.createElement("p", { style: { margin: 0 } }, message)
    ),
    data.md_notes && React.createElement("p", null, `Note from your physician: ${data.md_notes}`),
    React.createElement("p", { style: { color: "#6B7280", fontSize: "12px" } }, "If you have any questions, please contact your clinic.")
  )
}

function ShippedEmail({ data }: { data: any }) {
  return React.createElement("div", { style: { fontFamily: "Arial, sans-serif", maxWidth: "600px", margin: "0 auto" } },
    React.createElement("h1", { style: { color: "#111827" } }, "Your Order Has Shipped!"),
    React.createElement("p", null, `Hi ${data.patient_name || "there"},`),
    React.createElement("p", null, `Great news! Your order #${data.order_display_id} is on its way.`),
    React.createElement("div", { style: { background: "#F9FAFB", padding: "16px", borderRadius: "8px", margin: "16px 0" } },
      data.carrier && React.createElement("p", { style: { margin: "0 0 8px" } }, `Carrier: ${data.carrier}`),
      data.tracking_number && React.createElement("p", { style: { margin: 0, fontWeight: "bold" } }, `Tracking #: ${data.tracking_number}`)
    ),
    React.createElement("p", null, "Please allow 2-5 business days for delivery."),
    React.createElement("p", { style: { color: "#6B7280", fontSize: "12px" } }, "If you have any questions, please contact your clinic.")
  )
}

// ── Template map ───────────────────────────────────────────────────────────

const TEMPLATES: Record<string, { subject: string; component: (props: { data: any }) => any }> = {
  "order.confirmation": {
    subject: "Your Order Has Been Received",
    component: OrderConfirmationEmail,
  },
  "order.status_update": {
    subject: "Update on Your Order",
    component: OrderStatusEmail,
  },
  "order.shipped": {
    subject: "Your Order Has Shipped",
    component: ShippedEmail,
  },
  "order.md_denied": {
    subject: "Update on Your Order",
    component: OrderStatusEmail,
  },
}

// ── Service ────────────────────────────────────────────────────────────────

type ResendOptions = {
  api_key: string
  from: string
}

type InjectedDependencies = {
  logger: Logger
}

class ResendNotificationProviderService extends AbstractNotificationProviderService {
  static identifier = "notification-resend"

  private resendClient: Resend
  private options: ResendOptions
  private logger: Logger

  constructor({ logger }: InjectedDependencies, options: ResendOptions) {
    super()
    this.resendClient = new Resend(options.api_key)
    this.options = options
    this.logger = logger
  }

  static validateOptions(options: Record<string, any>) {
    if (!options.api_key) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Option `api_key` is required for the Resend notification provider."
      )
    }
    if (!options.from) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Option `from` is required for the Resend notification provider."
      )
    }
  }

  async send(notification: any): Promise<any> {
    const { to, template, data, content } = notification

    let subject: string
    let html: string

    if (content?.subject && content?.html) {
      // Raw HTML content passed directly
      subject = content.subject
      html = content.html
    } else {
      // Use template
      const tmpl = TEMPLATES[template]
      if (!tmpl) {
        this.logger.warn(`[Resend] Unknown template: ${template}`)
        return { id: "skipped" }
      }
      subject = data?.subject || tmpl.subject
      html = await render(React.createElement(tmpl.component, { data: data || {} }))
    }

    try {
      const result = await this.resendClient.emails.send({
        from: this.options.from,
        to,
        subject,
        html,
      })
      this.logger.info(`[Resend] Email sent to ${to} — template: ${template}`)
      return result
    } catch (err: any) {
      this.logger.error(`[Resend] Failed to send email to ${to}: ${err.message}`)
      throw err
    }
  }
}

export default ResendNotificationProviderService