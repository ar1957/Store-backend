/**
 * Dynamic Clinic Operations Admin — with Role-Based Access + Comments
 * File: src/admin/routes/provider-settings/page.tsx
 */

import { useState, useEffect } from "react"
import { defineRouteConfig } from "@medusajs/admin-sdk"
import { BuildingStorefront } from "@medusajs/icons"
import { resolveMyRole } from "../../utils/resolve-role"

export const config = defineRouteConfig({
  label: "Clinic Operations",
  icon: BuildingStorefront,
})

// ── Types ──────────────────────────────────────────────────────────────────
interface Clinic {
  id: string
  name: string
  slug: string
  domains: string[]
  contact_email: string
  is_active: boolean
  logo_url: string
  brand_color: string
  api_client_id: string
  api_client_secret: string
  api_env: "test" | "prod"
  api_base_url_test: string
  api_base_url_prod: string
  connect_url_test: string
  connect_url_prod: string
  redirect_url: string
  stripe_secret_key: string
  stripe_publishable_key: string
  publishable_api_key: string
  sales_channel_id: string
  pharmacy_staff_id: string
  from_email: string
  from_name: string
  reply_to: string
  pharmacy_type: string
  pharmacy_api_url: string
  pharmacy_api_key: string
  pharmacy_store_id: string
  pharmacy_vendor_name: string
  pharmacy_doctor_first_name: string
  pharmacy_doctor_last_name: string
  pharmacy_doctor_npi: string
  pharmacy_enabled: boolean
  payment_provider: string
  paypal_client_id: string
  paypal_client_secret: string
  paypal_mode: string
}

interface Staff { id: string; email: string; full_name: string; role: string }
interface Treatment { id: number; name: string }
interface Mapping { id: string; product_id: string; product_title: string; treatment_id: number; treatment_name: string; requires_eligibility: boolean }
interface Product { id: string; title: string }
interface TreatmentDosage { treatmentId: number; treatmentName: string; dosage: string | null }
interface Order { id: string; order_id: string; display_id: number; patient_name: string; patient_email: string; status: string; patient_id: number; provider_name: string; tracking_number: string; carrier: string; created_at: string; treatment_dosages?: TreatmentDosage[] }
interface Comment { id: string; user_name: string; user_email: string; role: string; comment: string; created_at: string }
interface CurrentUser { id: string; email: string; first_name: string; last_name: string }
interface StaffRecord { clinic_id: string; role: string; full_name: string; email: string; tenant_domain: string }

interface NavLink { label: string; url: string; open_new_tab?: boolean; children?: NavLink[] }
interface SocialLink { platform: string; url: string }
interface UiConfig {
  tenant_domain: string
  nav_links: NavLink[]
  footer_links: NavLink[]
  bottom_links: NavLink[]
  logo_url: string
  get_started_url: string
  contact_phone: string
  contact_email: string
  contact_address: string
  social_links: SocialLink[]
  certification_image_url: string
}

// ── Auth Helper ───────────────────────────────────────────────────────────
function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra }
}

// ── Constants ─────────────────────────────────────────────────────────────
const BLANK_CLINIC: Partial<Clinic> = {
  name: "", slug: "", domains: [], contact_email: "",
  is_active: true, brand_color: "#111111",
  api_env: "test",
  api_base_url_test: "https://api-dev.healthcoversonline.com/endpoint/v2",
  api_base_url_prod: "https://api.healthcoversonline.com/endpoint/v2",
  connect_url_test: "https://app.healthcoversonline.com/connect/patient",
  connect_url_prod: "https://app.healthcoversonline.com/connect/patient",
}

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  awaiting_provider_review: { label: "Awaiting Provider",  color: "#92400e", bg: "#fef3c7" },
  provider_approved:        { label: "Provider Approved",  color: "#065f46", bg: "#d1fae5" },
  provider_deferred:        { label: "MD Review Needed",   color: "#7c3aed", bg: "#ede9fe" },
  pending_provider:         { label: "Pending Provider",   color: "#92400e", bg: "#fef3c7" },
  processing_pharmacy:      { label: "Processing",         color: "#1e40af", bg: "#dbeafe" },
  md_approved:              { label: "MD Approved",        color: "#065f46", bg: "#d1fae5" },
  md_denied:                { label: "MD Denied",          color: "#991b1b", bg: "#fee2e2" },
  sent_to_pharmacy:         { label: "Sent to Pharmacy",   color: "#1e40af", bg: "#dbeafe" },
  pharmacy_processing:      { label: "Processing",         color: "#1e40af", bg: "#dbeafe" },
  shipped:                  { label: "Shipped",            color: "#065f46", bg: "#d1fae5" },
  pending_pharmacy:         { label: "Pending Pharmacy",   color: "#0e7490", bg: "#cffafe" },
  refund_issued:            { label: "Refund Issued",      color: "#991b1b", bg: "#fee2e2" },
}

const ROLE_LABELS: Record<string, string> = {
  clinic_admin: "Clinic Admin",
  medical_director: "Medical Director",
  pharmacist: "Pharmacist",
  super_admin: "Super Admin",
}

// ── Root ───────────────────────────────────────────────────────────────────
export default function ClinicOpsPage() {
  const [clinics, setClinics] = useState<Clinic[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showNewForm, setShowNewForm] = useState(false)
  const [newClinic, setNewClinic] = useState<Partial<Clinic>>(BLANK_CLINIC)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [myStaffRecord, setMyStaffRecord] = useState<StaffRecord | null>(null)
  const [userLoading, setUserLoading] = useState(true)

  // Fetch current user on mount
  useEffect(() => {
    const fetchUser = async () => {
      try {
        const res = await fetch("/admin/users/me", { credentials: "include" })
        if (res.ok) {
          const data = await res.json()
          setCurrentUser(data.user)
        }
      } catch {}
      finally { setUserLoading(false) }
    }
    fetchUser()
  }, [])

  useEffect(() => { loadClinics() }, [])

  const loadClinics = async () => {
    setLoading(true)
    try {
      const res = await fetch("/admin/clinics", { credentials: "include", headers: adminHeaders() })
      const data = await res.json()
      const allClinics = data.clinics || []
      setClinics(allClinics)
      if (allClinics.length > 0 && !selectedId) {
        setSelectedId(allClinics[0].id)
      }
    } catch {}
    finally { setLoading(false) }
  }

  // Once we have both user and clinics, find their staff record
  useEffect(() => {
    if (!currentUser || clinics.length === 0) return
    const findStaffRecord = async () => {
      for (const clinic of clinics) {
        try {
          const res = await fetch(`/admin/clinics/${clinic.id}/staff`, { credentials: "include" })
          const data = await res.json()
          const match = (data.staff || []).find((s: any) => s.email === currentUser.email)
          if (match) {
            setMyStaffRecord({ ...match, clinic_id: clinic.id })
            setSelectedId(clinic.id) // auto-select their clinic
            return
          }
        } catch {}
      }
      // Not found in any clinic = super admin
      setMyStaffRecord(null)
    }
    findStaffRecord()
  }, [currentUser, clinics.length])

  const isSuperAdmin = !userLoading && currentUser && !myStaffRecord
  const myRole = myStaffRecord?.role || (isSuperAdmin ? "super_admin" : null)

  // Hide Settings nav immediately on mount, reveal only for super_admin once role resolves
  useEffect(() => {
    resolveMyRole().then(role => {
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
        s.textContent = `
          a[href="/app/orders"],
          a[href="/app/customers"],
          a[href="/app/promotions"],
          a[href="/app/settings"],
          a[href^="/app/settings/"] { display: none !important; }
        `
      } else {
        // super_admin: hide only standard orders (replaced by clinic-orders)
        s.textContent = `a[href="/app/orders"] { display: none !important; }`
      }

      document.head.appendChild(s)
    })
  }, [])

  // Filter clinics visible to this user
  const visibleClinics = isSuperAdmin
    ? clinics
    : clinics.filter(c =>
        c.id === myStaffRecord?.clinic_id ||
        (myStaffRecord?.tenant_domain && (c.domains || []).includes(myStaffRecord.tenant_domain))
      )

  const createClinic = async () => {
    if (!newClinic.name || !newClinic.slug) return
    setCreating(true)
    try {
      const res = await fetch("/admin/clinics", {
        method: "POST",
        credentials: "include",
        headers: adminHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(newClinic),
      })
      const data = await res.json()
      setClinics(prev => [...prev, data.clinic])
      setSelectedId(data.clinic.id)
      setShowNewForm(false)
      setNewClinic(BLANK_CLINIC)
    } catch {}
    finally { setCreating(false) }
  }

  const selectedClinic = visibleClinics.find(c => c.id === selectedId) ?? null

  if (userLoading) {
    return <div style={{ padding: 32, color: "#9ca3af" }}>Loading…</div>
  }

  return (
    <div style={s.root}>
      {/* Sidebar */}
      <div style={s.sidebar}>
        <div style={s.sidebarHeader}>
          <span style={s.sidebarTitle}>Clinics</span>
          {isSuperAdmin && (
            <button onClick={() => setShowNewForm(p => !p)} style={s.addBtn} title="Add clinic">+</button>
          )}
        </div>

        {/* Current user badge */}
        {currentUser && (
          <div style={{ padding: "8px 16px", borderBottom: "1px solid #f3f4f6", fontSize: 11, color: "#6b7280" }}>
            <div style={{ fontWeight: 600, color: "#111" }}>{currentUser.first_name} {currentUser.last_name}</div>
            <div style={{ color: myRole ? roleColor(myRole) : "#6b7280", fontWeight: 500 }}>
              {ROLE_LABELS[myRole || ""] || "Super Admin"}
            </div>
          </div>
        )}

        {/* New clinic form — super admin only */}
        {showNewForm && isSuperAdmin && (
          <div style={s.newForm}>
            <input style={s.sidebarInput} placeholder="Clinic name *"
              value={newClinic.name || ""}
              onChange={e => {
                const name = e.target.value
                const slug = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
                setNewClinic(p => ({ ...p, name, slug }))
              }} />
            <input style={s.sidebarInput} placeholder="slug (auto-filled)"
              value={newClinic.slug || ""}
              onChange={e => setNewClinic(p => ({ ...p, slug: e.target.value }))} />
            <input style={s.sidebarInput} placeholder="domain (e.g. spaderx.com)"
              onKeyDown={e => {
                if (e.key === "Enter") {
                  const val = (e.target as HTMLInputElement).value.trim()
                  if (val) {
                    setNewClinic(p => ({ ...p, domains: [...(p.domains || []), val] }))
                    ;(e.target as HTMLInputElement).value = ""
                  }
                }
              }} />
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: -4 }}>Press Enter to add domain</div>
            {(newClinic.domains || []).length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                {(newClinic.domains || []).map(d => (
                  <span key={d} style={s.domainTag}>
                    {d}
                    <button onClick={() => setNewClinic(p => ({ ...p, domains: p.domains?.filter(x => x !== d) }))}
                      style={s.domainRemove}>×</button>
                  </span>
                ))}
              </div>
            )}
            <button onClick={createClinic} disabled={creating || !newClinic.name}
              style={{ ...s.createBtn, opacity: !newClinic.name ? 0.5 : 1 }}>
              {creating ? "Creating…" : "Create Clinic"}
            </button>
          </div>
        )}

        {/* Clinic list */}
        {loading ? (
          <div style={{ padding: 16, color: "#9ca3af", fontSize: 13 }}>Loading…</div>
        ) : visibleClinics.length === 0 ? (
          <div style={{ padding: 16, color: "#9ca3af", fontSize: 13 }}>No clinics</div>
        ) : (
          visibleClinics.map(c => (
            <button key={c.id} onClick={() => setSelectedId(c.id)}
              style={{ ...s.clinicItem, ...(selectedId === c.id ? s.clinicItemActive : {}) }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: c.is_active ? "#10b981" : "#d1d5db", flexShrink: 0 }} />
                <div style={{ textAlign: "left" }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{c.name}</div>
                  <div style={{ fontSize: 11, color: selectedId === c.id ? "#94a3b8" : "#9ca3af" }}>
                    {c.domains?.[0] || c.slug}
                  </div>
                </div>
              </div>
            </button>
          ))
        )}
      </div>

      {/* Main area */}
      <div style={s.main}>
        {!selectedClinic ? (
          <div style={s.empty}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🏥</div>
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>No clinic selected</div>
            <div style={{ color: "#9ca3af" }}>Select a clinic from the sidebar</div>
          </div>
        ) : (
          <ClinicDetail
            clinic={selectedClinic}
            onUpdated={loadClinics}
            role={myRole || "super_admin"}
            currentUser={currentUser}
          />
        )}
      </div>
    </div>
  )
}

function roleColor(role: string): string {
  const map: Record<string, string> = {
    super_admin: "#111",
    clinic_admin: "#374151",
    medical_director: "#7c3aed",
    pharmacist: "#1e40af",
  }
  return map[role] || "#6b7280"
}

// ── Clinic Detail ──────────────────────────────────────────────────────────
function ClinicDetail({
  clinic, onUpdated, role, currentUser
}: {
  clinic: Clinic
  onUpdated: () => void
  role: string
  currentUser: CurrentUser | null
}) {
  // MD and Pharmacist go straight to orders tab
  const defaultTab = (role === "medical_director" || role === "pharmacist") ? "orders" : "details"
  const [activeTab, setActiveTab] = useState<"details" | "api" | "staff" | "mappings" | "orders" | "uiconfig" | "pharmacy" | "promotions" | "payouts">(defaultTab as any)

  // Tabs visible per role
  const visibleTabs = (() => {
    if (role === "medical_director" || role === "pharmacist") return ["orders"]
    if (role === "clinic_admin") return ["details", "api", "staff", "mappings", "orders", "uiconfig", "pharmacy", "promotions", "payouts"]
    return ["details", "api", "staff", "mappings", "orders", "uiconfig", "pharmacy", "promotions", "payouts"] // super_admin
  })()

  const TAB_LABELS: Record<string, string> = {
    details: "🏥 Details",
    api: "🔌 API & Credentials",
    staff: "👥 Staff",
    mappings: "💊 Product Mapping",
    orders: "📋 Orders",
    uiconfig: "🎨 Storefront UI",
    pharmacy: "💊 Pharmacy",
    promotions: "🎁 Promotions",
    payouts: "💰 Payouts",
  }

  // Default filter per role
  const defaultOrderFilter = role === "medical_director"
    ? "provider_deferred"
    : ""

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={s.detailHeader}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: clinic.brand_color || "#111",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#fff", fontWeight: 700, fontSize: 16,
          }}>
            {clinic.name[0]}
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 18 }}>{clinic.name}</div>
            <div style={{ fontSize: 12, color: "#6b7280" }}>{clinic.domains?.join(", ") || clinic.slug}</div>
          </div>
        </div>
        <span style={{
          padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600,
          background: clinic.is_active ? "#d1fae5" : "#f3f4f6",
          color: clinic.is_active ? "#065f46" : "#6b7280",
        }}>
          {clinic.is_active ? "Active" : "Inactive"}
        </span>
      </div>

      {visibleTabs.length > 1 && (
        <div style={s.tabBar}>
          {visibleTabs.map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab as any)}
              style={{ ...s.tab, ...(activeTab === tab ? s.tabActive : {}) }}>
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
        {activeTab === "details"  && <DetailsTab  clinic={clinic} onUpdated={onUpdated} role={role} />}
        {activeTab === "api"      && <ApiTab       clinic={clinic} onUpdated={onUpdated} role={role} />}
        {activeTab === "staff"    && <StaffTab     clinic={clinic} onUpdated={onUpdated} role={role} />}
        {activeTab === "mappings" && <MappingsTab  clinic={clinic} />}
        {activeTab === "orders"   && (
          <OrdersTab
            clinic={clinic}
            role={role}
            currentUser={currentUser}
            defaultFilter={defaultOrderFilter}
          />
        )}
        {activeTab === "uiconfig" && <UiConfigTab clinic={clinic} />}
        {activeTab === "pharmacy" && <PharmacyTab clinic={clinic} onUpdated={onUpdated} />}
        {activeTab === "promotions" && <PromotionsTab clinic={clinic} role={role} />}
        {activeTab === "payouts"    && <PayoutsTab    clinic={clinic} />}
      </div>
    </div>
  )
}

