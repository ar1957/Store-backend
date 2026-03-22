import { useEffect, useState, useCallback } from "react"
import { useNavigate } from "react-router-dom"
import { defineRouteConfig } from "@medusajs/admin-sdk"
import { ShoppingCart } from "@medusajs/icons"

export const config = defineRouteConfig({
  label: "Clinic Orders",
  icon: ShoppingCart,
})

// ─── Types ────────────────────────────────────────────────────────────────────

type WorkflowStatus =
  | "pending_provider"
  | "pending_md_review"
  | "provider_deferred"
  | "processing_pharmacy"
  | "shipped"
  | "md_denied"
  | "refund_issued"

interface TreatmentDosage {
  dosage: string
  treatmentId: number
  treatmentName: string
}

interface OrderWorkflow {
  id: string
  order_id: string
  status: WorkflowStatus | null
  provider_status: string | null
  treatment_dosages: string | null   // JSON string from DB
  shipped_at: string | null
  tracking_number: string | null
  carrier: string | null
}

interface ClinicOrder {
  id: string
  display_id: number
  created_at: string
  customer: {
    first_name: string
    last_name: string
    email: string
  } | null
  shipping_address: {
    province: string | null
    first_name: string | null
    last_name: string | null
  } | null
  sales_channel: {
    name: string
  } | null
  total: number
  currency_code: string
  workflow: OrderWorkflow | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<WorkflowStatus, { label: string; color: string; bg: string }> = {
  pending_provider: {
    label: "Pending Provider Clearance",
    color: "#92400E",
    bg: "#FEF3C7",
  },
  pending_md_review: {
    label: "Pending Physician Review",
    color: "#1E40AF",
    bg: "#DBEAFE",
  },
  provider_deferred: {
    label: "Pending Physician Review",
    color: "#1E40AF",
    bg: "#DBEAFE",
  },
  processing_pharmacy: {
    label: "Processing Pharmacy",
    color: "#5B21B6",
    bg: "#EDE9FE",
  },
  shipped: {
    label: "Shipped",
    color: "#065F46",
    bg: "#D1FAE5",
  },
  md_denied: {
    label: "Denied",
    color: "#991B1B",
    bg: "#FEE2E2",
  },
  refund_issued: {
    label: "Refunded",
    color: "#374151",
    bg: "#F3F4F6",
  },
}

/**
 * Parse treatment_dosages JSON and return a human-readable string.
 * Strips the "E-Commerce Online Order: " prefix from treatmentName.
 * If multiple treatments, joins with " / ".
 */
function parseMedDosage(raw: string | null): string {
  if (!raw) return "—"
  try {
    const treatments: TreatmentDosage[] = typeof raw === "string" ? JSON.parse(raw) : raw
    if (!Array.isArray(treatments) || treatments.length === 0) return "—"
    return treatments
      .map((t) => {
        const name = (t.treatmentName ?? "")
          .replace(/^E-Commerce Online Order:\s*/i, "")
          .trim()
        const dosage = (t.dosage ?? "").trim()
        return name && dosage ? `${name} — ${dosage}` : name || dosage || "—"
      })
      .join(" / ")
  } catch {
    return String(raw)
  }
}

function formatCurrency(amount: number, currency: string) {
  // Medusa v2 returns totals already in decimal (not cents)
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount)
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return "—"
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function StatusBadge({ status }: { status: WorkflowStatus | null }) {
  if (!status) {
    return (
      <span style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 10px",
        borderRadius: "9999px",
        fontSize: "12px",
        fontWeight: 500,
        background: "#F3F4F6",
        color: "#6B7280",
      }}>
        No Status
      </span>
    )
  }
  const cfg = STATUS_CONFIG[status] ?? { label: status, color: "#374151", bg: "#F3F4F6" }
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      padding: "2px 10px",
      borderRadius: "9999px",
      fontSize: "12px",
      fontWeight: 500,
      background: cfg.bg,
      color: cfg.color,
      whiteSpace: "nowrap",
    }}>
      {cfg.label}
    </span>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const RESTRICTED_ROLES = ["medical_director", "pharmacist"]

