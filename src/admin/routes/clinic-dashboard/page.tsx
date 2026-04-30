"use client"
import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { defineRouteConfig } from "@medusajs/admin-sdk"
import { ChartBar } from "@medusajs/icons"

export const config = defineRouteConfig({
  label: "Clinic Dashboard",
  icon: ChartBar,
})

interface StatusRow  { status: string; count: number; total: number }
interface ProductRow { product: string; count: number; total: number }
interface Summary    { total_orders: number; total_revenue: number }
interface Clinic     { id: string; name: string }

const STATUS_COLORS: Record<string, string> = {
  pending_provider:    "#f59e0b",
  pending_md_review:   "#8b5cf6",
  provider_deferred:   "#a78bfa",
  processing_pharmacy: "#3b82f6",
  shipped:             "#10b981",
  md_denied:           "#ef4444",
  refund_issued:       "#6b7280",
  refunded:            "#9ca3af",
}

const STATUS_LABELS: Record<string, string> = {
  pending_provider:    "Pending Provider",
  pending_md_review:   "Pending MD Review",
  provider_deferred:   "Provider Deferred",
  processing_pharmacy: "At Pharmacy",
  shipped:             "Shipped",
  md_denied:           "MD Denied",
  refund_issued:       "Refund Issued",
  refunded:            "Refunded",
}

const PALETTE = ["#6366f1","#f59e0b","#10b981","#3b82f6","#ef4444","#8b5cf6","#ec4899","#14b8a6","#f97316","#84cc16"]

// ─── SVG Pie Chart ────────────────────────────────────────────────────────────

function PieChart({ slices, size = 200, onSliceClick, centerTotal }: {
  slices: { label: string; value: number; color: string; key?: string }[]
  size?: number
  onSliceClick?: (key: string) => void
  centerTotal?: number
}) {
  const [hovered, setHovered] = useState<number | null>(null)
  const total = centerTotal ?? slices.reduce((s, x) => s + x.value, 0)
  if (total === 0) return <div style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: 40 }}>No data</div>

  const r = size / 2 - 10
  const cx = size / 2
  const cy = size / 2
  let angle = -Math.PI / 2

  const paths = slices.map((slice, i) => {
    const pct = slice.value / total
    const sweep = pct * 2 * Math.PI
    const x1 = cx + r * Math.cos(angle)
    const y1 = cy + r * Math.sin(angle)
    angle += sweep
    const x2 = cx + r * Math.cos(angle)
    const y2 = cy + r * Math.sin(angle)
    const large = sweep > Math.PI ? 1 : 0
    const midAngle = angle - sweep / 2
    const scale = hovered === i ? 1.06 : 1
    return { ...slice, d: `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} Z`, pct, midAngle, scale, i }
  })

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: "visible" }}>
      {paths.map((p) => (
        <g key={p.i}
          style={{ cursor: onSliceClick && p.key ? "pointer" : "default", transformOrigin: `${cx}px ${cy}px`, transform: `scale(${p.scale})`, transition: "transform 0.15s" }}
          onClick={() => onSliceClick && p.key && onSliceClick(p.key)}
          onMouseEnter={() => setHovered(p.i)}
          onMouseLeave={() => setHovered(null)}
        >
          <path d={p.d} fill={p.color} stroke="#fff" strokeWidth={2}>
            <title>{p.label}: {p.value} ({(p.pct * 100).toFixed(1)}%)</title>
          </path>
        </g>
      ))}
      <circle cx={cx} cy={cy} r={r * 0.45} fill="#fff" />
      <text x={cx} y={cy - 6} textAnchor="middle" fontSize={13} fontWeight={700} fill="#111">{total}</text>
      <text x={cx} y={cy + 12} textAnchor="middle" fontSize={10} fill="#6b7280">orders</text>
    </svg>
  )
}