// ── Details Tab ────────────────────────────────────────────────────────────
function DetailsTab({ clinic, onUpdated, role }: { clinic: Clinic; onUpdated: () => void; role?: string }) {
  const readOnly = role === "clinic_admin"
  const [form, setForm] = useState({ ...clinic, domains: clinic.domains || [] })
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState("")
  const [domainInput, setDomainInput] = useState("")
  const [salesChannels, setSalesChannels] = useState<{ id: string; name: string }[]>([])
  const [loadingPubKey, setLoadingPubKey] = useState(false)

  useEffect(() => { setForm({ ...clinic, domains: clinic.domains || [] }) }, [clinic.id])

  // Load sales channels on mount
  useEffect(() => {
    fetch("/admin/sales-channels?limit=100", { credentials: "include", headers: adminHeaders() })
      .then(r => r.json())
      .then(d => setSalesChannels((d.sales_channels || []).map((sc: any) => ({ id: sc.id, name: sc.name }))))
      .catch(() => {})
  }, [])

  const handleSalesChannelChange = async (scId: string) => {
    setForm(p => ({ ...p, sales_channel_id: scId } as any))
    if (!scId) return

    // Fetch the publishable API key for this sales channel
    setLoadingPubKey(true)
    try {
      const res = await fetch(`/admin/api-keys?limit=100`, { credentials: "include", headers: adminHeaders() })
      const data = await res.json()
      // Find a publishable key linked to this sales channel
      const keys: any[] = data.api_keys || []
      const match = keys.find((k: any) =>
        k.type === "publishable" &&
        (k.sales_channels || []).some((sc: any) => sc.id === scId)
      )
      if (match) {
        setForm(p => ({ ...p, publishable_api_key: match.token, sales_channel_id: scId } as any))
      }
    } catch {}
    finally { setLoadingPubKey(false) }
  }

  const save = async () => {
    setSaving(true)
    setStatus("")
    try {
      const payload = {
        name: form.name,
        slug: form.slug,
        contact_email: form.contact_email,
        brand_color: form.brand_color,
        logo_url: form.logo_url,
        publishable_api_key: form.publishable_api_key,
        sales_channel_id: (form as any).sales_channel_id || null,
        domains: form.domains,
        is_active: form.is_active,
        from_email: (form as any).from_email || null,
        from_name: (form as any).from_name || null,
        reply_to: (form as any).reply_to || null,
      }
      const res = await fetch(`/admin/clinics/${clinic.id}`, {
        method: "POST", credentials: "include",
        headers: adminHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        setStatus("saved")
        onUpdated()
      } else {
        const err = await res.json().catch(() => ({}))
        console.error("[DetailsTab save]", res.status, err)
        setStatus("error")
      }
    } catch (e) {
      console.error("[DetailsTab save] network error", e)
      setStatus("error")
    } finally { setSaving(false) }
  }

  const addDomain = () => {
    const d = domainInput.trim()
    if (d && !form.domains.includes(d)) {
      setForm(p => ({ ...p, domains: [...p.domains, d] }))
      setDomainInput("")
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {readOnly && (
        <div style={{ padding: "10px 14px", background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, fontSize: 13, color: "#92400e" }}>
          🔒 View only — contact a Super Admin to make changes.
        </div>
      )}
      <div style={s.grid2}>
        <Field label="Clinic Name">
          <input style={s.input} value={form.name} onChange={e => !readOnly && setForm(p => ({ ...p, name: e.target.value }))} disabled={readOnly} />
        </Field>
        <Field label="Slug">
          <input style={s.input} value={form.slug} onChange={e => setForm(p => ({ ...p, slug: e.target.value }))} />
        </Field>
        <Field label="Contact Email">
          <input style={s.input} value={form.contact_email || ""} onChange={e => setForm(p => ({ ...p, contact_email: e.target.value }))} />
        </Field>
        <Field label="Brand Color">
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="color" value={form.brand_color || "#111111"}
              onChange={e => setForm(p => ({ ...p, brand_color: e.target.value }))}
              style={{ width: 40, height: 38, border: "1px solid #e5e7eb", borderRadius: 8, cursor: "pointer" }} />
            <input style={s.input} value={form.brand_color || ""} onChange={e => setForm(p => ({ ...p, brand_color: e.target.value }))} />
          </div>
        </Field>
        <Field label="Logo URL">
          <input style={s.input} value={form.logo_url || ""} onChange={e => setForm(p => ({ ...p, logo_url: e.target.value }))} placeholder="https://..." />
        </Field>
      </div>

      {/* ── Per-clinic email sending ── */}
      <div style={{ borderTop: "1px solid #f3f4f6", paddingTop: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: "#6b7280", letterSpacing: "0.05em", marginBottom: 12 }}>
          📧 Email Sending (Resend)
        </div>
        <div style={s.grid2}>
          <Field label="From Email">
            <input style={s.input} value={(form as any).from_email || ""} onChange={e => setForm(p => ({ ...p, from_email: e.target.value } as any))} placeholder="noreply@yourclinic.com" />
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 3 }}>Must be a verified sender in Resend</div>
          </Field>
          <Field label="From Name">
            <input style={s.input} value={(form as any).from_name || ""} onChange={e => setForm(p => ({ ...p, from_name: e.target.value } as any))} placeholder="Spaderx Clinic" />
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 3 }}>Display name shown to patients</div>
          </Field>
          <Field label="Reply-To Email">
            <input style={s.input} value={(form as any).reply_to || ""} onChange={e => setForm(p => ({ ...p, reply_to: e.target.value } as any))} placeholder="support@yourclinic.com" />
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 3 }}>Optional — where patient replies go</div>
          </Field>
        </div>
      </div>

      <div style={s.grid2}>
        <Field label="Sales Channel">
          <select
            style={s.input}
            value={(form as any).sales_channel_id || ""}
            onChange={e => handleSalesChannelChange(e.target.value)}
          >
            <option value="">Select sales channel…</option>
            {salesChannels.map(sc => (
              <option key={sc.id} value={sc.id}>{sc.name}</option>
            ))}
          </select>
        </Field>
        <Field label={loadingPubKey ? "Publishable API Key (loading…)" : "Publishable API Key (Medusa)"}>
          <input style={s.input} value={form.publishable_api_key || ""} onChange={e => setForm(p => ({ ...p, publishable_api_key: e.target.value }))} placeholder="pk_… (auto-filled when channel selected)" />
        </Field>
      </div>
      <Field label="Domains">
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input style={{ ...s.input, flex: 1 }} value={domainInput}
            onChange={e => setDomainInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addDomain()}
            placeholder="e.g. spaderx.com" />
          <button onClick={addDomain} style={s.btnOutline}>Add</button>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {form.domains.map(d => (
            <span key={d} style={s.domainTag}>
              {d}
              <button onClick={() => setForm(p => ({ ...p, domains: p.domains.filter(x => x !== d) }))} style={s.domainRemove}>×</button>
            </span>
          ))}
        </div>
      </Field>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div onClick={() => setForm(p => ({ ...p, is_active: !p.is_active }))} style={{
          width: 40, height: 22, borderRadius: 11, background: form.is_active ? "#10b981" : "#d1d5db",
          position: "relative", cursor: "pointer", transition: "background 0.2s",
        }}>
          <div style={{
            position: "absolute", top: 3, left: form.is_active ? 21 : 3,
            width: 16, height: 16, borderRadius: "50%", background: "#fff",
            transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          }} />
        </div>
        <span style={{ fontSize: 13 }}>Clinic {form.is_active ? "Active" : "Inactive"}</span>
      </div>
      {!readOnly && <SaveBar saving={saving} status={status} onSave={save} />}
    </div>
  )
}