// Resolve the current user's role across all clinics.
// Returns the role string, "clinic_admin", or "super_admin".
async function resolveMyRole(): Promise<string> {
  try {
    const { user } = await fetch("/admin/users/me", { credentials: "include" }).then(r => r.json())
    if (!user?.email) return "super_admin"

    // Cache keyed by email so switching users never returns stale data
    const cacheKey = `mhc_role_${user.email}`
    const cached = sessionStorage.getItem(cacheKey)
    if (cached) return cached

    const { clinics } = await fetch("/admin/clinics", { credentials: "include" }).then(r => r.json())
    for (const clinic of (clinics || [])) {
      const { staff } = await fetch(`/admin/clinics/${clinic.id}/staff`, { credentials: "include" }).then(r => r.json())
      const match = (staff || []).find((s: any) => s.email === user.email)
      if (match?.role) {
        sessionStorage.setItem(cacheKey, match.role)
        return match.role
      }
    }
    sessionStorage.setItem(cacheKey, "super_admin")
  } catch {}
  return "super_admin"
}

function applyNavForRole(role: string) {
  document.getElementById("mhc-nav-restrictions")?.remove()
  document.getElementById("mhc-hide-settings")?.remove()
  document.getElementById("mhc-search-hide")?.remove()

  const s = document.createElement("style")
  s.id = "mhc-nav-restrictions"

  // Hide search bar for all non-super-admin roles
  if (role !== "super_admin") {
    const sh = document.createElement("style")
    sh.id = "mhc-search-hide"
    sh.textContent = `
      button.bg-ui-bg-subtle.gap-x-2\\.5 { display: none !important; }
    `
    document.head.appendChild(sh)
  }

  if (role === "medical_director" || role === "pharmacist") {
    // Only clinic-orders visible
    s.textContent = `
      a[href="/app/orders"],
      a[href="/app/products"],
      a[href="/app/inventory"],
      a[href="/app/customers"],
      a[href="/app/promotions"],
      a[href="/app/price-lists"],
      a[href="/app/reservations"],
      a[href="/app/settings"],
      a[href^="/app/settings/"],
      a[href="/app/provider-settings"] { display: none !important; }
    `
  } else if (role === "clinic_admin") {
    // Hide settings + standard orders + customers + promotions
    s.textContent = `
      a[href="/app/orders"],
      a[href="/app/customers"],
      a[href="/app/promotions"],
      a[href="/app/settings"],
      a[href^="/app/settings/"] { display: none !important; }
    `
  } else {
    // super_admin: hide only the standard orders link (replaced by clinic-orders)
    s.textContent = `a[href="/app/orders"] { display: none !important; }`
  }

  document.head.appendChild(s)
}

