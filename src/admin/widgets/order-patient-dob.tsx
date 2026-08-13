/**
 * Order Patient Date of Birth Widget
 * File: src/admin/widgets/order-patient-dob.tsx
 *
 * Displays patient birth date from eligibility data in the order detail page.
 * Appears in the Customer section, right after patient name/ID.
 */

import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { HttpTypes } from "@medusajs/types"

function OrderPatientDobWidget({ data: order }: DetailWidgetProps<HttpTypes.AdminOrder>) {
  // Extract birth date from order metadata
  const metadata = (order as any).metadata || {}
  const eligibility = metadata.eligibility || {}
  const dob = eligibility.dob

  // If no birth date, don't render anything
  if (!dob) {
    return null
  }

  // Format the date nicely (e.g., "September 9, 1990")
  // dateString is a plain "YYYY-MM-DD" date with no time/timezone component.
  // Parsing it directly via `new Date(dateString)` reads it as UTC midnight,
  // which toLocaleDateString then renders in the browser's local timezone —
  // shifting it back a day for any timezone behind UTC. Building the Date
  // from explicit local year/month/day components avoids that shift.
  const formatDate = (dateString: string): string => {
    try {
      const [year, month, day] = dateString.split("-").map(Number)
      const date = new Date(year, month - 1, day)
      return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    } catch {
      return dateString
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.label}>Date of Birth</div>
      <div style={styles.value}>{formatDate(dob)}</div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    padding: "12px 16px",
    marginBottom: 12,
  },
  label: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "#6b7280",
    marginBottom: 4,
  },
  value: {
    fontSize: 14,
    fontWeight: 500,
    color: "#111",
  },
}

export const config = defineWidgetConfig({
  zone: "order.details.before",
})

export default OrderPatientDobWidget
