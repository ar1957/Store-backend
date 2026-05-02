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
  const brand = data.brand_color || "#6d28d9"
  const items: any[] = data.line_items || []

  const e = React.createElement

  // Address block helper
  const AddressBlock = ({ addr, label }: { addr: any; label: string }) =>
    e("td", { style: { width: "50%", verticalAlign: "top", padding: "0 8px 0 0" } },
      e("h3", { style: { color: brand, fontSize: 14, fontWeight: 700, margin: "0 0 8px" } }, label),
      e("div", { style: { border: "1px solid #e5e7eb", borderRadius: 8, padding: "12px 14px", fontSize: 13, lineHeight: "1.6", color: "#374151", fontStyle: "italic" } },
        addr?.name && e("div", null, addr.name),
        addr?.address_1 && e("div", null, addr.address_1),
        addr?.address_2 && e("div", null, addr.address_2),
        (addr?.city || addr?.province || addr?.postal_code) && e("div", null,
          [addr.city, addr.province, addr.postal_code].filter(Boolean).join(", ")
        ),
        addr?.country_code && e("div", null, `${addr.country_code === "US" ? "United States (US)" : addr.country_code}`),
        addr?.phone && e("a", { href: `tel:${addr.phone}`, style: { color: brand, display: "block" } }, addr.phone),
        addr?.email && e("a", { href: `mailto:${addr.email}`, style: { color: brand, display: "block" } }, addr.email),
      )
    )

  return e("div", { style: { fontFamily: "Arial, sans-serif", maxWidth: 600, margin: "0 auto", background: "#fff" } },
    // Header
    e("div", { style: { background: brand, padding: "32px 40px" } },
      e("h1", { style: { color: "#fff", fontSize: 28, fontWeight: 700, margin: 0 } }, "Thank you for your order")
    ),

    // Body
    e("div", { style: { padding: "28px 40px" } },
      e("p", { style: { margin: "0 0 8px", fontSize: 14, color: "#374151" } }, `Hi ${(data.patient_name || "there").split(" ")[0]},`),
      e("p", { style: { margin: "0 0 20px", fontSize: 14, color: "#374151" } },
        `Just to let you know — we've received your order #${data.order_display_id}, and it is now being processed:`
      ),

      // Order heading link
      e("a", { href: data.track_order_url || "#", style: { color: brand, fontSize: 15, fontWeight: 700, textDecoration: "none", display: "block", marginBottom: 16 } },
        `[Order #${data.order_display_id}]${data.order_date ? ` (${data.order_date})` : ""}`
      ),

      // Items table
      e("table", { style: { width: "100%", borderCollapse: "collapse", marginBottom: 0, fontSize: 13 } },
        e("thead", null,
          e("tr", { style: { borderBottom: "1px solid #e5e7eb" } },
            e("th", { style: { textAlign: "left", padding: "8px 12px", fontWeight: 700, color: "#111" } }, "Product"),
            e("th", { style: { textAlign: "center", padding: "8px 12px", fontWeight: 700, color: "#111" } }, "Quantity"),
            e("th", { style: { textAlign: "right", padding: "8px 12px", fontWeight: 700, color: "#111" } }, "Price"),
          )
        ),
        e("tbody", null,
          ...items.map((item: any, i: number) =>
            e("tr", { key: i, style: { borderBottom: "1px solid #f3f4f6" } },
              e("td", { style: { padding: "10px 12px", color: "#374151", verticalAlign: "top" } },
                e("div", null, item.title),
                ...(item.notes || []).map((n: string, j: number) =>
                  e("div", { key: j, style: { fontSize: 12, color: "#6b7280", marginTop: 4 } },
                    e("strong", null, n.split(":")[0] + ":"),
                    " " + n.split(":").slice(1).join(":").trim()
                  )
                )
              ),
              e("td", { style: { padding: "10px 12px", textAlign: "center", color: "#374151" } }, item.quantity),
              e("td", { style: { padding: "10px 12px", textAlign: "right", color: "#374151" } }, item.unit_price),
            )
          ),
          // Subtotal
          e("tr", { style: { borderTop: "1px solid #e5e7eb" } },
            e("td", { colSpan: 2, style: { padding: "8px 12px", fontWeight: 700, color: "#111" } }, "Subtotal:"),
            e("td", { style: { padding: "8px 12px", textAlign: "right", color: "#374151" } }, data.subtotal || ""),
          ),
          // Discount (only if present) — shows promo code and amount in green
          ...(data.discount ? [e("tr", { style: { borderTop: "1px solid #f3f4f6" } },
            e("td", { colSpan: 2, style: { padding: "8px 12px", fontWeight: 700, color: "#111" } },
              data.discount_codes ? `Discount (${data.discount_codes}):` : "Discount:"
            ),
            e("td", { style: { padding: "8px 12px", textAlign: "right", color: "#10b981", fontWeight: 600 } }, data.discount),
          )] : []),
          // Shipping
          e("tr", { style: { borderTop: "1px solid #f3f4f6" } },
            e("td", { colSpan: 2, style: { padding: "8px 12px", fontWeight: 700, color: "#111" } }, "Shipping:"),
            e("td", { style: { padding: "8px 12px", textAlign: "right", color: "#374151" } }, data.shipping || ""),
          ),
          // Total
          e("tr", { style: { borderTop: "1px solid #e5e7eb" } },
            e("td", { colSpan: 2, style: { padding: "8px 12px", fontWeight: 700, color: "#111" } }, "Total:"),
            e("td", { style: { padding: "8px 12px", textAlign: "right", fontWeight: 700, color: "#111" } }, data.total || ""),
          ),
        )
      ),

      // Addresses
      e("table", { style: { width: "100%", marginTop: 28, borderCollapse: "collapse" } },
        e("tbody", null,
          e("tr", null,
            e(AddressBlock, { addr: data.billing_address, label: "Billing address" }),
            e(AddressBlock, { addr: data.shipping_address, label: "Shipping address" }),
          )
        )
      ),

      // Track order link
      e("p", { style: { marginTop: 28, fontSize: 14, color: "#374151" } },
        "Please click on this to see your ",
        e("a", { href: data.track_order_url || "#", style: { color: brand } }, "Track Order"),
      ),

      e("p", { style: { fontSize: 14, color: "#374151", marginTop: 8 } }, "Thank you for your business."),
    ),

    // Footer with logo
    e("div", { style: { borderTop: "1px solid #f3f4f6", padding: "20px 40px", textAlign: "center" } },
      data.logo_url && e("img", { src: data.logo_url, alt: data.clinic_name || "Clinic", style: { maxHeight: 48, maxWidth: 160, objectFit: "contain", marginBottom: 8 } }),
      e("p", { style: { fontSize: 12, color: "#9ca3af", margin: 0 } },
        data.clinic_name ? `© ${new Date().getFullYear()} ${data.clinic_name}. All rights reserved.` : ""
      ),
    ),
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

function RefundEmail({ data }: { data: any }) {
  const brand = data.brand_color || "#6d28d9"
  const e = React.createElement
  return e("div", { style: { fontFamily: "Arial, sans-serif", maxWidth: 600, margin: "0 auto", background: "#fff" } },
    // Header
    e("div", { style: { background: brand, padding: "32px 40px" } },
      e("h1", { style: { color: "#fff", fontSize: 28, fontWeight: 700, margin: 0 } }, "Your Refund Has Been Processed")
    ),
    // Body
    e("div", { style: { padding: "28px 40px" } },
      e("p", { style: { fontSize: 14, color: "#374151", margin: "0 0 12px" } },
        `Hi ${(data.patient_name || "there").split(" ")[0]},`
      ),
      e("p", { style: { fontSize: 14, color: "#374151", margin: "0 0 20px" } },
        `We've successfully processed a refund for your order #${data.order_display_id}.`
      ),
      e("div", { style: { background: "#F9FAFB", border: "1px solid #e5e7eb", borderRadius: 8, padding: "16px 20px", margin: "0 0 20px" } },
        e("p", { style: { margin: "0 0 6px", fontSize: 13, fontWeight: 700, color: "#111" } }, "Reason:"),
        e("p", { style: { margin: 0, fontSize: 13, color: "#374151" } }, data.refund_reason || "")
      ),
      e("p", { style: { fontSize: 14, color: "#374151", margin: "0 0 8px" } },
        "Please allow 5–10 business days for the refund to appear on your original payment method."
      ),
      e("p", { style: { fontSize: 14, color: "#374151", margin: 0 } },
        "If you have any questions, please don't hesitate to reach out to your clinic."
      ),
    ),
    // Footer
    e("div", { style: { borderTop: "1px solid #f3f4f6", padding: "20px 40px", textAlign: "center" } },
      data.logo_url && e("img", { src: data.logo_url, alt: data.clinic_name || "Clinic", style: { maxHeight: 48, maxWidth: 160, objectFit: "contain", marginBottom: 8 } }),
      e("p", { style: { fontSize: 12, color: "#9ca3af", margin: 0 } },
        data.clinic_name ? `© ${new Date().getFullYear()} ${data.clinic_name}. All rights reserved.` : ""
      ),
    ),
  )
}

function PendingProviderReminderEmail({ data }: { data: any }) {
  const e = React.createElement
  const brand = data.brand_color || "#6d28d9"
  const daysPending = data.days_pending || 0
  const urgency = daysPending >= 3 ? "We noticed you haven't connected with a provider yet." : "Your consultation is ready and waiting."

  return e("div", { style: { fontFamily: "sans-serif", maxWidth: 600, margin: "0 auto", background: "#fff" } },
    e("div", { style: { background: brand, padding: "28px 40px" } },
      data.logo_url
        ? e("img", { src: data.logo_url, alt: data.clinic_name || "Clinic", style: { maxHeight: 48, maxWidth: 160, objectFit: "contain" } })
        : e("h2", { style: { color: "#fff", margin: 0, fontSize: 20 } }, data.clinic_name || "Your Clinic"),
    ),
    e("div", { style: { padding: "32px 40px" } },
      e("h1", { style: { fontSize: 22, fontWeight: 700, color: "#111", margin: "0 0 16px" } },
        "Don't forget — your provider is waiting"
      ),
      e("p", { style: { fontSize: 15, color: "#374151", lineHeight: "1.6", margin: "0 0 16px" } },
        `Hi ${data.patient_name || "there"},`
      ),
      e("p", { style: { fontSize: 15, color: "#374151", lineHeight: "1.6", margin: "0 0 16px" } },
        `${urgency} Your order #${data.order_display_id} is pending a provider consultation.`
      ),
      e("p", { style: { fontSize: 15, color: "#374151", lineHeight: "1.6", margin: "0 0 24px" } },
        "Click below to track your order and connect with a provider to complete your consultation."
      ),
      e("a", {
        href: data.track_order_url || "#",
        style: {
          display: "inline-block", padding: "14px 28px",
          background: brand, color: "#fff", borderRadius: 8,
          fontWeight: 700, fontSize: 15, textDecoration: "none",
        }
      }, "Track My Order →"),
      data.virtual_room_url && e("p", { style: { fontSize: 13, color: "#6b7280", marginTop: 20 } },
        "Or join your virtual visit directly: ",
        e("a", { href: data.virtual_room_url, style: { color: brand } }, "Join Virtual Visit"),
      ),
      e("p", { style: { fontSize: 13, color: "#9ca3af", marginTop: 32, borderTop: "1px solid #f3f4f6", paddingTop: 16 } },
        "If you have questions, please contact us. This is an automated reminder."
      ),
    ),
    e("div", { style: { borderTop: "1px solid #f3f4f6", padding: "20px 40px", textAlign: "center" } },
      e("p", { style: { fontSize: 12, color: "#9ca3af", margin: 0 } },
        data.clinic_name ? `© ${new Date().getFullYear()} ${data.clinic_name}. All rights reserved.` : ""
      ),
    ),
  )
}

function InviteEmail({ data }: { data: any }) {
  const e = React.createElement
  const brand = "#111827"
  // Subscriber passes invite_url in data
  const inviteUrl = data.invite_url || data.url || "#"
  return e("div", { style: { fontFamily: "Arial, sans-serif", maxWidth: 600, margin: "0 auto", background: "#fff" } },
    e("div", { style: { background: brand, padding: "32px 40px" } },
      e("h1", { style: { color: "#fff", fontSize: 24, fontWeight: 700, margin: 0 } }, "You've Been Invited")
    ),
    e("div", { style: { padding: "28px 40px" } },
      e("p", { style: { fontSize: 14, color: "#374151", margin: "0 0 16px" } },
        "You have been invited to join the admin panel. Click the button below to accept your invitation and set up your account."
      ),
      e("a", {
        href: inviteUrl,
        style: {
          display: "inline-block", padding: "12px 28px",
          background: brand, color: "#fff", borderRadius: 8,
          fontWeight: 700, fontSize: 14, textDecoration: "none", margin: "8px 0 20px",
        }
      }, "Accept Invitation →"),
      e("p", { style: { fontSize: 13, color: "#6b7280", margin: "0 0 8px" } },
        "Or copy and paste this URL into your browser: ", inviteUrl
      ),
      e("p", { style: { fontSize: 13, color: "#6b7280", margin: "0 0 8px" } },
        "If you didn't expect this invitation, you can safely ignore this email."
      ),
      e("p", { style: { fontSize: 13, color: "#6b7280", margin: 0 } },
        "This invitation link will expire in 24 hours."
      ),
    ),
  )
}

function PasswordResetEmail({ data }: { data: any }) {
  const e = React.createElement
  const brand = "#111827"
  // Subscriber passes reset_url in data
  const resetUrl = data.reset_url || data.url || "#"
  return e("div", { style: { fontFamily: "Arial, sans-serif", maxWidth: 600, margin: "0 auto", background: "#fff" } },
    e("div", { style: { background: brand, padding: "32px 40px" } },
      e("h1", { style: { color: "#fff", fontSize: 24, fontWeight: 700, margin: 0 } }, "Reset Your Password")
    ),
    e("div", { style: { padding: "28px 40px" } },
      e("p", { style: { fontSize: 14, color: "#374151", margin: "0 0 16px" } },
        "You requested a password reset for your admin account. Click the button below to set a new password."
      ),
      e("a", {
        href: resetUrl,
        style: {
          display: "inline-block", padding: "12px 28px",
          background: brand, color: "#fff", borderRadius: 8,
          fontWeight: 700, fontSize: 14, textDecoration: "none", margin: "8px 0 20px",
        }
      }, "Reset Password →"),
      e("p", { style: { fontSize: 13, color: "#6b7280", margin: "0 0 8px" } },
        "Or copy and paste this URL into your browser: ", resetUrl
      ),
      e("p", { style: { fontSize: 13, color: "#6b7280", margin: "0 0 8px" } },
        "If you didn't request this, you can safely ignore this email."
      ),
      e("p", { style: { fontSize: 13, color: "#6b7280", margin: 0 } },
        "This link will expire in 24 hours."
      ),
    ),
  )
}

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
  "order.refund_issued": {
    subject: "Your Refund Has Been Processed",
    component: RefundEmail,
  },
  "order.pending_provider_reminder": {
    subject: "Action Required: Complete Your Provider Consultation",
    component: PendingProviderReminderEmail,
  },
  "auth.password_reset": {
    subject: "Reset Your Admin Password",
    component: PasswordResetEmail,
  },
  "auth.invite": {
    subject: "You've Been Invited to the Admin Panel",
    component: InviteEmail,
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

    this.logger.info(`[Resend] send() called — template: ${template}, to: ${to}, data keys: ${Object.keys(data || {}).join(", ")}`)

    let subject: string
    let html: string

    if (content?.subject && content?.html) {
      subject = content.subject
      html = content.html
    } else {
      const tmpl = TEMPLATES[template]
      if (!tmpl) {
        this.logger.warn(`[Resend] Unknown template: ${template}`)
        return { id: "skipped" }
      }
      subject = data?.subject || tmpl.subject
      html = await render(React.createElement(tmpl.component, { data: data || {} }))
    }

    // Use per-clinic from/reply-to if provided in data, fall back to global config
    const fromName = data?.from_name || null
    const fromEmail = data?.from_email || this.options.from
    const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail
    const replyTo = data?.reply_to || undefined

    try {
      const result = await this.resendClient.emails.send({
        from,
        to,
        subject,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      })
      this.logger.info(`[Resend] Email sent to ${to} — template: ${template} — from: ${from}`)
      return result
    } catch (err: any) {
      this.logger.error(`[Resend] Failed to send email to ${to}: ${err.message}`)
      throw err
    }
  }
}

export default ResendNotificationProviderService