// ── API Tab ────────────────────────────────────────────────────────────────
function ApiTab({ clinic, onUpdated, role }: { clinic: Clinic; onUpdated: () => void; role?: string }) {
  const readOnly = role === "clinic_admin"
  const [form, setForm] = useState({ ...clinic })
  const [showSecret, setShowSecret] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [status, setStatus] = useState("")

  useEffect(() => { setForm({ ...clinic }); setTestResult(null) }, [clinic.id])

  const save = async () => {
    setSaving(true)
    setStatus("")
    try {
      const payload = {
        api_client_id: form.api_client_id,
        api_client_secret: form.api_client_secret,
        api_env: form.api_env,
        api_base_url_test: form.api_base_url_test,
        api_base_url_prod: form.api_base_url_prod,
        connect_url_test: form.connect_url_test,
        connect_url_prod: form.connect_url_prod,
        redirect_url: form.redirect_url,
        stripe_publishable_key: form.stripe_publishable_key,
        stripe_secret_key: form.stripe_secret_key,
        pharmacy_staff_id: form.pharmacy_staff_id,
        payment_provider: (form as any).payment_provider,
        paypal_client_id: (form as any).paypal_client_id,
        paypal_client_secret: (form as any).paypal_client_secret,
        paypal_mode: (form as any).paypal_mode,
      }
      const res = await fetch(`/admin/clinics/${clinic.id}`, {
        method: "POST", credentials: "include",
        headers: adminHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        setStatus("saved")
        onUpdated()
      } else {
        const err = await res.json().catch(() => ({}))
        console.error("[ApiTab save]", res.status, err)
        setStatus("error")
      }
    } catch (e) {
      console.error("[ApiTab save] network error", e)
      setStatus("error")
    } finally { setSaving(false) }
  }

  const testConnection = async () => {
    setTesting(true)
    await save()
    try {
      const res = await fetch(`/admin/clinics/${clinic.id}/test-connection`, {
        method: "POST", credentials: "include", headers: adminHeaders(),
      })
      setTestResult(await res.json())
    } catch { setTestResult({ success: false, message: "Network error" }) }
    finally { setTesting(false) }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {readOnly && (
        <div style={{ padding: "10px 14px", background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, fontSize: 13, color: "#92400e" }}>
          🔒 View only — contact a Super Admin to make changes.
        </div>
      )}
      <div style={s.grid2}>
        <Field label="Client ID">
          <input style={s.input} value={form.api_client_id || ""} onChange={e => !readOnly && setForm(p => ({ ...p, api_client_id: e.target.value }))} disabled={readOnly} placeholder="Enter client ID" />
        </Field>
        <Field label="Client Secret">
          <div style={{ position: "relative" }}>
            <input style={{ ...s.input, paddingRight: 52 }} type={showSecret ? "text" : "password"}
              value={form.api_client_secret || ""} onChange={e => setForm(p => ({ ...p, api_client_secret: e.target.value }))} placeholder="Enter secret" />
            <button onClick={() => setShowSecret(p => !p)} style={s.showBtn}>{showSecret ? "Hide" : "Show"}</button>
          </div>
        </Field>
        <Field label="API Environment">
          <select style={s.input} value={form.api_env} onChange={e => setForm(p => ({ ...p, api_env: e.target.value as "test" | "prod" }))}>
            <option value="test">Test / Dev</option>
            <option value="prod">Production</option>
          </select>
        </Field>
        <Field label="API Base URL (Test)">
          <input style={{ ...s.input, fontSize: 12 }} value={form.api_base_url_test || ""} onChange={e => setForm(p => ({ ...p, api_base_url_test: e.target.value }))} />
        </Field>
        <Field label="API Base URL (Production)">
          <input style={{ ...s.input, fontSize: 12 }} value={form.api_base_url_prod || ""} onChange={e => setForm(p => ({ ...p, api_base_url_prod: e.target.value }))} />
        </Field>
        <Field label="Connect URL (Test)">
          <input style={{ ...s.input, fontSize: 12 }} value={form.connect_url_test || ""} onChange={e => setForm(p => ({ ...p, connect_url_test: e.target.value }))} />
        </Field>
        <Field label="Connect URL (Production)">
          <input style={{ ...s.input, fontSize: 12 }} value={form.connect_url_prod || ""} onChange={e => setForm(p => ({ ...p, connect_url_prod: e.target.value }))} />
        </Field>
        <Field label="Post-Call Redirect URL">
          <input style={s.input} value={form.redirect_url || ""} onChange={e => setForm(p => ({ ...p, redirect_url: e.target.value }))}
            placeholder={`https://${clinic.domains?.[0] || "your-domain.com"}/order-status`} />
        </Field>
      </div>
      <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 20, marginTop: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#111", marginBottom: 14 }}>💳 Stripe Payment Keys</div>
        <div style={s.grid2}>
          <Field label="Stripe Publishable Key">
            <input style={s.input} value={form.stripe_publishable_key || ""} onChange={e => setForm(p => ({ ...p, stripe_publishable_key: e.target.value }))} placeholder="pk_live_... or pk_test_..." />
          </Field>
          <Field label="Stripe Secret Key">
            <div style={{ position: "relative" }}>
              <input style={{ ...s.input, paddingRight: 52 }} type={showSecret ? "text" : "password"}
                value={form.stripe_secret_key || ""} onChange={e => setForm(p => ({ ...p, stripe_secret_key: e.target.value }))} placeholder="sk_live_... or sk_test_..." />
              <button onClick={() => setShowSecret(p => !p)} style={s.showBtn}>{showSecret ? "Hide" : "Show"}</button>
            </div>
          </Field>
        </div>
      </div>

      {/* ── Payment Provider Selection ── */}
      <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 20, marginTop: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#111", marginBottom: 14 }}>🏦 Payment Provider</div>
        <Field label="Active Payment Provider">
          <select style={s.input} value={(form as any).payment_provider || "stripe"}
            onChange={e => setForm(p => ({ ...p, payment_provider: e.target.value } as any))}>
            <option value="stripe">Stripe only</option>
            <option value="paypal">PayPal only</option>
            <option value="both">Both (Stripe + PayPal)</option>
          </select>
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 3 }}>
            Controls which payment options are shown to patients at checkout
          </div>
        </Field>
      </div>

      {/* ── PayPal Keys ── */}
      <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 20, marginTop: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#111", marginBottom: 14 }}>🅿️ PayPal Credentials</div>
        <div style={s.grid2}>
          <Field label="PayPal Mode">
            <select style={s.input} value={(form as any).paypal_mode || "sandbox"}
              onChange={e => setForm(p => ({ ...p, paypal_mode: e.target.value } as any))}>
              <option value="sandbox">Sandbox (Test)</option>
              <option value="live">Live (Production)</option>
            </select>
          </Field>
          <Field label="PayPal Client ID">
            <input style={s.input} value={(form as any).paypal_client_id || ""}
              onChange={e => setForm(p => ({ ...p, paypal_client_id: e.target.value } as any))}
              placeholder="AXxx... (from PayPal Developer Dashboard)" />
          </Field>
          <Field label="PayPal Client Secret">
            <div style={{ position: "relative" }}>
              <input style={{ ...s.input, paddingRight: 52 }} type={showSecret ? "text" : "password"}
                value={(form as any).paypal_client_secret || ""}
                onChange={e => setForm(p => ({ ...p, paypal_client_secret: e.target.value } as any))}
                placeholder="EXxx... (from PayPal Developer Dashboard)" />
              <button onClick={() => setShowSecret(p => !p)} style={s.showBtn}>{showSecret ? "Hide" : "Show"}</button>
            </div>
          </Field>
        </div>
      </div>

      {testResult && (
        <div style={{
          padding: "10px 16px", borderRadius: 8,
          background: testResult.success ? "#f0fdf4" : "#fef2f2",
          border: `1px solid ${testResult.success ? "#bbf7d0" : "#fecaca"}`,
          color: testResult.success ? "#15803d" : "#dc2626", fontSize: 13,
        }}>
          {testResult.success ? "✓" : "✗"} {testResult.message}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <button onClick={testConnection} disabled={testing || !form.api_client_id || readOnly}
          style={{ ...s.btnOutline, opacity: (!form.api_client_id || readOnly) ? 0.5 : 1 }}>
          {testing ? "Testing…" : "Test Connection"}
        </button>
        {!readOnly && <SaveBar saving={saving} status={status} onSave={save} inline />}
      </div>
    </div>
  )
}

// ── Staff Tab ──────────────────────────────────────────────────────────────
function StaffTab({ clinic, onUpdated, role }: { clinic: Clinic; onUpdated: () => void; role: string }) {
  const [staff, setStaff] = useState<Staff[]>([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ email: "", full_name: "", role: "pharmacist" })
  const [adding, setAdding] = useState(false)
  const [pwTarget, setPwTarget] = useState<Staff | null>(null)
  const [newPw, setNewPw] = useState("")
  const [pwSaving, setPwSaving] = useState(false)
  const [pwMsg, setPwMsg] = useState<{ text: string; ok: boolean } | null>(null)

  useEffect(() => { loadStaff() }, [clinic.id])

  const loadStaff = async () => {
    try {
      const res = await fetch(`/admin/clinics/${clinic.id}/staff`, { credentials: "include", headers: adminHeaders() })
      const data = await res.json()
      setStaff(data.staff || [])
    } catch {}
  }

  const addStaff = async () => {
    setAdding(true)
    try {
      await fetch(`/admin/clinics/${clinic.id}/staff`, {
        method: "POST", credentials: "include",
        headers: adminHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ user_id: form.email, email: form.email, full_name: form.full_name, role: form.role }),
      })
      setForm({ email: "", full_name: "", role: "pharmacist" })
      setShowForm(false)
      loadStaff()
    } catch {}
    finally { setAdding(false) }
  }

  const setPassword = async () => {
    if (!pwTarget || newPw.length < 8) return
    setPwSaving(true)
    setPwMsg(null)
    try {
      const res = await fetch("/admin/set-user-password", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: pwTarget.email, password: newPw }),
      })
      const d = await res.json()
      if (res.ok) {
        setPwMsg({ text: "Password updated", ok: true })
        setNewPw("")
        setTimeout(() => { setPwTarget(null); setPwMsg(null) }, 1500)
      } else {
        setPwMsg({ text: d.message || "Failed", ok: false })
      }
    } catch (e: any) {
      setPwMsg({ text: e.message || "Error", ok: false })
    } finally { setPwSaving(false) }
  }

  const roleColors: Record<string, { bg: string; color: string }> = {
    medical_director: { bg: "#ede9fe", color: "#7c3aed" },
    pharmacist:       { bg: "#dbeafe", color: "#1e40af" },
    clinic_admin:     { bg: "#f3f4f6", color: "#374151" },
  }

  const canManage = role === "super_admin" || role === "clinic_admin"

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        {canManage && <button onClick={() => setShowForm(p => !p)} style={s.btnPrimary}>{showForm ? "Cancel" : "+ Add Staff"}</button>}
      </div>
      {showForm && canManage && (
        <div style={{ ...s.formBox, marginBottom: 20 }}>
          <div style={s.grid2}>
            <Field label="Full Name">
              <input style={s.input} value={form.full_name} onChange={e => setForm(p => ({ ...p, full_name: e.target.value }))} placeholder="Dr. Jane Smith" />
            </Field>
            <Field label="Email">
              <input style={s.input} value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} placeholder="jane@clinic.com" />
            </Field>
            <Field label="Role">
              <select style={s.input} value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))}>
                <option value="clinic_admin">Clinic Admin</option>
                <option value="medical_director">Medical Director</option>
                <option value="pharmacist">Pharmacist</option>
              </select>
            </Field>
          </div>
          <button onClick={addStaff} disabled={adding || !form.email} style={s.btnPrimary}>
            {adding ? "Adding…" : "Add Staff Member"}
          </button>
        </div>
      )}

      {/* Set Password modal */}
      {pwTarget && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
        }}>
          <div style={{
            background: "#fff", borderRadius: 12, padding: 28, width: 380,
            boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Set Password</div>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 20 }}>{pwTarget.full_name || pwTarget.email}</div>
            <Field label="New Password">
              <input
                style={s.input} type="password" placeholder="Minimum 8 characters"
                value={newPw} onChange={e => setNewPw(e.target.value)}
                autoFocus autoComplete="new-password"
              />
            </Field>
            {pwMsg && (
              <div style={{
                marginTop: 12, padding: "8px 12px", borderRadius: 8, fontSize: 13,
                background: pwMsg.ok ? "#f0fdf4" : "#fef2f2",
                color: pwMsg.ok ? "#15803d" : "#dc2626",
                border: `1px solid ${pwMsg.ok ? "#bbf7d0" : "#fecaca"}`,
              }}>
                {pwMsg.ok ? "✓" : "✗"} {pwMsg.text}
              </div>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button onClick={setPassword} disabled={pwSaving || newPw.length < 8} style={{
                ...s.btnPrimary, opacity: newPw.length < 8 ? 0.5 : 1,
              }}>
                {pwSaving ? "Saving…" : "Update Password"}
              </button>
              <button onClick={() => { setPwTarget(null); setNewPw(""); setPwMsg(null) }} style={s.btnOutline}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {staff.length === 0 ? (
        <EmptyState icon="👥" message="No staff assigned to this clinic yet" />
      ) : (
        <table style={s.table}>
          <thead>
            <tr>{["Name", "Email", "Role", ""].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {staff.map(m => {
              const rc = roleColors[m.role] || roleColors.clinic_admin
              return (
                <tr key={m.id}>
                  <td style={s.td}>{m.full_name || "—"}</td>
                  <td style={s.td}>{m.email}</td>
                  <td style={s.td}>
                    <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, ...rc }}>
                      {m.role.replace("_", " ").replace(/\b\w/g, l => l.toUpperCase())}
                    </span>
                  </td>
                  <td style={{ ...s.td, display: "flex", gap: 8 }}>
                    {canManage && (
                      <button onClick={() => { setPwTarget(m); setNewPw(""); setPwMsg(null) }}
                        style={{ ...s.btnOutline, fontSize: 12 }}>
                        🔒 Set Password
                      </button>
                    )}
                    {canManage && (
                      <button onClick={async () => {
                        await fetch(`/admin/clinics/${clinic.id}/staff/${m.id}`, { method: "DELETE", credentials: "include", headers: adminHeaders() })
                        loadStaff()
                      }} style={s.btnDanger}>Remove</button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Mappings Tab ───────────────────────────────────────────────────────────
function MappingsTab({ clinic }: { clinic: Clinic }) {
  const [mappings, setMappings] = useState<Mapping[]>([])
  const [treatments, setTreatments] = useState<Treatment[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [form, setForm] = useState({ product_id: "", treatment_id: 0 })
  const [loadingTreatments, setLoadingTreatments] = useState(false)

  useEffect(() => { loadMappings(); loadProducts() }, [clinic.id])

  const loadMappings = async () => {
    try {
      const res = await fetch(`/admin/clinics/${clinic.id}/product-mappings`, { credentials: "include", headers: adminHeaders() })
      const data = await res.json()
      setMappings(data.mappings || [])
    } catch {}
  }

  const loadProducts = async () => {
    try {
      // Filter products by clinic's sales channel if available
      const scFilter = clinic.sales_channel_id
        ? `&sales_channel_id[]=${clinic.sales_channel_id}`
        : ""
      const res = await fetch(`/admin/products?limit=100${scFilter}`, { credentials: "include", headers: adminHeaders() })
      const data = await res.json()
      setProducts((data.products || []).map((p: any) => ({ id: p.id, title: p.title })))
    } catch {}
  }

  const loadTreatments = async () => {
    setLoadingTreatments(true)
    try {
      const res = await fetch(`/admin/clinics/${clinic.id}/treatments`, { credentials: "include", headers: adminHeaders() })
      const data = await res.json()
      setTreatments(data.treatments || [])
    } catch {}
    finally { setLoadingTreatments(false) }
  }

  const addMapping = async () => {
    if (!form.product_id || !form.treatment_id) return
    const product = products.find(p => p.id === form.product_id)
    const treatment = treatments.find(t => t.id === form.treatment_id)
    await fetch(`/admin/clinics/${clinic.id}/product-mappings`, {
      method: "POST", credentials: "include",
      headers: adminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        tenant_domain: clinic.domains?.[0] || clinic.slug,
        product_id: form.product_id,
        product_title: product?.title || "",
        treatment_id: form.treatment_id,
        treatment_name: treatment?.name || "",
        requires_eligibility: true,
      }),
    })
    setForm({ product_id: "", treatment_id: 0 })
    loadMappings()
  }

  const mappedProductIds = new Set(mappings.map(m => m.product_id))
  const unmappedProducts = products.filter(p => !mappedProductIds.has(p.id))

  return (
    <div>
      {/* Warning: products with no mapping */}
      {products.length > 0 && unmappedProducts.length > 0 && (
        <div style={{
          display: "flex", alignItems: "flex-start", gap: 10,
          background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 10,
          padding: "12px 16px", marginBottom: 20,
        }}>
          <span style={{ fontSize: 18, flexShrink: 0, marginTop: 1 }}>⚠️</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#92400e", marginBottom: 4 }}>
              {unmappedProducts.length} product{unmappedProducts.length !== 1 ? "s" : ""} not yet mapped to a treatment
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 8px" }}>
              {unmappedProducts.map(p => (
                <span key={p.id} style={{
                  fontSize: 11, fontWeight: 600, background: "#fef3c7",
                  color: "#92400e", border: "1px solid #fcd34d",
                  borderRadius: 6, padding: "2px 8px",
                }}>
                  {p.title}
                </span>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "#b45309", marginTop: 6 }}>
              Orders containing unmapped products will bypass provider review and go directly to pharmacy.
            </div>
          </div>
        </div>
      )}

      {products.length > 0 && unmappedProducts.length === 0 && mappings.length > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10,
          padding: "10px 16px", marginBottom: 20,
        }}>
          <span style={{ fontSize: 16 }}>✓</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#166534" }}>All products are mapped to a treatment</span>
        </div>
      )}

      {mappings.length > 0 && (
        <table style={{ ...s.table, marginBottom: 24 }}>
          <thead>
            <tr>{["Product", "Treatment", "Eligibility Required", ""].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {mappings.map(m => (
              <tr key={m.id}>
                <td style={s.td}>{m.product_title || m.product_id}</td>
                <td style={s.td}>{m.treatment_name || m.treatment_id}</td>
                <td style={s.td}>
                  <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: m.requires_eligibility ? "#dbeafe" : "#f3f4f6", color: m.requires_eligibility ? "#1e40af" : "#6b7280" }}>
                    {m.requires_eligibility ? "Yes" : "No"}
                  </span>
                </td>
                <td style={s.td}>
                  <button onClick={async () => {
                    await fetch(`/admin/clinics/${clinic.id}/product-mappings/${m.id}`, { method: "DELETE", credentials: "include", headers: adminHeaders() })
                    loadMappings()
                  }} style={s.btnDanger}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={s.formBox}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Add Product → Treatment Mapping</div>
        {treatments.length === 0 && (
          <div style={{ marginBottom: 12 }}>
            <button onClick={loadTreatments} disabled={loadingTreatments} style={s.btnOutline}>
              {loadingTreatments ? "Loading…" : "Load Treatments from API"}
            </button>
            <span style={{ fontSize: 12, color: "#9ca3af", marginLeft: 8 }}>Requires valid API credentials</span>
          </div>
        )}
        <div style={s.grid2}>
          <Field label="Product">
            <select style={s.input} value={form.product_id} onChange={e => setForm(p => ({ ...p, product_id: e.target.value }))}>
              <option value="">Select product…</option>
              {unmappedProducts.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </Field>
          <Field label="Treatment">
            <select style={s.input} value={form.treatment_id} onChange={e => setForm(p => ({ ...p, treatment_id: Number(e.target.value) }))}>
              <option value={0}>Select treatment…</option>
              {treatments.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        </div>
        {unmappedProducts.length === 0 && products.length > 0 && (
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 8 }}>All products have been mapped.</div>
        )}
        <button onClick={addMapping} disabled={!form.product_id || !form.treatment_id}
          style={{ ...s.btnPrimary, marginTop: 12, opacity: (!form.product_id || !form.treatment_id) ? 0.5 : 1 }}>
          + Add Mapping
        </button>
      </div>
    </div>
  )
}

// ── Orders Tab ─────────────────────────────────────────────────────────────
function OrdersTab({
  clinic, role, currentUser, defaultFilter
}: {
  clinic: Clinic
  role: string
  currentUser: CurrentUser | null
  defaultFilter: string
}) {
  const [orders, setOrders] = useState<Order[]>([])
  const [filterStatus, setFilterStatus] = useState(defaultFilter)
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [mdNotes, setMdNotes] = useState("")
  const [tracking, setTracking] = useState({ number: "", carrier: "UPS" })
  const [processing, setProcessing] = useState(false)
  const [orderToDelete, setOrderToDelete] = useState<Order | null>(null)
  const [commentOrder, setCommentOrder] = useState<Order | null>(null)
  const [reminderSending, setReminderSending] = useState<string | null>(null)
  const [reminderMsg, setReminderMsg] = useState<{ orderId: string; ok: boolean; text: string } | null>(null)

  useEffect(() => { loadOrders() }, [clinic.id, filterStatus])

  const loadOrders = async () => {
    try {
      const url = `/admin/clinics/${clinic.id}/orders${filterStatus ? `?status=${filterStatus}` : ""}`
      const res = await fetch(url, { credentials: "include", headers: adminHeaders() })
      const data = await res.json()
      setOrders(data.orders || [])
    } catch {}
  }

  const mdDecision = async (decision: "approved" | "denied") => {
    if (!selectedOrder) return
    setProcessing(true)
    try {
      await fetch(`/admin/clinics/${clinic.id}/orders/${selectedOrder.order_id}/md-decision`, {
        method: "POST", credentials: "include",
        headers: adminHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ decision, notes: mdNotes, md_user_id: currentUser?.id || "unknown" }),
      })
      setSelectedOrder(null); setMdNotes(""); loadOrders()
    } catch {}
    finally { setProcessing(false) }
  }

  const markShipped = async () => {
    if (!selectedOrder || !tracking.number) return
    setProcessing(true)
    try {
      await fetch(`/admin/clinics/${clinic.id}/orders/${selectedOrder.order_id}/ship`, {
        method: "POST", credentials: "include",
        headers: adminHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ tracking_number: tracking.number, carrier: tracking.carrier, pharmacist_user_id: currentUser?.id || "unknown" }),
      })
      setSelectedOrder(null); setTracking({ number: "", carrier: "UPS" }); loadOrders()
    } catch {}
    finally { setProcessing(false) }
  }

  const deleteOrder = async () => {
    if (!orderToDelete) return
    setProcessing(true)
    try {
      await fetch(`/admin/orders/${orderToDelete.order_id}/cancel`, { method: "POST", credentials: "include", headers: adminHeaders() })
      await fetch(`/admin/clinics/${clinic.id}/orders/${orderToDelete.order_id}`, { method: "DELETE", credentials: "include", headers: adminHeaders() })
      setOrderToDelete(null)
      loadOrders()
    } catch {}
    finally { setProcessing(false) }
  }

  const canDelete = role === "super_admin" || role === "clinic_admin"
  const canMdReview = role === "super_admin" || role === "medical_director"
  const canShip = role === "super_admin" || role === "pharmacist"

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <select style={{ ...s.input, width: "auto", minWidth: 200 }}
          value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="">All Orders</option>
          {Object.entries(STATUS_META).map(([val, info]) => (
            <option key={val} value={val}>{info.label}</option>
          ))}
        </select>
      </div>

      {orders.length === 0 ? (
        <EmptyState icon="📋" message="No orders found for this filter" />
      ) : (
        <table style={s.table}>
          <thead>
            <tr>
              {["Order #", "Patient", "Status", "Provider", "Date", "Actions"].map(h => <th key={h} style={s.th}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {orders.map(o => {
              const si = STATUS_META[o.status] || { label: o.status, color: "#374151", bg: "#f3f4f6" }
              return (
                <tr key={o.id}>
                  <td style={{ ...s.td, fontWeight: 600 }}>#{o.display_id || o.order_id?.slice(0, 8)}</td>
                  <td style={s.td}>{o.patient_name?.trim() || o.patient_email || "—"}</td>
                  <td style={s.td}>
                    <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: si.bg, color: si.color }}>
                      {si.label}
                    </span>
                  </td>
                  <td style={s.td}>{o.provider_name || "—"}</td>
                  <td style={s.td}>{o.created_at ? new Date(o.created_at).toLocaleDateString() : "—"}</td>
                  <td style={{ ...s.td, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    {canMdReview && o.status === "provider_deferred" && (
                      <button onClick={() => { setSelectedOrder(o); setMdNotes("") }} style={s.btnAction}>MD Review</button>
                    )}
                    {canShip && (o.status === "sent_to_pharmacy" || o.status === "pharmacy_processing" || o.status === "processing_pharmacy" || o.status === "pending_pharmacy") && (
                      <button onClick={() => { setSelectedOrder(o); setTracking({ number: "", carrier: "UPS" }) }} style={s.btnAction}>Ship</button>
                    )}
                    {o.status === "shipped" && o.tracking_number && (
                      <span style={{ fontSize: 11, color: "#6b7280" }}>{o.carrier}: {o.tracking_number}</span>
                    )}
                    {/* Comment button — all roles */}
                    <button onClick={() => setCommentOrder(o)} style={{ ...s.btnAction, color: "#6b7280" }} title="Add comment">💬</button>
                    {canDelete && (
                      <button onClick={() => setOrderToDelete(o)} style={{ ...s.btnDanger, padding: "4px 8px" }} title="Delete">🗑</button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {/* Comment Modal */}
      {commentOrder && (
        <CommentModal
          clinic={clinic}
          order={commentOrder}
          currentUser={currentUser}
          role={role}
          onClose={() => setCommentOrder(null)}
        />
      )}

      {/* Delete Modal */}
      {orderToDelete && (
        <Modal onClose={() => setOrderToDelete(null)}>
          <h3 style={s.modalTitle}>Delete Order</h3>
          <p style={s.modalSubtitle}>This will cancel and permanently remove this order.</p>
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: 12, marginBottom: 16 }}>
            <div style={{ fontSize: 13, color: "#dc2626" }}>
              <strong>Order:</strong> {orderToDelete.order_id?.slice(0, 20)}…<br />
              <strong>Status:</strong> {STATUS_META[orderToDelete.status]?.label || orderToDelete.status}
            </div>
          </div>
          <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 16 }}>⚠️ This cannot be undone.</p>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={deleteOrder} disabled={processing} style={{ ...s.btnPrimary, background: "#dc2626" }}>
              {processing ? "Deleting…" : "🗑 Yes, Delete"}
            </button>
            <button onClick={() => setOrderToDelete(null)} style={s.btnOutline}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* MD Review Modal */}
      {selectedOrder?.status === "provider_deferred" && (
        <Modal onClose={() => setSelectedOrder(null)}>
          <h3 style={s.modalTitle}>Medical Director Review</h3>
          <p style={s.modalSubtitle}>Order {selectedOrder.order_id?.slice(0, 14)}… — Patient #{selectedOrder.patient_id}</p>
          {selectedOrder.provider_name && (
            <div style={{ fontSize: 13, marginBottom: 12 }}>Deferred by: <strong>{selectedOrder.provider_name}</strong></div>
          )}
          {selectedOrder.treatment_dosages && selectedOrder.treatment_dosages.length > 0 && (
            <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "#9a3412", marginBottom: 8 }}>💊 Proposed Dosages</div>
              {selectedOrder.treatment_dosages.map((td, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                  <span style={{ fontSize: 13 }}>{td.treatmentName}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#9a3412" }}>{td.dosage || "—"}</span>
                </div>
              ))}
            </div>
          )}
          <Field label="Review Notes (optional)">
            <textarea style={{ ...s.input, height: 80, resize: "vertical" }}
              value={mdNotes} onChange={e => setMdNotes(e.target.value)} placeholder="Add notes…" />
          </Field>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button onClick={() => mdDecision("approved")} disabled={processing} style={{ ...s.btnPrimary, background: "#10b981" }}>✓ Approve → Pharmacy</button>
            <button onClick={() => mdDecision("denied")} disabled={processing} style={{ ...s.btnPrimary, background: "#ef4444" }}>✗ Deny → Refund</button>
            <button onClick={() => setSelectedOrder(null)} style={s.btnOutline}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* Ship Modal */}
      {selectedOrder && (selectedOrder.status === "sent_to_pharmacy" || selectedOrder.status === "pharmacy_processing" || selectedOrder.status === "processing_pharmacy" || selectedOrder.status === "pending_pharmacy") && (
        <Modal onClose={() => setSelectedOrder(null)}>
          <h3 style={s.modalTitle}>Mark as Shipped</h3>
          <p style={s.modalSubtitle}>Order {selectedOrder.order_id?.slice(0, 14)}… — Patient #{selectedOrder.patient_id}</p>
          {selectedOrder.treatment_dosages && selectedOrder.treatment_dosages.length > 0 && (
            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: 12, marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "#166534", marginBottom: 8 }}>💊 Provider-Approved Dosages</div>
              {selectedOrder.treatment_dosages.map((td, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: i < selectedOrder.treatment_dosages!.length - 1 ? "1px solid #d1fae5" : "none" }}>
                  <span style={{ fontSize: 13 }}>{td.treatmentName}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#166534", background: "#dcfce7", padding: "2px 10px", borderRadius: 12 }}>{td.dosage || "No dosage specified"}</span>
                </div>
              ))}
            </div>
          )}
          <div style={s.grid2}>
            <Field label="Carrier">
              <select style={s.input} value={tracking.carrier} onChange={e => setTracking(p => ({ ...p, carrier: e.target.value }))}>
                {["UPS","FedEx","USPS","DHL"].map(c => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Tracking Number">
              <input style={s.input} value={tracking.number} onChange={e => setTracking(p => ({ ...p, number: e.target.value }))} placeholder="Tracking number" />
            </Field>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button onClick={markShipped} disabled={processing || !tracking.number} style={{ ...s.btnPrimary, opacity: !tracking.number ? 0.5 : 1 }}>Confirm Shipment</button>
            <button onClick={() => setSelectedOrder(null)} style={s.btnOutline}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── Comment Modal ──────────────────────────────────────────────────────────
function CommentModal({
  clinic, order, currentUser, role, onClose
}: {
  clinic: Clinic
  order: Order
  currentUser: CurrentUser | null
  role: string
  onClose: () => void
}) {
  const [comments, setComments] = useState<Comment[]>([])
  const [newComment, setNewComment] = useState("")
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => { loadComments() }, [])

  const loadComments = async () => {
    try {
      const res = await fetch(`/admin/clinics/${clinic.id}/orders/${order.order_id}/comments`, {
        credentials: "include", headers: adminHeaders()
      })
      const data = await res.json()
      setComments(data.comments || [])
    } catch {}
    finally { setLoading(false) }
  }

  const addComment = async () => {
    if (!newComment.trim()) return
    setSaving(true)
    try {
      await fetch(`/admin/clinics/${clinic.id}/orders/${order.order_id}/comments`, {
        method: "POST", credentials: "include",
        headers: adminHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          comment: newComment,
          user_id: currentUser?.id || "unknown",
          user_email: currentUser?.email || "",
          user_name: `${currentUser?.first_name || ""} ${currentUser?.last_name || ""}`.trim(),
          role,
        }),
      })
      setNewComment("")
      loadComments()
    } catch {}
    finally { setSaving(false) }
  }

  const roleColors: Record<string, string> = {
    super_admin: "#111",
    clinic_admin: "#374151",
    medical_director: "#7c3aed",
    pharmacist: "#1e40af",
  }

  return (
    <Modal onClose={onClose}>
      <h3 style={s.modalTitle}>💬 Order Comments</h3>
      <p style={s.modalSubtitle}>Order {order.order_id?.slice(0, 14)}… — Patient #{order.patient_id}</p>

      {/* Comments list */}
      <div style={{ maxHeight: 300, overflowY: "auto", marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        {loading ? (
          <div style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: 16 }}>Loading…</div>
        ) : comments.length === 0 ? (
          <div style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: 16 }}>No comments yet</div>
        ) : comments.map(c => (
          <div key={c.id} style={{ background: "#f9fafb", borderRadius: 8, padding: "10px 12px", border: "1px solid #f3f4f6" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{c.user_name || c.user_email}</span>
                <span style={{
                  padding: "1px 8px", borderRadius: 10, fontSize: 10, fontWeight: 600,
                  background: c.role === "medical_director" ? "#ede9fe" : c.role === "pharmacist" ? "#dbeafe" : "#f3f4f6",
                  color: roleColors[c.role] || "#374151",
                }}>
                  {ROLE_LABELS[c.role] || c.role}
                </span>
              </div>
              <span style={{ fontSize: 11, color: "#9ca3af" }}>
                {new Date(c.created_at).toLocaleString()}
              </span>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: "#374151", lineHeight: 1.5 }}>{c.comment}</p>
          </div>
        ))}
      </div>

      {/* New comment input */}
      <Field label="Add Comment">
        <textarea
          style={{ ...s.input, height: 80, resize: "vertical" }}
          value={newComment}
          onChange={e => setNewComment(e.target.value)}
          placeholder="Write a comment…"
        />
      </Field>
      <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
        <button onClick={addComment} disabled={saving || !newComment.trim()}
          style={{ ...s.btnPrimary, opacity: !newComment.trim() ? 0.5 : 1 }}>
          {saving ? "Saving…" : "Add Comment"}
        </button>
        <button onClick={onClose} style={s.btnOutline}>Close</button>
      </div>
    </Modal>
  )
}

// ── UI Config Tab ─────────────────────────────────────────────────────────
function UiConfigTab({ clinic }: { clinic: Clinic }) {
  const BLANK_LINK: NavLink = { label: "", url: "", open_new_tab: false }
  const blankConfig = (): UiConfig => ({
    tenant_domain: clinic.domains?.[0] || clinic.slug,
    nav_links: [],
    footer_links: [],
    bottom_links: [],
    logo_url: "",
    get_started_url: "",
    contact_phone: "",
    contact_email: "",
    contact_address: "",
    social_links: [],
    certification_image_url: "",
  })

  const [config, setConfig] = useState<UiConfig>(blankConfig())
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState("")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Reset form immediately when clinic changes
    setConfig(blankConfig())
    setStatus("")
    setLoading(true)

    fetch(`/admin/clinics/${clinic.id}/ui-config`, { credentials: "include" })
      .then(r => r.json())
      .then(d => {
        if (d.config) {
          setConfig({
            tenant_domain: clinic.domains?.[0] || clinic.slug,
            nav_links: d.config.nav_links || [],
            footer_links: d.config.footer_links || [],
            bottom_links: d.config.bottom_links || [],
            logo_url: d.config.logo_url || "",
            get_started_url: d.config.get_started_url || "",
            contact_phone: d.config.contact_phone || "",
            contact_email: d.config.contact_email || "",
            contact_address: d.config.contact_address || "",
            social_links: d.config.social_links || [],
            certification_image_url: d.config.certification_image_url || "",
          })
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [clinic.id])

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch(`/admin/clinics/${clinic.id}/ui-config`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      })
      setStatus(res.ok ? "saved" : "error")
    } catch { setStatus("error") }
    finally { setSaving(false) }
  }

  const updateLink = (section: "nav_links" | "footer_links", idx: number, field: keyof NavLink, val: any) => {
    setConfig(p => {
      const links = [...p[section]]
      links[idx] = { ...links[idx], [field]: val }
      return { ...p, [section]: links }
    })
  }

  const addLink = (section: "nav_links" | "footer_links") =>
    setConfig(p => ({ ...p, [section]: [...p[section], { ...BLANK_LINK }] }))

  const removeLink = (section: "nav_links" | "footer_links", idx: number) =>
    setConfig(p => ({ ...p, [section]: p[section].filter((_, i) => i !== idx) }))

  const addChildLink = (section: "nav_links" | "footer_links", parentIdx: number) =>
    setConfig(p => {
      const links = [...p[section]]
      links[parentIdx] = { ...links[parentIdx], children: [...(links[parentIdx].children || []), { ...BLANK_LINK }] }
      return { ...p, [section]: links }
    })

  const updateChildLink = (section: "nav_links" | "footer_links", parentIdx: number, childIdx: number, field: keyof NavLink, val: any) =>
    setConfig(p => {
      const links = [...p[section]]
      const children = [...(links[parentIdx].children || [])]
      children[childIdx] = { ...children[childIdx], [field]: val }
      links[parentIdx] = { ...links[parentIdx], children }
      return { ...p, [section]: links }
    })

  const removeChildLink = (section: "nav_links" | "footer_links", parentIdx: number, childIdx: number) =>
    setConfig(p => {
      const links = [...p[section]]
      links[parentIdx] = { ...links[parentIdx], children: (links[parentIdx].children || []).filter((_, i) => i !== childIdx) }
      return { ...p, [section]: links }
    })

  const renderLinkSection = (section: "nav_links" | "footer_links", title: string) => (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>{title}</div>
        <button onClick={() => addLink(section)} style={s.btnOutline}>+ Add Link</button>
      </div>
      {config[section].length === 0 ? (
        <div style={{ fontSize: 13, color: "#9ca3af", padding: "12px 0" }}>No links added yet</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {config[section].map((link, idx) => (
            <div key={idx} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#fafafa" }}>
              {/* Parent row */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto auto auto", gap: 8, alignItems: "center" }}>
                <input style={s.input} placeholder="Label (e.g. About)"
                  value={link.label} onChange={e => updateLink(section, idx, "label", e.target.value)} />
                <input style={s.input} placeholder="URL (leave blank if dropdown only)"
                  value={link.url} onChange={e => updateLink(section, idx, "url", e.target.value)} />
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#6b7280", whiteSpace: "nowrap", cursor: "pointer" }}>
                  <input type="checkbox" checked={!!link.open_new_tab}
                    onChange={e => updateLink(section, idx, "open_new_tab", e.target.checked)} />
                  New tab
                </label>
                <button onClick={() => addChildLink(section, idx)} style={{ ...s.btnOutline, fontSize: 11, padding: "4px 8px", whiteSpace: "nowrap" }} title="Add child link">+ Child</button>
                <button onClick={() => removeLink(section, idx)} style={s.btnDanger}>×</button>
              </div>
              {/* Child links */}
              {(link.children || []).length > 0 && (
                <div style={{ marginTop: 8, paddingLeft: 16, display: "flex", flexDirection: "column", gap: 6, borderLeft: "2px solid #e5e7eb" }}>
                  {(link.children || []).map((child, ci) => (
                    <div key={ci} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto auto", gap: 8, alignItems: "center" }}>
                      <input style={{ ...s.input, fontSize: 12 }} placeholder="Child label"
                        value={child.label} onChange={e => updateChildLink(section, idx, ci, "label", e.target.value)} />
                      <input style={{ ...s.input, fontSize: 12 }} placeholder="Child URL"
                        value={child.url} onChange={e => updateChildLink(section, idx, ci, "url", e.target.value)} />
                      <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#6b7280", whiteSpace: "nowrap", cursor: "pointer" }}>
                        <input type="checkbox" checked={!!child.open_new_tab}
                          onChange={e => updateChildLink(section, idx, ci, "open_new_tab", e.target.checked)} />
                        New tab
                      </label>
                      <button onClick={() => removeChildLink(section, idx, ci)} style={s.btnDanger}>×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )

  if (loading) return <div style={{ color: "#9ca3af", padding: 24 }}>Loading…</div>

  const SOCIAL_PLATFORMS = ["Facebook", "Instagram", "TikTok", "Twitter/X", "YouTube", "LinkedIn", "Pinterest", "Snapchat"]

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 8, padding: "12px 16px", fontSize: 13, color: "#0369a1" }}>
        💡 Define the navigation and footer links for <strong>{clinic.name}</strong>'s storefront.
        These are served via <code>/store/clinics/ui-config</code> and rendered by the storefront automatically.
      </div>

      {/* Branding */}
      <div style={s.grid2}>
        <Field label="Logo URL">
          <input style={s.input} value={config.logo_url} placeholder="https://..."
            onChange={e => setConfig(p => ({ ...p, logo_url: e.target.value }))} />
        </Field>
        <Field label="Get Started URL">
          <input style={s.input} value={config.get_started_url} placeholder="https://..."
            onChange={e => setConfig(p => ({ ...p, get_started_url: e.target.value }))} />
        </Field>
      </div>

      {/* Contact Info */}
      <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#111", marginBottom: 12 }}>📞 Contact Information</div>
        <div style={s.grid2}>
          <Field label="Phone">
            <input style={s.input} value={config.contact_phone} placeholder="(956) 766-0051"
              onChange={e => setConfig(p => ({ ...p, contact_phone: e.target.value }))} />
          </Field>
          <Field label="Email">
            <input style={s.input} value={config.contact_email} placeholder="support@yourclinic.com"
              onChange={e => setConfig(p => ({ ...p, contact_email: e.target.value }))} />
          </Field>
        </div>
        <Field label="Address (use line breaks for multi-line)">
          <textarea style={{ ...s.input, height: 72, resize: "vertical", fontFamily: "inherit" }}
            value={config.contact_address} placeholder={"1907 N. Veterans Blvd.\nPharr, Texas 78577\nSuite B"}
            onChange={e => setConfig(p => ({ ...p, contact_address: e.target.value }))} />
        </Field>
      </div>

      {/* Social Links */}
      <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>🌐 Social Media Links</div>
          <button onClick={() => setConfig(p => ({ ...p, social_links: [...p.social_links, { platform: "Facebook", url: "" }] }))} style={s.btnOutline}>+ Add Social</button>
        </div>
        {config.social_links.length === 0 ? (
          <div style={{ fontSize: 13, color: "#9ca3af", padding: "8px 0" }}>No social links added yet</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {config.social_links.map((sl, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "160px 1fr auto", gap: 8, alignItems: "center" }}>
                <select style={s.input} value={sl.platform}
                  onChange={e => setConfig(p => { const sl2 = [...p.social_links]; sl2[i] = { ...sl2[i], platform: e.target.value }; return { ...p, social_links: sl2 } })}>
                  {SOCIAL_PLATFORMS.map(pl => <option key={pl}>{pl}</option>)}
                </select>
                <input style={s.input} placeholder="https://facebook.com/yourclinic" value={sl.url}
                  onChange={e => setConfig(p => { const sl2 = [...p.social_links]; sl2[i] = { ...sl2[i], url: e.target.value }; return { ...p, social_links: sl2 } })} />
                <button onClick={() => setConfig(p => ({ ...p, social_links: p.social_links.filter((_, j) => j !== i) }))} style={s.btnDanger}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Certification Image */}
      <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#111", marginBottom: 12 }}>🏅 Certification / Badge Image</div>
        <Field label="Image URL (shown below contact info in footer)">
          <input style={s.input} value={config.certification_image_url} placeholder="https://... (e.g. compounded-in-usa badge)"
            onChange={e => setConfig(p => ({ ...p, certification_image_url: e.target.value }))} />
        </Field>
        {config.certification_image_url && (
          <img src={config.certification_image_url} alt="Certification badge preview" style={{ marginTop: 8, maxHeight: 80, maxWidth: 160, objectFit: "contain", border: "1px solid #e5e7eb", borderRadius: 6, padding: 4 }} />
        )}
      </div>

      {renderLinkSection("nav_links", "🔗 Navigation Links")}
      {renderLinkSection("footer_links", "📎 Footer Links")}

      {/* Bottom Bar Links */}
      <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>📋 Bottom Bar Links</div>
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>Shown in the thin bar at the very bottom of the footer (e.g. Terms, Privacy, Consent)</div>
          </div>
          <button onClick={() => setConfig(p => ({ ...p, bottom_links: [...p.bottom_links, { ...BLANK_LINK }] }))} style={s.btnOutline}>+ Add Link</button>
        </div>
        {config.bottom_links.length === 0 ? (
          <div style={{ fontSize: 13, color: "#9ca3af", padding: "8px 0" }}>No bottom links added yet</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {config.bottom_links.map((link, idx) => (
              <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto auto", gap: 8, alignItems: "center" }}>
                <input style={s.input} placeholder="Label (e.g. Privacy Policy)"
                  value={link.label} onChange={e => setConfig(p => { const bl = [...p.bottom_links]; bl[idx] = { ...bl[idx], label: e.target.value }; return { ...p, bottom_links: bl } })} />
                <input style={s.input} placeholder="URL"
                  value={link.url} onChange={e => setConfig(p => { const bl = [...p.bottom_links]; bl[idx] = { ...bl[idx], url: e.target.value }; return { ...p, bottom_links: bl } })} />
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#6b7280", whiteSpace: "nowrap", cursor: "pointer" }}>
                  <input type="checkbox" checked={!!link.open_new_tab}
                    onChange={e => setConfig(p => { const bl = [...p.bottom_links]; bl[idx] = { ...bl[idx], open_new_tab: e.target.checked }; return { ...p, bottom_links: bl } })} />
                  New tab
                </label>
                <button onClick={() => setConfig(p => ({ ...p, bottom_links: p.bottom_links.filter((_, i) => i !== idx) }))} style={s.btnDanger}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <SaveBar saving={saving} status={status} onSave={save} />
    </div>
  )
}

// ── Pharmacy Tab ──────────────────────────────────────────────────────────
function PharmacyTab({ clinic, onUpdated }: { clinic: Clinic; onUpdated: () => void }) {
  const ca = clinic as any
  const [form, setForm] = useState({
    pharmacy_type: ca.pharmacy_type || "digitalrx",
    pharmacy_api_url: ca.pharmacy_api_url || "",
    pharmacy_api_key: ca.pharmacy_api_key || "",
    pharmacy_store_id: ca.pharmacy_store_id || "",
    pharmacy_vendor_name: ca.pharmacy_vendor_name || "",
    pharmacy_doctor_first_name: ca.pharmacy_doctor_first_name || "",
    pharmacy_doctor_last_name: ca.pharmacy_doctor_last_name || "",
    pharmacy_doctor_npi: ca.pharmacy_doctor_npi || "",
    pharmacy_enabled: ca.pharmacy_enabled === true,
    // RMM fields
    pharmacy_username: ca.pharmacy_username || "",
    pharmacy_password: ca.pharmacy_password || "",
    pharmacy_prescriber_id: ca.pharmacy_prescriber_id || "",
    pharmacy_prescriber_address: ca.pharmacy_prescriber_address || "",
    pharmacy_prescriber_city: ca.pharmacy_prescriber_city || "",
    pharmacy_prescriber_state: ca.pharmacy_prescriber_state || "",
    pharmacy_prescriber_zip: ca.pharmacy_prescriber_zip || "",
    pharmacy_prescriber_phone: ca.pharmacy_prescriber_phone || "",
    pharmacy_prescriber_dea: ca.pharmacy_prescriber_dea || "",
    pharmacy_ship_type: ca.pharmacy_ship_type || "ship_to_patient",
    pharmacy_ship_rate: ca.pharmacy_ship_rate || "2_day",
    pharmacy_pay_type: ca.pharmacy_pay_type || "patient_pay",
  })
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState("")
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  // Sync form when clinic data changes (e.g. after save + reload)
  useEffect(() => {
    const c = clinic as any
    setForm({
      pharmacy_type: c.pharmacy_type || "digitalrx",
      pharmacy_api_url: c.pharmacy_api_url || "",
      pharmacy_api_key: c.pharmacy_api_key || "",
      pharmacy_store_id: c.pharmacy_store_id || "",
      pharmacy_vendor_name: c.pharmacy_vendor_name || "",
      pharmacy_doctor_first_name: c.pharmacy_doctor_first_name || "",
      pharmacy_doctor_last_name: c.pharmacy_doctor_last_name || "",
      pharmacy_doctor_npi: c.pharmacy_doctor_npi || "",
      pharmacy_enabled: c.pharmacy_enabled === true,
      pharmacy_username: c.pharmacy_username || "",
      pharmacy_password: c.pharmacy_password || "",
      pharmacy_prescriber_id: c.pharmacy_prescriber_id || "",
      pharmacy_prescriber_address: c.pharmacy_prescriber_address || "",
      pharmacy_prescriber_city: c.pharmacy_prescriber_city || "",
      pharmacy_prescriber_state: c.pharmacy_prescriber_state || "",
      pharmacy_prescriber_zip: c.pharmacy_prescriber_zip || "",
      pharmacy_prescriber_phone: c.pharmacy_prescriber_phone || "",
      pharmacy_prescriber_dea: c.pharmacy_prescriber_dea || "",
      pharmacy_ship_type: c.pharmacy_ship_type || "ship_to_patient",
      pharmacy_ship_rate: c.pharmacy_ship_rate || "2_day",
      pharmacy_pay_type: c.pharmacy_pay_type || "patient_pay",
    })
  }, [clinic.id])

  const isRmm = form.pharmacy_type === "rmm"
  const isDigitalRx = form.pharmacy_type === "digitalrx" || form.pharmacy_type === "custom"

  const RMM_URLS = {
    sandbox: "https://requestmymeds.net/api/v2/sandbox",
    production: "https://requestmymeds.net/api/v2",
  }
  const DIGITALRX_URL = "https://www.dbswebserver.com/DBSRestApi/API"

  const handleTypeChange = (newType: string) => {
    setForm(p => ({
      ...p,
      pharmacy_type: newType,
      // Auto-set URL when switching types
      pharmacy_api_url: newType === "rmm" ? RMM_URLS.sandbox : newType === "digitalrx" ? DIGITALRX_URL : p.pharmacy_api_url,
    }))
  }

  const rmmEnv = form.pharmacy_api_url?.includes("sandbox") ? "sandbox" : "production"

  const save = async () => {
    setSaving(true); setStatus("")
    try {
      const res = await fetch(`/admin/clinics/${clinic.id}`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      if (res.ok) { setStatus("saved"); onUpdated() } else { setStatus("error") }
    } catch { setStatus("error") }
    finally { setSaving(false) }
  }

  const testConnection = async () => {
    setTesting(true); setTestResult(null)
    try {
      const res = await fetch(`/admin/clinics/${clinic.id}/test-pharmacy`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pharmacy_type: form.pharmacy_type,
          pharmacy_api_url: form.pharmacy_api_url,
          pharmacy_api_key: form.pharmacy_api_key,
          pharmacy_store_id: form.pharmacy_store_id,
          pharmacy_username: form.pharmacy_username,
          pharmacy_password: form.pharmacy_password,
        }),
      })
      const data = await res.json()
      setTestResult(data.success ? "✓ " + data.message : "✗ " + data.message)
    } catch (e: any) {
      setTestResult("✗ Connection failed: " + e.message)
    }
    finally { setTesting(false) }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: "#6b7280", letterSpacing: "0.05em" }}>
        Pharmacy API Integration
      </div>

      {/* Enable toggle */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: form.pharmacy_enabled ? "#f0fdf4" : "#f9fafb", borderRadius: 8, border: `1px solid ${form.pharmacy_enabled ? "#bbf7d0" : "#e5e7eb"}` }}>
        <div onClick={() => setForm(p => ({ ...p, pharmacy_enabled: !p.pharmacy_enabled }))} style={{
          width: 40, height: 22, borderRadius: 11, background: form.pharmacy_enabled ? "#10b981" : "#d1d5db",
          position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0,
        }}>
          <div style={{
            position: "absolute", top: 3, left: form.pharmacy_enabled ? 21 : 3,
            width: 16, height: 16, borderRadius: "50%", background: "#fff",
            transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          }} />
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {form.pharmacy_enabled ? "Pharmacy API Enabled" : "Pharmacy API Disabled"}
          </div>
          <div style={{ fontSize: 12, color: "#6b7280" }}>
            {form.pharmacy_enabled
              ? "Orders will be automatically submitted to the pharmacy API when approved."
              : "Orders will require manual pharmacy processing. Credentials are saved but not used."}
          </div>
        </div>
      </div>

      <Field label="Pharmacy Type">
        <select style={s.input} value={form.pharmacy_type} onChange={e => handleTypeChange(e.target.value)}>
          <option value="digitalrx">DigitalRX (SmartConnect)</option>
          <option value="rmm">Partell Pharmacy (RequestMyMeds)</option>
          <option value="custom">Custom</option>
        </select>
      </Field>

      {/* RMM environment selector */}
      {isRmm && (
        <Field label="Environment">
          <select style={s.input} value={rmmEnv} onChange={e => setForm(p => ({ ...p, pharmacy_api_url: RMM_URLS[e.target.value as "sandbox" | "production"] }))}>
            <option value="sandbox">Sandbox (Testing)</option>
            <option value="production">Production</option>
          </select>
        </Field>
      )}

      <Field label="API Base URL">
        <input style={s.input} value={form.pharmacy_api_url}
          onChange={e => setForm(p => ({ ...p, pharmacy_api_url: e.target.value }))}
          placeholder={isRmm ? "https://requestmymeds.net/api/v2/sandbox" : "https://www.dbswebserver.com/DBSRestApi/API"} />
        <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 3 }}>Base URL without trailing slash</div>
      </Field>

      {/* DigitalRX fields */}
      {isDigitalRx && (<>
        <Field label="API Key (Authorization Header)">
          <input style={s.input} value={form.pharmacy_api_key} onChange={e => setForm(p => ({ ...p, pharmacy_api_key: e.target.value }))} placeholder="Your pharmacy API key" />
        </Field>
        <Field label="Store ID">
          <input style={s.input} value={form.pharmacy_store_id} onChange={e => setForm(p => ({ ...p, pharmacy_store_id: e.target.value }))} placeholder="e.g. 190190" />
        </Field>
        <Field label="Vendor Name">
          <input style={s.input} value={form.pharmacy_vendor_name} onChange={e => setForm(p => ({ ...p, pharmacy_vendor_name: e.target.value }))} placeholder="Your company name" />
        </Field>
      </>)}

      {/* RMM fields */}
      {isRmm && (<>
        <div style={s.grid2}>
          <Field label="Username">
            <input style={s.input} value={form.pharmacy_username} onChange={e => setForm(p => ({ ...p, pharmacy_username: e.target.value }))} placeholder="RMM username" />
          </Field>
          <Field label="Password">
            <input style={s.input} type="password" value={form.pharmacy_password} onChange={e => setForm(p => ({ ...p, pharmacy_password: e.target.value }))} placeholder="RMM password" />
          </Field>
        </div>
        <Field label="Clinic Name">
          <input style={s.input} value={form.pharmacy_vendor_name} onChange={e => setForm(p => ({ ...p, pharmacy_vendor_name: e.target.value }))} placeholder="Clinic name" />
        </Field>
        <div style={s.grid2}>
          <Field label="Pay Type">
            <select style={s.input} value={form.pharmacy_pay_type} onChange={e => setForm(p => ({ ...p, pharmacy_pay_type: e.target.value }))}>
              <option value="patient_pay">Patient Pay</option>
              <option value="clinic_pay">Clinic Pay</option>
            </select>
          </Field>
          <Field label="Ship Type">
            <select style={s.input} value={form.pharmacy_ship_type} onChange={e => setForm(p => ({ ...p, pharmacy_ship_type: e.target.value }))}>
              <option value="ship_to_patient">Ship to Patient</option>
              <option value="ship_to_clinic">Ship to Clinic</option>
            </select>
          </Field>
          <Field label="Ship Rate">
            <select style={s.input} value={form.pharmacy_ship_rate} onChange={e => setForm(p => ({ ...p, pharmacy_ship_rate: e.target.value }))}>
              <option value="2_day">2 Day</option>
              <option value="overnight">Overnight</option>
            </select>
          </Field>
        </div>
      </>)}

      {/* Prescriber info — shared but RMM needs more fields */}
      <div style={{ borderTop: "1px solid #f3f4f6", paddingTop: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: "#6b7280", letterSpacing: "0.05em", marginBottom: 12 }}>
          Prescribing Doctor / Prescriber Info
        </div>
        <div style={s.grid2}>
          <Field label="First Name">
            <input style={s.input} value={form.pharmacy_doctor_first_name} onChange={e => setForm(p => ({ ...p, pharmacy_doctor_first_name: e.target.value }))} placeholder="First name" />
          </Field>
          <Field label="Last Name">
            <input style={s.input} value={form.pharmacy_doctor_last_name} onChange={e => setForm(p => ({ ...p, pharmacy_doctor_last_name: e.target.value }))} placeholder="Last name" />
          </Field>
          <Field label="NPI (10 digits)">
            <input style={s.input} value={form.pharmacy_doctor_npi} onChange={e => setForm(p => ({ ...p, pharmacy_doctor_npi: e.target.value }))} placeholder="1234567890" />
          </Field>
          {isRmm && (<>
            <Field label="Prescriber ID (max 10 chars)">
              <input style={s.input} value={form.pharmacy_prescriber_id} onChange={e => setForm(p => ({ ...p, pharmacy_prescriber_id: e.target.value.slice(0, 10) }))} placeholder="e.g. DOC001" />
            </Field>
            <Field label="DEA Number">
              <input style={s.input} value={form.pharmacy_prescriber_dea} onChange={e => setForm(p => ({ ...p, pharmacy_prescriber_dea: e.target.value }))} placeholder="AB1234567" />
            </Field>
            <Field label="Phone">
              <input style={s.input} value={form.pharmacy_prescriber_phone} onChange={e => setForm(p => ({ ...p, pharmacy_prescriber_phone: e.target.value }))} placeholder="(123) 456-7890" />
            </Field>
            <Field label="Address">
              <input style={s.input} value={form.pharmacy_prescriber_address} onChange={e => setForm(p => ({ ...p, pharmacy_prescriber_address: e.target.value }))} placeholder="123 Main St" />
            </Field>
            <Field label="City">
              <input style={s.input} value={form.pharmacy_prescriber_city} onChange={e => setForm(p => ({ ...p, pharmacy_prescriber_city: e.target.value }))} placeholder="City" />
            </Field>
            <Field label="State">
              <input style={s.input} value={form.pharmacy_prescriber_state} onChange={e => setForm(p => ({ ...p, pharmacy_prescriber_state: e.target.value }))} placeholder="CA" maxLength={2} />
            </Field>
            <Field label="ZIP">
              <input style={s.input} value={form.pharmacy_prescriber_zip} onChange={e => setForm(p => ({ ...p, pharmacy_prescriber_zip: e.target.value }))} placeholder="90210" />
            </Field>
          </>)}
        </div>
      </div>

      {testResult && (
        <div style={{ fontSize: 13, padding: "8px 12px", borderRadius: 8, background: testResult.startsWith("✓") ? "#f0fdf4" : "#fef2f2", color: testResult.startsWith("✓") ? "#166534" : "#dc2626", border: `1px solid ${testResult.startsWith("✓") ? "#bbf7d0" : "#fecaca"}` }}>
          {testResult}
        </div>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={testConnection} disabled={testing || (!form.pharmacy_api_key && !form.pharmacy_username)} style={{ ...s.btnOutline, opacity: ((!form.pharmacy_api_key && !form.pharmacy_username) || testing) ? 0.5 : 1 }}>
          {testing ? "Testing..." : "Test Connection"}
        </button>
        <SaveBar saving={saving} status={status} onSave={save} inline />
      </div>
    </div>
  )
}

// ── Payouts Tab ───────────────────────────────────────────────────────────
function PayoutsTab({ clinic }: { clinic: Clinic }) {
  const [config, setConfig] = useState<any | null>(null)
  const [pending, setPending] = useState<Record<string, { total: number; count: number; entries: any[] }>>({
    clinic: { total: 0, count: 0, entries: [] },
    pharmacy: { total: 0, count: 0, entries: [] },
  })
  const [history, setHistory] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo]   = useState("")

  // Product costs state
  const [products, setProducts] = useState<{ id: string; title: string }[]>([])
  const [costEdits, setCostEdits] = useState<Record<string, string>>({})
  const [savingCosts, setSavingCosts] = useState(false)
  const [costsMsg, setCostsMsg] = useState("")

  const [editingConfig, setEditingConfig] = useState(false)
  const [configForm, setConfigForm] = useState({
    clinic_name: "", clinic_bank_routing: "", clinic_bank_account: "",
    clinic_bank_name: "", clinic_account_name: "",
    pharmacy_name: "", pharmacy_bank_routing: "", pharmacy_bank_account: "",
    pharmacy_bank_name: "", pharmacy_account_name: "",
    notes: "",
  })
  const [savingConfig, setSavingConfig] = useState(false)
  const [configError, setConfigError] = useState("")
  const [payingOut, setPayingOut] = useState<"clinic" | "pharmacy" | null>(null)
  const [payoutRef, setPayoutRef] = useState("")
  const [payoutNotes, setPayoutNotes] = useState("")
  const [payoutError, setPayoutError] = useState("")
  const [submittingPayout, setSubmittingPayout] = useState(false)
  const [successMsg, setSuccessMsg] = useState("")

  const load = async (from?: string, to?: string) => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (from) params.set("from", from)
      if (to)   params.set("to",   to)
      const qs = params.toString() ? `?${params}` : ""
      const [cfgRes, payRes] = await Promise.all([
        fetch(`/admin/clinics/${clinic.id}/payout-config`),
        fetch(`/admin/clinics/${clinic.id}/payouts${qs}`),
      ])
      const cfgData = await cfgRes.json()
      const payData = await payRes.json()
      setConfig(cfgData.config || null)
      setPending(payData.pending || { clinic: { total: 0, count: 0, entries: [] }, pharmacy: { total: 0, count: 0, entries: [] } })
      setHistory(payData.history || [])
    } catch { /* silent */ }
    setLoading(false)
  }

  const loadProductCosts = async () => {
    try {
      const [prodRes, costsRes] = await Promise.all([
        fetch(`/admin/products?sales_channel_id[]=${clinic.sales_channel_id}&limit=200&fields=id,title`),
        fetch(`/admin/clinics/${clinic.id}/product-costs`),
      ])
      const prodData  = await prodRes.json()
      const costsData = await costsRes.json()
      const prods: { id: string; title: string }[] = (prodData.products || []).map((p: any) => ({ id: p.id, title: p.title }))
      setProducts(prods)
      // Build edits map from saved costs; unsaved products default to ""
      const saved: Record<string, string> = {}
      for (const c of (costsData.costs || [])) {
        saved[c.product_id] = String(c.pharmacy_cost)
      }
      setCostEdits(saved)
    } catch { /* silent */ }
  }

  useEffect(() => { load(); loadProductCosts() }, [clinic.id])
  useEffect(() => { load(dateFrom || undefined, dateTo || undefined) }, [dateFrom, dateTo])

  const openConfigEdit = () => {
    setConfigForm({
      clinic_name:          config?.clinic_name          || "",
      clinic_bank_routing:  config?.clinic_bank_routing  || "",
      clinic_bank_account:  config?.clinic_bank_account  || "",
      clinic_bank_name:     config?.clinic_bank_name     || "",
      clinic_account_name:  config?.clinic_account_name  || "",
      pharmacy_name:         config?.pharmacy_name         || "",
      pharmacy_bank_routing: config?.pharmacy_bank_routing || "",
      pharmacy_bank_account: config?.pharmacy_bank_account || "",
      pharmacy_bank_name:    config?.pharmacy_bank_name    || "",
      pharmacy_account_name: config?.pharmacy_account_name || "",
      notes:                 config?.notes                 || "",
    })
    setConfigError("")
    setEditingConfig(true)
  }

  const saveConfig = async () => {
    setSavingConfig(true)
    setConfigError("")
    try {
      const res = await fetch(`/admin/clinics/${clinic.id}/payout-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(configForm),
      })
      const data = await res.json()
      if (!res.ok) { setConfigError(data.message || "Save failed"); setSavingConfig(false); return }
      setConfig(data.config)
      setEditingConfig(false)
    } catch (e: any) { setConfigError(e.message) }
    setSavingConfig(false)
  }

  const saveProductCosts = async () => {
    setSavingCosts(true)
    setCostsMsg("")
    try {
      const costs = Object.entries(costEdits)
        .filter(([, v]) => v !== "" && !isNaN(Number(v)))
        .map(([product_id, pharmacy_cost]) => ({
          product_id,
          pharmacy_cost: Number(pharmacy_cost),
          product_title: products.find(p => p.id === product_id)?.title || "",
        }))
      if (costs.length === 0) { setCostsMsg("No costs to save"); setSavingCosts(false); return }
      const res = await fetch(`/admin/clinics/${clinic.id}/product-costs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ costs }),
      })
      const data = await res.json()
      if (!res.ok) { setCostsMsg(data.message || "Save failed"); setSavingCosts(false); return }
      setCostsMsg(`✓ Saved costs for ${data.costs?.length} products`)
    } catch (e: any) { setCostsMsg(e.message) }
    setSavingCosts(false)
  }

  const submitPayout = async () => {
    if (!payingOut) return
    if (!payoutRef.trim()) { setPayoutError("Reference number is required"); return }
    setSubmittingPayout(true)
    setPayoutError("")
    try {
      const res = await fetch(`/admin/clinics/${clinic.id}/payouts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor_type: payingOut, reference_number: payoutRef, notes: payoutNotes, from: dateFrom || undefined, to: dateTo || undefined }),
      })
      const data = await res.json()
      if (!res.ok) { setPayoutError(data.message || "Payout failed"); setSubmittingPayout(false); return }
      setPayingOut(null)
      setPayoutRef("")
      setPayoutNotes("")
      setSuccessMsg(`✓ $${data.total_paid?.toFixed(2)} payout recorded for ${payingOut} (${data.entries_paid} orders)`)
      await load(dateFrom || undefined, dateTo || undefined)
    } catch (e: any) { setPayoutError(e.message) }
    setSubmittingPayout(false)
  }

  const VENDOR_LABELS: Record<string, string> = { clinic: "Clinic", pharmacy: "Pharmacy" }

  return (
    <div style={{ padding: 4 }}>
      {successMsg && (
        <div style={{ background: "#d1fae5", border: "1px solid #6ee7b7", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "#065f46" }}>
          {successMsg}
          <button onClick={() => setSuccessMsg("")} style={{ marginLeft: 12, background: "none", border: "none", cursor: "pointer", color: "#065f46" }}>✕</button>
        </div>
      )}

      {/* Bank Details */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "#111", margin: 0 }}>Bank Details</h3>
          <button onClick={openConfigEdit} style={{ ...s.btnAction, fontSize: 12 }}>
            {config ? "Edit" : "Configure"}
          </button>
        </div>

        {config ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {[
              { label: "Clinic", prefix: "clinic" },
              { label: "Pharmacy", prefix: "pharmacy" },
            ].map(({ label, prefix }) => (
              <div key={prefix} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, fontSize: 12, color: "#374151", lineHeight: 1.8 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{label} — {(config as any)[`${prefix}_name`] || "—"}</div>
                <div><strong>Bank:</strong> {(config as any)[`${prefix}_bank_name`] || "—"}</div>
                <div><strong>Routing:</strong> {(config as any)[`${prefix}_bank_routing`] ? `••••${String((config as any)[`${prefix}_bank_routing`]).slice(-4)}` : "—"}</div>
                <div><strong>Account:</strong> {(config as any)[`${prefix}_bank_account`] ? `••••${String((config as any)[`${prefix}_bank_account`]).slice(-4)}` : "—"}</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "#9ca3af", padding: "12px 0" }}>
            No bank details configured yet. Click Configure to add clinic and pharmacy bank information.
          </div>
        )}
      </div>

      {/* Product Pharmacy Costs */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: "#111", margin: 0 }}>Product Pharmacy Costs</h3>
            <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0" }}>
              Set the pharmacy cost per product. For each order, pharmacy receives the sum of (cost × qty), clinic receives the remainder.
            </p>
          </div>
          <button
            onClick={saveProductCosts}
            disabled={savingCosts}
            style={{ ...s.btnAction, background: "#0e7490", color: "#fff", borderColor: "#0e7490", fontSize: 12 }}
          >
            {savingCosts ? "Saving…" : "Save All"}
          </button>
        </div>
        {costsMsg && (
          <div style={{ marginBottom: 10, fontSize: 12, color: costsMsg.startsWith("✓") ? "#065f46" : "#dc2626" }}>
            {costsMsg}
          </div>
        )}
        {products.length === 0 ? (
          <div style={{ fontSize: 13, color: "#9ca3af" }}>No products found.</div>
        ) : (
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f9fafb" }}>
                  <th style={{ ...s.th, textAlign: "left", padding: "8px 12px" }}>Product</th>
                  <th style={{ ...s.th, textAlign: "right", padding: "8px 12px", width: 140 }}>Pharmacy Cost ($)</th>
                </tr>
              </thead>
              <tbody>
                {products.map((prod, i) => (
                  <tr key={prod.id} style={{ borderTop: i > 0 ? "1px solid #f3f4f6" : undefined }}>
                    <td style={{ padding: "8px 12px", color: "#374151" }}>{prod.title}</td>
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>
                      <input
                        type="number" min="0" step="0.01"
                        placeholder="0.00"
                        value={costEdits[prod.id] ?? ""}
                        onChange={e => setCostEdits(prev => ({ ...prev, [prod.id]: e.target.value }))}
                        style={{ ...s.input, width: 100, fontSize: 12, textAlign: "right", padding: "4px 8px" }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Date Range Filter */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: "#374151" }}>Date range:</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              style={{ ...s.input, fontSize: 13, width: 150, padding: "6px 10px" }} />
            <span style={{ color: "#6b7280", fontSize: 13 }}>to</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              style={{ ...s.input, fontSize: 13, width: 150, padding: "6px 10px" }} />
          </div>
          {(dateFrom || dateTo) && (
            <button onClick={() => { setDateFrom(""); setDateTo("") }}
              style={{ fontSize: 12, color: "#6b7280", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
              Clear
            </button>
          )}
          {(dateFrom || dateTo) && (
            <span style={{ fontSize: 12, color: "#6b7280" }}>
              Showing {dateFrom || "all"} → {dateTo || "all"}
            </span>
          )}
        </div>
      </div>

      {/* Pending Balances */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "#111", margin: 0 }}>Pending Payouts</h3>
          {loading && <span style={{ fontSize: 11, color: "#9ca3af" }}>Refreshing…</span>}
        </div>
        {(() => {
          const p = pending["pharmacy"] || { total: 0, count: 0, entries: [] }
          const hasPending = p.count > 0
          return (
            <div style={{ border: `1px solid ${hasPending ? "#fbbf24" : "#e5e7eb"}`, borderRadius: 10, padding: 16, background: hasPending ? "#fffbeb" : "#fafafa", maxWidth: 420 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>Pharmacy</span>
                {hasPending && (
                  <button
                    onClick={() => { setPayingOut("pharmacy"); setPayoutRef(""); setPayoutNotes(""); setPayoutError("") }}
                    style={{ ...s.btnAction, background: "#0e7490", color: "#fff", borderColor: "#0e7490", fontSize: 12 }}
                  >
                    Pay Out
                  </button>
                )}
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: hasPending ? "#92400e" : "#9ca3af" }}>
                ${p.total.toFixed(2)}
              </div>
              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                {p.count} order{p.count !== 1 ? "s" : ""} unpaid
              </div>
              {hasPending && p.entries.length > 0 && (
                <div style={{ marginTop: 10, maxHeight: 120, overflowY: "auto" }}>
                  {p.entries.map((e: any) => (
                    <div key={e.order_id} style={{ fontSize: 11, color: "#374151", borderTop: "1px solid #f3f4f6", padding: "4px 0", display: "flex", justifyContent: "space-between" }}>
                      <span>Order #{e.display_id || e.order_id?.slice(0, 8)}</span>
                      <span>${Number(e.amount_owed).toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })()}
      </div>

      {/* Payout History */}
      <div>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: "#111", marginBottom: 12 }}>Payout History</h3>
        {history.length === 0 ? (
          <div style={{ fontSize: 13, color: "#9ca3af", padding: "16px 0" }}>No payouts recorded yet</div>
        ) : (
          <table style={{ ...s.table, fontSize: 12 }}>
            <thead>
              <tr>{["Date", "Vendor", "Amount", "Reference #", "Notes"].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {history.map((p: any) => (
                <tr key={p.id}>
                  <td style={s.td}>{new Date(p.paid_at).toLocaleDateString()}</td>
                  <td style={s.td}>{VENDOR_LABELS[p.vendor_type] || p.vendor_type}</td>
                  <td style={{ ...s.td, fontWeight: 600 }}>${Number(p.total_amount).toFixed(2)}</td>
                  <td style={{ ...s.td, fontFamily: "monospace", fontSize: 11 }}>{p.reference_number || "—"}</td>
                  <td style={s.td}>{p.notes || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Edit Config Modal */}
      {editingConfig && (
        <Modal onClose={() => setEditingConfig(false)}>
          <h3 style={s.modalTitle}>Bank Details Configuration</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            {/* Clinic bank details */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#0e7490", marginBottom: 8 }}>Clinic Bank Details</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {([
                  ["Clinic Name", "clinic_name"],
                  ["Bank Name", "clinic_bank_name"],
                  ["Routing Number", "clinic_bank_routing"],
                  ["Account Number", "clinic_bank_account"],
                  ["Account Holder Name", "clinic_account_name"],
                ] as [string, string][]).map(([label, key]) => (
                  <div key={key} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <label style={{ fontSize: 11, color: "#6b7280" }}>{label}</label>
                    <input type="text" value={(configForm as any)[key]}
                      onChange={e => setConfigForm(p => ({ ...p, [key]: e.target.value }))}
                      style={{ ...s.input, fontSize: 12 }} />
                  </div>
                ))}
              </div>
            </div>

            {/* Pharmacy bank details */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#7c3aed", marginBottom: 8 }}>Pharmacy Bank Details</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {([
                  ["Pharmacy Name", "pharmacy_name"],
                  ["Bank Name", "pharmacy_bank_name"],
                  ["Routing Number", "pharmacy_bank_routing"],
                  ["Account Number", "pharmacy_bank_account"],
                  ["Account Holder Name", "pharmacy_account_name"],
                ] as [string, string][]).map(([label, key]) => (
                  <div key={key} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <label style={{ fontSize: 11, color: "#6b7280" }}>{label}</label>
                    <input type="text" value={(configForm as any)[key]}
                      onChange={e => setConfigForm(p => ({ ...p, [key]: e.target.value }))}
                      style={{ ...s.input, fontSize: 12 }} />
                  </div>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <label style={{ fontSize: 11, color: "#6b7280" }}>Internal Notes</label>
              <input type="text" value={configForm.notes}
                onChange={e => setConfigForm(p => ({ ...p, notes: e.target.value }))}
                style={{ ...s.input, fontSize: 12 }} />
            </div>

            {configError && <div style={{ color: "#dc2626", fontSize: 12 }}>{configError}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setEditingConfig(false)} style={s.btnSecondary}>Cancel</button>
              <button onClick={saveConfig} disabled={savingConfig} style={s.btnPrimary}>
                {savingConfig ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Pay Out Modal */}
      {payingOut && (
        <Modal onClose={() => setPayingOut(null)}>
          <h3 style={s.modalTitle}>Record {VENDOR_LABELS[payingOut]} Payout</h3>
          <div style={{ fontSize: 13, color: "#374151", marginBottom: 16, background: "#f9fafb", borderRadius: 8, padding: 12 }}>
            <div><strong>Vendor:</strong> {(config as any)?.[`${payingOut}_name`] || VENDOR_LABELS[payingOut]}</div>
            <div><strong>Total Amount:</strong> ${(pending[payingOut]?.total || 0).toFixed(2)}</div>
            <div><strong>Orders Covered:</strong> {pending[payingOut]?.count || 0}</div>
            {(dateFrom || dateTo) && <div><strong>Date Range:</strong> {dateFrom || "—"} → {dateTo || "—"}</div>}
            {(config as any)?.[`${payingOut}_bank_name`] && <div><strong>Bank:</strong> {(config as any)[`${payingOut}_bank_name`]}</div>}
            {(config as any)?.[`${payingOut}_bank_account`] && (
              <div><strong>Account:</strong> ••••{String((config as any)[`${payingOut}_bank_account`]).slice(-4)}</div>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
                ACH / Wire Reference Number <span style={{ color: "#dc2626" }}>*</span>
              </label>
              <input type="text" placeholder="e.g. ACH trace #, wire confirmation #"
                value={payoutRef} onChange={e => setPayoutRef(e.target.value)}
                style={{ ...s.input, fontSize: 13 }} />
              <span style={{ fontSize: 11, color: "#6b7280" }}>
                Stored permanently as proof of payment — both parties can verify against their bank statement.
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: "#374151" }}>Notes (optional)</label>
              <input type="text" placeholder="e.g. April settlement"
                value={payoutNotes} onChange={e => setPayoutNotes(e.target.value)}
                style={{ ...s.input, fontSize: 13 }} />
            </div>
            {payoutError && <div style={{ color: "#dc2626", fontSize: 12 }}>{payoutError}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setPayingOut(null)} style={s.btnSecondary}>Cancel</button>
              <button onClick={submitPayout} disabled={submittingPayout}
                style={{ ...s.btnPrimary, background: "#0e7490", borderColor: "#0e7490" }}>
                {submittingPayout ? "Recording…" : "Confirm Payout"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── Promotions Tab ────────────────────────────────────────────────────────
function PromotionsTab({ clinic, role }: { clinic: Clinic; role: string }) {
  const isSuperAdmin = role === "super_admin"

  // List state
  const [assigned, setAssigned] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  // Create form state
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState("")
  const blankForm = () => ({
    code: "",
    type: "standard" as "standard" | "buyget",
    is_automatic: false,
    value_type: "percentage" as "percentage" | "fixed",
    value: "",
    min_subtotal: "",
    usage_limit: "",
    starts_at: "",
    ends_at: "",
  })
  const [form, setForm] = useState(blankForm())

  // Super-admin assign-existing state
  const [allPromos, setAllPromos] = useState<any[]>([])
  const [selectedPromoId, setSelectedPromoId] = useState("")
  const [assigning, setAssigning] = useState(false)
  const [editingPromo, setEditingPromo] = useState<any | null>(null)
  const [editForm, setEditForm] = useState({ value: "", status: "active", ends_at: "", usage_limit: "" })
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState("")

  useEffect(() => { load() }, [clinic.id])

  const load = async () => {
    setLoading(true); setError("")
    try {
      const [assignedRes, allRes] = await Promise.all([
        fetch(`/admin/clinics/${clinic.id}/promotions`, { credentials: "include" }),
        isSuperAdmin ? fetch(`/admin/promotions-list`, { credentials: "include" }) : Promise.resolve(null),
      ])
      const assignedData = await assignedRes.json()
      setAssigned(assignedData.promotions || [])
      if (allRes) {
        const allData = await allRes.json()
        setAllPromos(allData.promotions || [])
      }
    } catch (e: any) {
      setError(e.message || "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  // Create a new Medusa promotion then auto-assign to this clinic
  const createPromotion = async () => {
    if (!form.code.trim()) { setCreateError("Promotion code is required"); return }
    if (!form.value) { setCreateError("Discount value is required"); return }
    setCreating(true); setCreateError("")
    try {
      // Medusa v2 promotion payload
      // application_method.type = "fixed" | "percentage"
      // application_method.target_type = "order" | "items" | "shipping_methods"
      // application_method.value = the discount amount (cents for fixed, integer % for percentage)
      const appMethodValue = form.value_type === "percentage"
        ? Number(form.value)                        // e.g. 20 for 20%
        : Number(form.value)                        // stored in dollars, not cents

      const payload: any = {
        code: form.code.trim().toUpperCase(),
        type: form.type,
        is_automatic: form.is_automatic,
        status: "active",
        application_method: {
          type: form.value_type,          // "fixed" or "percentage"
          target_type: "order",
          value: appMethodValue,
          currency_code: "usd",
        },
      }

      // Promotion-level rules (min subtotal)
      if (form.min_subtotal) {
        payload.rules = [{
          attribute: "subtotal",
          operator: "gte",
          values: [String(Math.round(Number(form.min_subtotal) * 100))],
        }]
      }

      // Campaign for usage limit and/or date range
      // starts_at, ends_at, and usage_limit all live on the campaign in Medusa v2
      const hasCampaign = form.usage_limit || form.starts_at || form.ends_at
      if (hasCampaign) {
        const campaignIdentifier = form.code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "_")
        const campaign: any = {
          name: `${clinic.name} — ${form.code.trim().toUpperCase()}`,
          campaign_identifier: `${campaignIdentifier}_${Date.now()}`,
        }
        if (form.starts_at) { const d = new Date(form.starts_at); if (!isNaN(d.getTime())) campaign.starts_at = d.toISOString() }
        if (form.ends_at)   { const d = new Date(form.ends_at);   if (!isNaN(d.getTime())) campaign.ends_at   = d.toISOString() }
        if (form.usage_limit) {
          campaign.budget = {
            type: "usage",
            limit: Number(form.usage_limit),
          }
        }
        payload.campaign = campaign
      }

      // Create via Medusa admin API
      const createRes = await fetch("/admin/promotions", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}))
        throw new Error(err.message || `Failed to create promotion (${createRes.status})`)
      }
      const { promotion } = await createRes.json()

      // Auto-assign to this clinic
      const assignRes = await fetch(`/admin/clinics/${clinic.id}/promotions`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promotion_id: promotion.id }),
      })
      if (!assignRes.ok) {
        const err = await assignRes.json().catch(() => ({}))
        throw new Error(err.message || `Promotion created but failed to assign (${assignRes.status})`)
      }

      setForm(blankForm())
      setShowCreate(false)
      load()
    } catch (e: any) {
      setCreateError(e.message)
    } finally {
      setCreating(false)
    }
  }

  // Super-admin: assign an existing promotion
  const assignExisting = async () => {
    if (!selectedPromoId) return
    setAssigning(true)
    try {
      await fetch(`/admin/clinics/${clinic.id}/promotions`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promotion_id: selectedPromoId }),
      })
      setSelectedPromoId(""); load()
    } catch {} finally { setAssigning(false) }
  }

  const remove = async (promotionId: string) => {
    try {
      await fetch(`/admin/clinics/${clinic.id}/promotions/${promotionId}`, {
        method: "DELETE", credentials: "include",
      })
      load()
    } catch {}
  }

  const openEdit = (a: any) => {
    setEditingPromo(a)
    setEditForm({
      value: a.discount_value != null ? String(a.discount_value) : "",
      status: a.status || "active",
      ends_at: a.ends_at ? a.ends_at.substring(0, 10) : "",
      usage_limit: a.usage_limit ? String(a.usage_limit) : "",
    })
    setEditError("")
  }

  const saveEdit = async () => {
    if (!editingPromo) return
    setEditSaving(true); setEditError("")
    try {
      const res = await fetch(`/admin/clinics/${clinic.id}/promotions/${editingPromo.promotion_id}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: editForm.status,
          discount_value: editForm.value ? Number(editForm.value) : undefined,
          application_method_id: editingPromo.application_method_id,
          ends_at: editForm.ends_at || null,
          usage_limit: editForm.usage_limit || null,
        }),
      })
      if (!res.ok) throw new Error("Failed to update promotion")
      setEditingPromo(null)
      load()
    } catch (e: any) {
      setEditError(e.message)
    } finally {
      setEditSaving(false)
    }
  }

  const statusBadge = (status: string) => {
    const map: Record<string, { bg: string; color: string }> = {
      active:   { bg: "#d1fae5", color: "#065f46" },
      inactive: { bg: "#f3f4f6", color: "#6b7280" },
      draft:    { bg: "#fef3c7", color: "#92400e" },
    }
    const st = map[status] || map.inactive
    return <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, ...st }}>{status}</span>
  }

  const assignedIds = new Set(assigned.map((a: any) => a.promotion_id))
  const available = allPromos.filter(p => !assignedIds.has(p.id))

  if (loading) return <div style={{ color: "#9ca3af", padding: 24 }}>Loading…</div>

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {error && <div style={{ color: "#dc2626", fontSize: 13 }}>⚠️ {error}</div>}

      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 13, color: "#6b7280" }}>
          Promotions for <strong style={{ color: "#111" }}>{clinic.name}</strong>
        </div>
        <button onClick={() => { setShowCreate(p => !p); setCreateError("") }} style={s.btnPrimary}>
          {showCreate ? "Cancel" : "+ Create Promotion"}
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div style={{ ...s.formBox, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>New Promotion</div>

          {createError && (
            <div style={{ padding: "8px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, fontSize: 13, color: "#dc2626" }}>
              ⚠️ {createError}
            </div>
          )}

          <div style={s.grid2}>
            <Field label="Promo Code *">
              <input style={{ ...s.input, textTransform: "uppercase" }}
                value={form.code}
                onChange={e => setForm(p => ({ ...p, code: e.target.value.toUpperCase() }))}
                placeholder="e.g. SAVE20" />
            </Field>
            <Field label="Type">
              <select style={s.input} value={form.type}
                onChange={e => setForm(p => ({ ...p, type: e.target.value as any }))}>
                <option value="standard">Standard (code required)</option>
                <option value="buyget">Buy X Get Y</option>
              </select>
            </Field>
            <Field label="Discount Value *">
              <div style={{ display: "flex", gap: 8 }}>
                <select style={{ ...s.input, width: 120, flexShrink: 0 }} value={form.value_type}
                  onChange={e => setForm(p => ({ ...p, value_type: e.target.value as any }))}>
                  <option value="percentage">% Off</option>
                  <option value="fixed">$ Fixed</option>
                </select>
                <input style={s.input} type="number" min="0" step="0.01"
                  value={form.value}
                  onChange={e => setForm(p => ({ ...p, value: e.target.value }))}
                  placeholder={form.value_type === "percentage" ? "e.g. 20" : "e.g. 10.00"} />
              </div>
            </Field>
            <Field label="Min Order Subtotal ($)">
              <input style={s.input} type="number" min="0" step="0.01"
                value={form.min_subtotal}
                onChange={e => setForm(p => ({ ...p, min_subtotal: e.target.value }))}
                placeholder="Optional — e.g. 50.00" />
            </Field>
            <Field label="Usage Limit">
              <input style={s.input} type="number" min="1"
                value={form.usage_limit}
                onChange={e => setForm(p => ({ ...p, usage_limit: e.target.value }))}
                placeholder="Max times usable (blank = unlimited)" />
            </Field>
            <Field label="Starts At">
              <input style={s.input} type="date"
                value={form.starts_at}
                onChange={e => setForm(p => ({ ...p, starts_at: e.target.value }))} />
            </Field>
            <Field label="Expires At">
              <input style={s.input} type="date"
                value={form.ends_at}
                onChange={e => setForm(p => ({ ...p, ends_at: e.target.value }))} />
            </Field>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div onClick={() => setForm(p => ({ ...p, is_automatic: !p.is_automatic }))}
              style={{ width: 40, height: 22, borderRadius: 11, background: form.is_automatic ? "#10b981" : "#d1d5db", position: "relative", cursor: "pointer", transition: "background 0.2s" }}>
              <div style={{ position: "absolute", top: 3, left: form.is_automatic ? 21 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
            </div>
            <span style={{ fontSize: 13 }}>Auto-apply (no code needed at checkout)</span>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={createPromotion} disabled={creating || !form.code || !form.value}
              style={{ ...s.btnPrimary, opacity: (!form.code || !form.value) ? 0.5 : 1 }}>
              {creating ? "Creating…" : "Create & Assign to Clinic"}
            </button>
            <button onClick={() => { setShowCreate(false); setForm(blankForm()); setCreateError("") }} style={s.btnOutline}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Super-admin: assign existing promotion */}
      {isSuperAdmin && !showCreate && (
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", padding: "12px 16px", background: "#f9fafb", borderRadius: 8, border: "1px solid #e5e7eb" }}>
          <div style={{ flex: 1 }}>
            <label style={s.label}>Assign Existing Promotion (Super Admin)</label>
            <select style={s.input} value={selectedPromoId} onChange={e => setSelectedPromoId(e.target.value)}>
              <option value="">Select a promotion…</option>
              {available.map(p => (
                <option key={p.id} value={p.id}>{p.code} — {p.type} ({p.status})</option>
              ))}
            </select>
          </div>
          <button onClick={assignExisting} disabled={assigning || !selectedPromoId}
            style={{ ...s.btnOutline, opacity: !selectedPromoId ? 0.5 : 1 }}>
            {assigning ? "Assigning…" : "Assign"}
          </button>
        </div>
      )}

      {/* Promotions list */}
      {assigned.length === 0 ? (
        <EmptyState icon="🎁" message="No promotions for this clinic yet — create one above" />
      ) : (
        <table style={s.table}>
          <thead>
            <tr>
              {["Code", "Value", "Type", "Status", "Auto-apply", "Usage", "Expires", ""].map(h => (
                <th key={h} style={s.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {assigned.map((a: any) => (
              <tr key={a.assignment_id}>
                <td style={{ ...s.td, fontWeight: 700, fontFamily: "monospace", fontSize: 13 }}>{a.code || "—"}</td>
                <td style={s.td}>
                  {a.discount_value != null
                    ? a.discount_type === "percentage"
                      ? `${a.discount_value}% off`
                      : `$${Number(a.discount_value).toFixed(2)}`
                    : "—"}
                </td>
                <td style={s.td}>{a.type || "—"}</td>
                <td style={s.td}>{statusBadge(a.status || "inactive")}</td>
                <td style={s.td}>
                  <span style={{ fontSize: 12, color: a.is_automatic ? "#065f46" : "#6b7280" }}>
                    {a.is_automatic ? "✓ Yes" : "No"}
                  </span>
                </td>
                <td style={s.td}>
                  {a.usage_count != null ? `${a.usage_count}${a.usage_limit ? ` / ${a.usage_limit}` : ""}` : "—"}
                </td>
                <td style={s.td}>
                  {a.ends_at ? new Date(a.ends_at).toLocaleDateString() : "No expiry"}
                </td>
                <td style={{ ...s.td, display: "flex", gap: 6 }}>
                  <button onClick={() => openEdit(a)} style={s.btnAction}>✏️ Edit</button>
                  <button onClick={() => remove(a.promotion_id)} style={s.btnDanger}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editingPromo && (
        <div style={s.modalOverlay} onClick={e => e.target === e.currentTarget && setEditingPromo(null)}>
          <div style={s.modalBox}>
            <p style={s.modalTitle}>Edit Promotion — {editingPromo.code}</p>
            {editError && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>⚠️ {editError}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Field label="Status">
                <select style={s.input} value={editForm.status} onChange={e => setEditForm(p => ({ ...p, status: e.target.value }))}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </Field>
              <Field label={editingPromo.discount_type === "percentage" ? "Discount Value (%)" : "Discount Value ($)"}>
                <input style={s.input} type="number" min="0" step="0.01"
                  value={editForm.value}
                  onChange={e => setEditForm(p => ({ ...p, value: e.target.value }))}
                  placeholder={editingPromo.discount_type === "percentage" ? "e.g. 20" : "e.g. 50.00"} />
              </Field>
              <Field label="Usage Limit (blank = unlimited)">
                <input style={s.input} type="number" min="1"
                  value={editForm.usage_limit}
                  onChange={e => setEditForm(p => ({ ...p, usage_limit: e.target.value }))}
                  placeholder="e.g. 100" />
              </Field>
              <Field label="Expires At">
                <input style={s.input} type="date"
                  value={editForm.ends_at}
                  onChange={e => setEditForm(p => ({ ...p, ends_at: e.target.value }))} />
              </Field>
              <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                <button onClick={saveEdit} disabled={editSaving} style={s.btnPrimary}>
                  {editSaving ? "Saving…" : "Save Changes"}
                </button>
                <button onClick={() => setEditingPromo(null)} style={s.btnOutline}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Helper Components ──────────────────────────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={s.label}>{label}</label>
      {children}
    </div>
  )
}

function SaveBar({ saving, status, onSave, inline }: { saving: boolean; status: string; onSave: () => void; inline?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, justifyContent: inline ? "flex-end" : "space-between" }}>
      {status === "saved" && <span style={{ fontSize: 13, color: "#10b981" }}>✓ Saved</span>}
      {status === "error" && <span style={{ fontSize: 13, color: "#dc2626" }}>Save failed</span>}
      <button onClick={onSave} disabled={saving} style={s.btnPrimary}>{saving ? "Saving…" : "Save Changes"}</button>
    </div>
  )
}

function EmptyState({ icon, message }: { icon: string; message: string }) {
  return (
    <div style={{ textAlign: "center", padding: "48px 0", color: "#9ca3af" }}>
      <div style={{ fontSize: 36, marginBottom: 8 }}>{icon}</div>
      <div style={{ fontSize: 14 }}>{message}</div>
    </div>
  )
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={s.modalOverlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={s.modalBox}>{children}</div>
    </div>
  )
}

// ── Styles ─────────────────────────────────────────────────────────────────
const s: Record<string, React.CSSProperties> = {
  root: { display: "flex", height: "100vh", fontFamily: "'DM Sans', system-ui, sans-serif", background: "#f9fafb" },
  sidebar: { width: 220, background: "#fff", borderRight: "1px solid #e5e7eb", display: "flex", flexDirection: "column", flexShrink: 0 },
  sidebarHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 16px 12px", borderBottom: "1px solid #f3f4f6" },
  sidebarTitle: { fontWeight: 700, fontSize: 13, color: "#111", textTransform: "uppercase", letterSpacing: "0.05em" },
  addBtn: { width: 26, height: 26, borderRadius: 6, border: "1px solid #e5e7eb", background: "#fff", cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", color: "#374151" },
  newForm: { padding: 12, borderBottom: "1px solid #f3f4f6", display: "flex", flexDirection: "column", gap: 8 },
  sidebarInput: { width: "100%", padding: "7px 10px", border: "1px solid #e5e7eb", borderRadius: 6, fontSize: 12, boxSizing: "border-box" },
  createBtn: { padding: "7px 12px", background: "#111", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer" },
  clinicItem: { width: "100%", padding: "10px 16px", border: "none", background: "transparent", cursor: "pointer", borderLeft: "3px solid transparent", transition: "all 0.15s" },
  clinicItemActive: { background: "#f0f9ff", borderLeft: "3px solid #111", color: "#111" },
  domainTag: { display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", background: "#f3f4f6", borderRadius: 4, fontSize: 11 },
  domainRemove: { background: "none", border: "none", cursor: "pointer", color: "#9ca3af", padding: 0, fontSize: 12, lineHeight: 1 },
  main: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" },
  empty: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#9ca3af" },
  detailHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 24px", borderBottom: "1px solid #e5e7eb", background: "#fff" },
  tabBar: { display: "flex", borderBottom: "2px solid #e5e7eb", background: "#fff", paddingLeft: 8 },
  tab: { padding: "10px 16px", border: "none", background: "transparent", fontSize: 12, fontWeight: 500, color: "#6b7280", cursor: "pointer", borderBottom: "2px solid transparent", marginBottom: -2 },
  tabActive: { color: "#111", fontWeight: 700, borderBottom: "2px solid #111" },
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 },
  label: { display: "block", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#6b7280", marginBottom: 6 },
  input: { width: "100%", padding: "9px 12px", border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 13, color: "#111", background: "#fff", outline: "none", boxSizing: "border-box" },
  showBtn: { position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 12, padding: 0 },
  btnPrimary: { padding: "9px 20px", borderRadius: 8, border: "none", background: "#111", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  btnOutline: { padding: "8px 16px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer", color: "#374151" },
  btnDanger: { padding: "4px 12px", borderRadius: 6, border: "1px solid #fecaca", background: "#fef2f2", fontSize: 12, color: "#dc2626", cursor: "pointer" },
  btnAction: { padding: "5px 12px", borderRadius: 6, border: "1px solid #e5e7eb", background: "#fff", fontSize: 12, color: "#111", cursor: "pointer", fontWeight: 500 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 12px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#9ca3af", borderBottom: "1px solid #f3f4f6" },
  td: { padding: "12px 12px", borderBottom: "1px solid #f9fafb", color: "#374151", verticalAlign: "middle" },
  formBox: { background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: 16 },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 },
  modalBox: { background: "#fff", borderRadius: 12, padding: 28, width: 560, maxWidth: "90vw", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" },
  modalTitle: { margin: "0 0 4px", fontSize: 16, fontWeight: 700 },
  modalSubtitle: { margin: "0 0 16px", fontSize: 13, color: "#6b7280" },
}