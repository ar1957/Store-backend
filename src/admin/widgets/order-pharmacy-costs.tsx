/**
 * Order Pharmacy Costs Widget
 * Shows pharmacy cost per product in the order detail page.
 * Visible to all roles. Shows default costs and any pharmacist overrides.
 */
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { useState, useEffect } from "react"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { HttpTypes } from "@medusajs/types"

function OrderPharmacyCostsWidget({ data: order }: DetailWidgetProps<HttpTypes.AdminOrder>) {
  const [items, setItems] = useState<any[]>([])
  const [totalCost, setTotalCost] = useState<number>(0)
  const [clinicId, setClinicId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    init()
  }, [order.id])

  const init = async () => {
    try {
      // Find clinic for this order
      const clinicsRes = await fetch("/admin/clinics", { credentials: "include" })
      const clinicsData = await clinicsRes.json()
      const allClinics = clinicsData.clinics || []

      let foundClinicId: string | null = null
      for (const clinic of allClinics) {
        const ordersRes = await fetch(`/admin/clinics/${clinic.id}/orders`, { credentials: "include" })
        const ordersData = await ordersRes.json()
        const found = (ordersData.orders || []).find((o: any) => o.order_id === order.id)
        if (found) { foundClinicId = clinic.id; break }
      }

      if (!foundClinicId) { setLoading(false); return }
      setClinicId(foundClinicId)

      const costRes = await fetch(`/admin/clinics/${foundClinicId}/orders/${order.id}/pharmacy-cost`, { credentials: "include" })
      if (costRes.ok) {
        const data = await costRes.json()
        setItems(data.items || [])
        setTotalCost(data.total_cost || 0)
      }
    } catch {}
    setLoading(false)
  }

  if (loading || items.length === 0) return null

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 20, marginTop: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16, color: "#111" }}>💊 Pharmacy Costs</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map((item: any) => (
          <div key={item.line_item_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #f3f4f6" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: "#111" }}>{item.product_title}</div>
              <div style={{ fontSize: 11, color: "#6b7280" }}>Qty: {item.quantity} × ${item.actual_cost.toFixed(2)}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: item.is_overridden ? "#d97706" : "#374151" }}>
                ${(item.actual_cost * item.quantity).toFixed(2)}
              </div>
              {item.is_overridden && (
                <div style={{ fontSize: 10, color: "#d97706" }}>
                  Override (default: ${(item.default_cost * item.quantity).toFixed(2)})
                </div>
              )}
            </div>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 8, fontWeight: 700, fontSize: 14 }}>
          <span>Total Pharmacy Cost</span>
          <span style={{ color: "#1e40af" }}>${totalCost.toFixed(2)}</span>
        </div>
      </div>
    </div>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.side.before",
})

export default OrderPharmacyCostsWidget