export default function ClinicOrdersPage() {
  const navigate = useNavigate()
  const [orders, setOrders] = useState<ClinicOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [clinicFilter, setClinicFilter] = useState<string>("all")
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const limit = 20

  const fetchOrders = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const offset = (page - 1) * limit

      // Single request to our custom route — returns orders + workflows
      // joined in SQL and sorted by created_at DESC across the whole DB
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      })
      if (search) params.set("q", search)

      const res = await fetch(`/admin/order-workflow?${params}`, {
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      })
      if (!res.ok) throw new Error(`Failed to fetch orders (${res.status})`)
      const data = await res.json()

      setTotal(data.count ?? 0)
      setOrders(data.orders ?? [])

    } catch (err: any) {
      setError(err.message ?? "Unknown error")
    } finally {
      setLoading(false)
    }
  }, [page, search])

  // Apply nav restrictions on mount + redirect /app/orders to here for restricted roles
  useEffect(() => {
    resolveMyRole().then(role => {
      applyNavForRole(role)
      // If a restricted user somehow lands on /app/orders, redirect them here
      if (RESTRICTED_ROLES.includes(role) && window.location.pathname === "/app/orders") {
        navigate("/clinic-orders", { replace: true })
      }
    })
  }, [])

  useEffect(() => {
    fetchOrders()
  }, [fetchOrders])

  // ── Derived filter values ──────────────────────────────────────────────
  const clinics = Array.from(
    new Set(orders.map((o) => o.sales_channel?.name).filter(Boolean))
  ) as string[]

  const filtered = orders.filter((o) => {
    if (clinicFilter !== "all" && o.sales_channel?.name !== clinicFilter) return false
    if (statusFilter !== "all" && o.workflow?.status !== statusFilter) return false
    return true
  })

  const totalPages = Math.ceil(total / limit)

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div style={{
      padding: "24px",
      fontFamily: "'DM Sans', system-ui, sans-serif",
      color: "#111827",
      minHeight: "100vh",
      background: "#F9FAFB",
    }}>
      {/* Header */}
      <div style={{ marginBottom: "24px" }}>
        <h1 style={{
          fontSize: "24px",
          fontWeight: 700,
          color: "#111827",
          margin: 0,
          lineHeight: 1.2,
        }}>
          Clinic Orders
        </h1>
        <p style={{ color: "#6B7280", fontSize: "14px", margin: "4px 0 0" }}>
          {total} total orders across all clinics
        </p>
      </div>

      {/* Filters */}
      <div style={{
        display: "flex",
        gap: "12px",
        marginBottom: "16px",
        flexWrap: "wrap",
        alignItems: "center",
      }}>
        <input
          type="text"
          placeholder="Search by order # or patient name…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          style={{
            padding: "8px 14px",
            borderRadius: "8px",
            border: "1px solid #E5E7EB",
            fontSize: "14px",
            outline: "none",
            width: "280px",
            background: "#fff",
            color: "#111827",
          }}
        />

        <select
          value={clinicFilter}
          onChange={(e) => { setClinicFilter(e.target.value); setPage(1) }}
          style={{
            padding: "8px 14px",
            borderRadius: "8px",
            border: "1px solid #E5E7EB",
            fontSize: "14px",
            background: "#fff",
            color: "#111827",
            cursor: "pointer",
          }}
        >
          <option value="all">All Clinics</option>
          {clinics.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
          style={{
            padding: "8px 14px",
            borderRadius: "8px",
            border: "1px solid #E5E7EB",
            fontSize: "14px",
            background: "#fff",
            color: "#111827",
            cursor: "pointer",
          }}
        >
          <option value="all">All Statuses</option>
          <option value="pending_provider">Pending Provider Clearance</option>
          <option value="pending_md_review">Pending Physician Review</option>
          <option value="processing_pharmacy">Processing Pharmacy</option>
          <option value="shipped">Shipped</option>
          <option value="md_denied">Denied</option>
          <option value="refund_issued">Refunded</option>
        </select>

        <button
          onClick={fetchOrders}
          style={{
            marginLeft: "auto",
            padding: "8px 16px",
            borderRadius: "8px",
            border: "1px solid #E5E7EB",
            background: "#fff",
            fontSize: "14px",
            cursor: "pointer",
            color: "#374151",
            fontWeight: 500,
          }}
        >
          ↻ Refresh
        </button>
      </div>

      {/* Table */}
      <div style={{
        background: "#fff",
        borderRadius: "12px",
        border: "1px solid #E5E7EB",
        overflow: "hidden",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
      }}>
        {loading ? (
          <div style={{ padding: "60px", textAlign: "center", color: "#9CA3AF" }}>
            Loading orders…
          </div>
        ) : error ? (
          <div style={{ padding: "60px", textAlign: "center", color: "#EF4444" }}>
            Error: {error}
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: "60px", textAlign: "center", color: "#9CA3AF" }}>
            No orders found.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ background: "#F9FAFB", borderBottom: "1px solid #E5E7EB" }}>
                  {[
                    "Order", "Date", "Patient", "Clinic", "State",
                    "Medication & Dosage", "GFE Status", "Workflow Status",
                    "Ship Date", "Tracking #", "Amount",
                  ].map((h) => (
                    <th key={h} style={{
                      padding: "10px 16px",
                      textAlign: "left",
                      fontWeight: 600,
                      color: "#6B7280",
                      fontSize: "11px",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      whiteSpace: "nowrap",
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((order, idx) => {
                  const patientName = [
                    order.shipping_address?.first_name || order.customer?.first_name,
                    order.shipping_address?.last_name || order.customer?.last_name,
                  ].filter(Boolean).join(" ") || order.customer?.email || "—"

                  const medDosage = parseMedDosage(order.workflow?.treatment_dosages ?? null)

                  return (
                    <tr
                      key={order.id}
                      onClick={() => navigate(`/orders/${order.id}`)}
                      style={{
                        borderBottom: idx < filtered.length - 1 ? "1px solid #F3F4F6" : "none",
                        cursor: "pointer",
                        transition: "background 0.12s",
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLTableRowElement).style.background = "#F9FAFB"
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLTableRowElement).style.background = "transparent"
                      }}
                    >
                      {/* Order # */}
                      <td style={{ padding: "14px 16px", whiteSpace: "nowrap" }}>
                        <span style={{ fontWeight: 600, color: "#111827" }}>
                          #{order.display_id}
                        </span>
                      </td>

                      {/* Date */}
                      <td style={{ padding: "14px 16px", color: "#6B7280", whiteSpace: "nowrap" }}>
                        {formatDate(order.created_at)}
                      </td>

                      {/* Patient */}
                      <td style={{ padding: "14px 16px", whiteSpace: "nowrap", fontWeight: 500 }}>
                        {patientName}
                      </td>

                      {/* Clinic */}
                      <td style={{ padding: "14px 16px", color: "#374151", whiteSpace: "nowrap" }}>
                        {order.sales_channel?.name ?? "—"}
                      </td>

                      {/* State */}
                      <td style={{ padding: "14px 16px", color: "#6B7280", whiteSpace: "nowrap" }}>
                        {order.shipping_address?.province ?? "—"}
                      </td>

                      {/* Medication & Dosage */}
                      <td style={{ padding: "14px 16px", maxWidth: "200px" }}>
                        <span
                          title={medDosage !== "—" ? medDosage : undefined}
                          style={{
                            display: "block",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            color: "#374151",
                          }}
                        >
                          {medDosage}
                        </span>
                      </td>

                      {/* GFE Status */}
                      <td style={{ padding: "14px 16px", whiteSpace: "nowrap", color: "#6B7280" }}>
                        {order.workflow?.provider_status ?? "—"}
                      </td>

                      {/* Workflow Status */}
                      <td style={{ padding: "14px 16px" }}>
                        <StatusBadge status={order.workflow?.status ?? null} />
                      </td>

                      {/* Ship Date */}
                      <td style={{ padding: "14px 16px", color: "#6B7280", whiteSpace: "nowrap" }}>
                        {formatDate(order.workflow?.shipped_at ?? null)}
                      </td>

                      {/* Tracking # */}
                      <td style={{ padding: "14px 16px", whiteSpace: "nowrap" }}>
                        {order.workflow?.tracking_number ? (
                          <span style={{ fontFamily: "monospace", fontSize: "12px", color: "#374151" }}>
                            {order.workflow.carrier && (
                              <span style={{ color: "#9CA3AF", marginRight: "4px" }}>
                                {order.workflow.carrier}
                              </span>
                            )}
                            {order.workflow.tracking_number}
                          </span>
                        ) : "—"}
                      </td>

                      {/* Amount */}
                      <td style={{ padding: "14px 16px", fontWeight: 600, whiteSpace: "nowrap", color: "#111827" }}>
                        {formatCurrency(order.total, order.currency_code)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: "16px",
          fontSize: "13px",
          color: "#6B7280",
        }}>
          <span>
            Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total} orders
          </span>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
              style={{
                padding: "6px 14px",
                borderRadius: "8px",
                border: "1px solid #E5E7EB",
                background: page === 1 ? "#F9FAFB" : "#fff",
                cursor: page === 1 ? "default" : "pointer",
                color: page === 1 ? "#D1D5DB" : "#374151",
                fontWeight: 500,
              }}
            >
              ← Prev
            </button>
            <button
              disabled={page === totalPages}
              onClick={() => setPage((p) => p + 1)}
              style={{
                padding: "6px 14px",
                borderRadius: "8px",
                border: "1px solid #E5E7EB",
                background: page === totalPages ? "#F9FAFB" : "#fff",
                cursor: page === totalPages ? "default" : "pointer",
                color: page === totalPages ? "#D1D5DB" : "#374151",
                fontWeight: 500,
              }}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}