function Legend({ items, onItemClick }: {
  items: { label: string; color: string; count: number; total: number; key?: string }[]
  onItemClick?: (key: string) => void
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 180 }}>
      {items.map((item, i) => (
        <div key={i}
          onClick={() => onItemClick && item.key && onItemClick(item.key)}
          style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, cursor: onItemClick && item.key ? "pointer" : "default", borderRadius: 6, padding: "2px 4px", transition: "background 0.1s" }}
          onMouseEnter={e => { if (onItemClick && item.key) (e.currentTarget as HTMLElement).style.background = "#f3f4f6" }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent" }}
        >
          <div style={{ width: 12, height: 12, borderRadius: 3, background: item.color, flexShrink: 0 }} />
          <span style={{ flex: 1, color: "#374151" }}>{item.label}</span>
          <span style={{ fontWeight: 600, color: "#111" }}>{item.count}</span>
          <span style={{ color: "#6b7280", minWidth: 70, textAlign: "right" }}>${Number(item.total).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ClinicDashboardPage() {
  const navigate = useNavigate()
  const [byStatus, setByStatus]   = useState<StatusRow[]>([])
  const [byProduct, setByProduct] = useState<ProductRow[]>([])
  const [summary, setSummary]     = useState<Summary | null>(null)
  const [clinics, setClinics]     = useState<Clinic[]>([])
  const [isSuperAdmin, setIsSuperAdmin] = useState(false)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState("")

  const today = new Date().toISOString().split("T")[0]
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0]
  const [dateFrom, setDateFrom] = useState(thirtyDaysAgo)
  const [dateTo, setDateTo]     = useState(today)
  const [clinicId, setClinicId] = useState("")

  const load = async () => {
    setLoading(true); setError("")
    try {
      const params = new URLSearchParams()
      if (clinicId) params.set("clinicId", clinicId)
      if (dateFrom) params.set("dateFrom", dateFrom)
      if (dateTo)   params.set("dateTo", dateTo)

      const res = await fetch(`/admin/dashboard?${params}`, { credentials: "include" })
      if (!res.ok) throw new Error("Failed to load dashboard data")
      const data = await res.json()
      setByStatus(data.byStatus || [])
      setByProduct(data.byProduct || [])
      setSummary(data.summary || null)
      if (data.clinics?.length) setClinics(data.clinics)
      setIsSuperAdmin(data.role === "super_admin")
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [clinicId, dateFrom, dateTo])

  // Drill down: navigate to clinic-orders with status filter
  const drillToStatus = (status: string) => {
    navigate(`/clinic-orders?status=${status}`)
  }

  const statusSlices = byStatus.map(r => ({
    label: STATUS_LABELS[r.status] || r.status,
    value: r.count,
    color: STATUS_COLORS[r.status] || "#e5e7eb",
    key: r.status,
  }))

  const productSlices = byProduct.map((r, i) => ({
    label: r.product.replace(/^E-Commerce Online Order:\s*/i, "").replace(/\s*-\s*\d+\s*month.*/i, "").trim(),
    value: r.count,
    color: PALETTE[i % PALETTE.length],
  }))

  return (
    <div style={{ padding: "28px 32px", maxWidth: 1100, margin: "0 auto" }}>

      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: "#111", margin: "0 0 4px" }}>Clinic Dashboard</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>Order analytics — click a status slice to drill into orders</p>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 12, marginBottom: 28, flexWrap: "wrap", alignItems: "flex-end" }}>
        {clinics.length > 0 && (
          <div>
            <label style={s.label}>Clinic</label>
            <select style={s.select} value={clinicId} onChange={e => setClinicId(e.target.value)}>
              <option value="">All Clinics</option>
              {clinics.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label style={s.label}>From</label>
          <input type="date" style={s.select} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        </div>
        <div>
          <label style={s.label}>To</label>
          <input type="date" style={s.select} value={dateTo} onChange={e => setDateTo(e.target.value)} />
        </div>
        <button onClick={load} style={s.btn}>Refresh</button>
      </div>

      {error && <div style={{ color: "#dc2626", marginBottom: 16, fontSize: 13 }}>⚠️ {error}</div>}

      {/* Summary cards */}
      {summary && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 28 }}>
          <div style={s.card}>
            <div style={s.cardLabel}>Total Orders</div>
            <div style={s.cardValue}>{summary.total_orders.toLocaleString()}</div>
          </div>
          <div style={s.card}>
            <div style={s.cardLabel}>Total Revenue</div>
            <div style={s.cardValue}>${Number(summary.total_revenue).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          </div>
          <div style={s.card}>
            <div style={s.cardLabel}>Avg Order Value</div>
            <div style={s.cardValue}>
              ${summary.total_orders > 0
                ? (Number(summary.total_revenue) / summary.total_orders).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : "0.00"}
            </div>
          </div>
          <div style={s.card}>
            <div style={s.cardLabel}>Shipped</div>
            <div style={{ ...s.cardValue, color: "#10b981" }}>
              {byStatus.find(r => r.status === "shipped")?.count || 0}
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: 60, color: "#9ca3af" }}>Loading…</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>

          {/* Orders by Status — clickable */}
          <div style={s.chartCard}>
            <div style={s.chartTitle}>
              Orders by Status
              <span style={{ fontSize: 11, fontWeight: 400, color: "#9ca3af", marginLeft: 8 }}>click to drill down</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
              <PieChart slices={statusSlices} size={180} onSliceClick={drillToStatus} />
              <Legend
                items={byStatus.map(r => ({
                  label: STATUS_LABELS[r.status] || r.status,
                  color: STATUS_COLORS[r.status] || "#e5e7eb",
                  count: r.count,
                  total: Number(r.total),
                  key: r.status,
                }))}
                onItemClick={drillToStatus}
              />
            </div>
          </div>

          {/* Orders by Product */}
          <div style={s.chartCard}>
            <div style={s.chartTitle}>Orders by Product <span style={{ fontSize: 11, fontWeight: 400, color: "#9ca3af" }}>(orders may contain multiple products)</span></div>
            <div style={{ display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
              <PieChart slices={productSlices} size={180} centerTotal={summary?.total_orders} />
              <Legend items={byProduct.map((r, i) => ({
                label: r.product.replace(/^E-Commerce Online Order:\s*/i, "").replace(/\s*-\s*\d+\s*month.*/i, "").trim(),
                color: PALETTE[i % PALETTE.length],
                count: r.count,
                total: Number(r.total),
              }))} />
            </div>
          </div>

        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  label:      { display: "block", fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 },
  select:     { padding: "8px 12px", border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 13, color: "#111", background: "#fff", minWidth: 160 },
  btn:        { padding: "8px 16px", background: "#111", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", alignSelf: "flex-end" },
  card:       { background: "#fff", borderRadius: 12, padding: "16px 20px", boxShadow: "0 1px 4px rgba(0,0,0,0.06)", border: "1px solid #f3f4f6" },
  cardLabel:  { fontSize: 11, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 },
  cardValue:  { fontSize: 26, fontWeight: 800, color: "#111" },
  chartCard:  { background: "#fff", borderRadius: 14, padding: "20px 24px", boxShadow: "0 1px 4px rgba(0,0,0,0.06)", border: "1px solid #f3f4f6" },
  chartTitle: { fontSize: 14, fontWeight: 700, color: "#111", marginBottom: 20 },
}
