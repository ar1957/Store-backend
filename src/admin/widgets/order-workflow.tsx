/**
 * Order Workflow Widget
 * File: src/admin/widgets/order-workflow.tsx
 *
 * Appears on the order detail page in Medusa admin.
 * Shows clinic workflow actions + comments based on logged-in user's role.
 */

import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { useState, useEffect } from "react"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { HttpTypes } from "@medusajs/types"

interface WorkflowData {
  id: string
  order_id: string
  gfe_id: string | null
  status: string
  provider_name: string
  provider_status: string
  md_decision: string
  md_notes: string
  tracking_number: string
  carrier: string
  treatment_dosages: { treatmentId: number; treatmentName: string; dosage: string | null }[]
  pharmacy_queue_id?: string | null
  pharmacy_status?: string | null
}

interface Comment {
  id: string
  user_name: string
  user_email: string
  role: string
  comment: string
  created_at: string
}

interface CurrentUser {
  id: string
  email: string
  first_name: string
  last_name: string
}

interface StaffRecord {
  clinic_id: string
  role: string
  full_name: string
  email: string
}

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  pending_provider:    { label: "Pending Provider",  color: "#92400e", bg: "#fef3c7" },
  provider_deferred:   { label: "MD Review Needed",  color: "#7c3aed", bg: "#ede9fe" },
  pending_md_review:   { label: "Pending MD Review", color: "#7c3aed", bg: "#ede9fe" },
  processing_pharmacy: { label: "Processing",        color: "#1e40af", bg: "#dbeafe" },
  sent_to_pharmacy:    { label: "Sent to Pharmacy",  color: "#1e40af", bg: "#dbeafe" },
  pharmacy_processing: { label: "Processing",        color: "#1e40af", bg: "#dbeafe" },
  shipped:             { label: "Shipped",           color: "#065f46", bg: "#d1fae5" },
  refund_issued:       { label: "Refund Issued",     color: "#991b1b", bg: "#fee2e2" },
  provider_approved:   { label: "Provider Approved", color: "#065f46", bg: "#d1fae5" },
}

const ROLE_LABELS: Record<string, string> = {
  clinic_admin: "Clinic Admin",
  medical_director: "Medical Director",
  pharmacist: "Pharmacist",
  super_admin: "Super Admin",
}

function OrderWorkflowWidget({ data: order }: DetailWidgetProps<HttpTypes.AdminOrder>) {
  const [workflow, setWorkflow] = useState<WorkflowData | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [myStaff, setMyStaff] = useState<StaffRecord | null>(null)
  const [clinicId, setClinicId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [newComment, setNewComment] = useState("")
  const [savingComment, setSavingComment] = useState(false)
  const [mdNotes, setMdNotes] = useState("")
  const [tracking, setTracking] = useState({ number: "", carrier: "UPS" })
  const [processing, setProcessing] = useState(false)
  const [showActions, setShowActions] = useState(false)
  const [submittingPharmacy, setSubmittingPharmacy] = useState(false)
  const [pharmacyResult, setPharmacyResult] = useState<string | null>(null)
  const [pharmacyConfigured, setPharmacyConfigured] = useState(false)
  const [gfePortalUrl, setGfePortalUrl] = useState<string | null>(null)
  const [sendingReminder, setSendingReminder] = useState(false)
  const [reminderResult, setReminderResult] = useState<string | null>(null)

  const role = myStaff?.role || "super_admin"

  useEffect(() => {
    init()
  }, [order.id])

  const init = async () => {
    setLoading(true)
    try {
      // 1. Get current user
      const userRes = await fetch("/admin/users/me", { credentials: "include" })
      if (!userRes.ok) return
      const userData = await userRes.json()
      setCurrentUser(userData.user)

      // 2. Get all clinics to find staff record
      const clinicsRes = await fetch("/admin/clinics", { credentials: "include" })
      const clinicsData = await clinicsRes.json()
      const allClinics = clinicsData.clinics || []

      let foundStaff: StaffRecord | null = null
      let foundClinicId: string | null = null

      for (const clinic of allClinics) {
        const staffRes = await fetch(`/admin/clinics/${clinic.id}/staff`, { credentials: "include" })
        const staffData = await staffRes.json()
        const match = (staffData.staff || []).find((s: any) => s.email === userData.user.email)
        if (match) {
          foundStaff = { ...match, clinic_id: clinic.id }
          foundClinicId = clinic.id
          break
        }
        // For super admin, use the clinic that has this order
        if (!foundClinicId) foundClinicId = clinic.id
      }

      setMyStaff(foundStaff)

      // Inject CSS to hide Metadata and JSON sections for non-super-admin roles
      const resolvedRole = foundStaff?.role || "super_admin"
      const existingStyle = document.getElementById("mhc-order-detail-hide")
      if (existingStyle) existingStyle.remove()
      if (resolvedRole !== "super_admin") {
        const style = document.createElement("style")
        style.id = "mhc-order-detail-hide"
        // Target the Metadata and JSON sections by their heading text
        // Medusa renders these as containers with a heading span
        style.textContent = `
          [data-testid="metadata-section"],
          [data-testid="json-section"] { display: none !important; }
        `
        document.head.appendChild(style)

        // Also use a MutationObserver to hide by text content since Medusa
        // doesn't always use consistent test IDs
        const hideByText = () => {
          document.querySelectorAll("h2, h3, span, div").forEach(el => {
            const text = el.textContent?.trim()
            if (text === "Metadata" || text === "JSON") {
              // Walk up to find the section container
              let parent = el.parentElement
              for (let i = 0; i < 5; i++) {
                if (parent && (parent.tagName === "SECTION" || (parent.className && parent.className.includes("bg-ui-bg-base")))) {
                  (parent as HTMLElement).style.display = "none"
                  break
                }
                parent = parent?.parentElement || null
              }
            }
          })
        }
        hideByText()
        const observer = new MutationObserver(hideByText)
        observer.observe(document.body, { childList: true, subtree: true })
        // Store observer reference for cleanup
        ;(window as any).__mhcOrderObserver = observer
      } else {
        // Super admin — remove any existing observer
        if ((window as any).__mhcOrderObserver) {
          ;(window as any).__mhcOrderObserver.disconnect()
          delete (window as any).__mhcOrderObserver
        }
      }

      // For super admin, search all clinics to find which one has this order
      let targetClinicId = foundStaff?.clinic_id || null

      if (!targetClinicId) {
        // Super admin — search all clinics for this order
        for (const clinic of allClinics) {
          const res = await fetch(`/admin/clinics/${clinic.id}/orders`, { credentials: "include" })
          const data = await res.json()
          const found = (data.orders || []).find((o: any) => o.order_id === order.id)
          if (found) {
            targetClinicId = clinic.id
            break
          }
        }
      }

      if (!targetClinicId) targetClinicId = allClinics[0]?.id
      setClinicId(targetClinicId)

      // Check if this clinic has pharmacy configured
      if (targetClinicId) {
        try {
          const clinicRes = await fetch(`/admin/clinics/${targetClinicId}`, { credentials: "include" })
          const clinicData = await clinicRes.json()
          const c = clinicData.clinic || {}
          const hasPharmacy = c.pharmacy_enabled === true &&
            !!(c.pharmacy_api_key || c.pharmacy_username)
          setPharmacyConfigured(hasPharmacy)

          // Build GFE portal URL
          const connectUrl = c.api_env === "prod" ? c.connect_url_prod : c.connect_url_test
          if (connectUrl) setGfePortalUrl(connectUrl.replace(/\/$/, ""))
        } catch {}
      }

      if (targetClinicId) {
        await loadWorkflow(targetClinicId, order.id)
        await loadComments(targetClinicId, order.id)
      }
    } catch (e) {
      console.error("Widget init error:", e)
    } finally {
      setLoading(false)
    }
  }

  const loadWorkflow = async (cId: string, orderId: string) => {
    try {
      // Fetch all orders for this clinic and find the matching one
      const res = await fetch(`/admin/clinics/${cId}/orders`, { credentials: "include" })
      const data = await res.json()
      const wf = (data.orders || []).find((o: any) =>
        o.order_id === orderId || o.order_id === orderId.replace("order_", "")
      )
      if (wf) {
        setWorkflow(wf)
      } else {
        // Try searching across all clinics
        const clinicsRes = await fetch("/admin/clinics", { credentials: "include" })
        const clinicsData = await clinicsRes.json()
        for (const clinic of (clinicsData.clinics || [])) {
          if (clinic.id === cId) continue
          const r = await fetch(`/admin/clinics/${clinic.id}/orders`, { credentials: "include" })
          const d = await r.json()
          const found = (d.orders || []).find((o: any) => o.order_id === orderId)
          if (found) {
            setWorkflow(found)
            setClinicId(clinic.id)
            break
          }
        }
      }
    } catch {}
  }

  const loadComments = async (cId: string, orderId: string) => {
    try {
      const res = await fetch(`/admin/clinics/${cId}/orders/${orderId}/comments`, { credentials: "include" })
      const data = await res.json()
      setComments(data.comments || [])
    } catch {}
  }

  const addComment = async () => {
    if (!newComment.trim() || !clinicId) return
    setSavingComment(true)
    try {
      await fetch(`/admin/clinics/${clinicId}/orders/${order.id}/comments`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          comment: newComment,
          user_id: currentUser?.id || "",
          user_email: currentUser?.email || "",
          user_name: `${currentUser?.first_name || ""} ${currentUser?.last_name || ""}`.trim(),
          role,
        }),
      })
      setNewComment("")
      await loadComments(clinicId, order.id)
    } catch {}
    finally { setSavingComment(false) }
  }

  const mdDecision = async (decision: "approved" | "denied") => {
    if (!clinicId) return
    setProcessing(true)
    try {
      const res = await fetch(`/admin/clinics/${clinicId}/orders/${order.id}/md-decision`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          decision, 
          notes: mdNotes, 
          md_user_id: currentUser?.id,
          user_email: currentUser?.email || "",
          user_name: `${currentUser?.first_name || ""} ${currentUser?.last_name || ""}`.trim(),
        }),
      })
      setMdNotes("")
      setShowActions(false)
      await loadWorkflow(clinicId, order.id)
    } catch {}
    finally { setProcessing(false) }
  }

  const markShipped = async () => {
    if (!clinicId || !tracking.number) return
    setProcessing(true)
    try {
      await fetch(`/admin/clinics/${clinicId}/orders/${order.id}/ship`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tracking_number: tracking.number,
          carrier: tracking.carrier,
          pharmacist_user_id: currentUser?.id,
        }),
      })
      setTracking({ number: "", carrier: "UPS" })
      setShowActions(false)
      await loadWorkflow(clinicId, order.id)
    } catch {}
    finally { setProcessing(false) }
  }

  const submitToPharmacy = async () => {
    if (!clinicId) return
    setSubmittingPharmacy(true)
    setPharmacyResult(null)
    try {
      const res = await fetch(`/admin/clinics/${clinicId}/orders/${order.id}/pharmacy-submit`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      })
      const data = await res.json()
      if (res.ok) {
        setPharmacyResult(`✓ Submitted. Queue ID: ${data.queueId}`)
        await loadWorkflow(clinicId, order.id)
      } else {
        setPharmacyResult(`✗ Error: ${data.message}`)
      }
    } catch (e: any) {
      setPharmacyResult(`✗ Error: ${e.message}`)
    }
    finally { setSubmittingPharmacy(false) }
  }

  const sendProviderReminder = async () => {
    if (!clinicId) return
    setSendingReminder(true)
    setReminderResult(null)
    try {
      const res = await fetch(`/admin/clinics/${clinicId}/orders/${order.id}/send-reminder`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      })
      const data = await res.json()
      setReminderResult(res.ok ? `✓ ${data.message}` : `✗ ${data.message}`)
    } catch (e: any) {
      setReminderResult(`✗ Error: ${e.message}`)
    } finally {
      setSendingReminder(false)
    }
  }

  if (loading) {
    return (
      <div style={ws.container}>
        <div style={ws.header}>🏥 Clinic Workflow</div>
        <div style={{ color: "#9ca3af", fontSize: 13, padding: 8 }}>Loading workflow data…</div>
      </div>
    )
  }

  if (!workflow) {
    return (
      <div style={ws.container}>
        <div style={ws.header}>🏥 Clinic Workflow</div>
        <div style={{ color: "#9ca3af", fontSize: 13, marginBottom: 16 }}>No clinic workflow found for this order.</div>
        {/* Still show comments */}
        {clinicId && (
          <div style={{ borderTop: "1px solid #f3f4f6", paddingTop: 16 }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>💬 Comments ({comments.length})</div>
            <div style={{ maxHeight: 200, overflowY: "auto", marginBottom: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              {comments.length === 0 ? (
                <div style={{ color: "#9ca3af", fontSize: 12 }}>No comments yet</div>
              ) : comments.map(c => (
                <div key={c.id} style={{ background: "#f9fafb", borderRadius: 8, padding: "8px 10px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, fontSize: 12 }}>{c.user_name || c.user_email}</span>
                    <span style={{ fontSize: 10, color: "#9ca3af" }}>{new Date(c.created_at).toLocaleString()}</span>
                  </div>
                  <p style={{ margin: 0, fontSize: 12, color: "#374151" }}>{c.comment}</p>
                </div>
              ))}
            </div>
            <textarea style={{ ...ws.input, height: 60, resize: "none", marginBottom: 8 }}
              value={newComment} onChange={e => setNewComment(e.target.value)} placeholder="Add a comment…" />
            <button onClick={addComment} disabled={savingComment || !newComment.trim()}
              style={{ ...ws.btnPrimary, opacity: !newComment.trim() ? 0.5 : 1 }}>
              {savingComment ? "Saving…" : "Add Comment"}
            </button>
          </div>
        )}
      </div>
    )
  }

  const si = STATUS_META[workflow.status] || { label: workflow.status, color: "#374151", bg: "#f3f4f6" }
  const canMdReview = (role === "super_admin" || role === "medical_director") && ["provider_deferred", "pending_md_review"].includes(workflow.status)
  const canShip = (role === "super_admin" || role === "pharmacist") &&
    ["sent_to_pharmacy", "pharmacy_processing", "processing_pharmacy"].includes(workflow.status)
  const canRefund = (role === "super_admin" || role === "clinic_admin") &&
    !["refund_issued", "refunded"].includes(workflow.status)

  return (
    <div style={ws.container}>
      <div style={ws.header}>🏥 Clinic Workflow</div>

      {/* Status + role badge */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <span style={{ padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600, background: si.bg, color: si.color }}>
          {si.label}
        </span>
        <span style={{ fontSize: 12, color: "#6b7280" }}>
          Logged in as: <strong>{ROLE_LABELS[role]}</strong>
        </span>
      </div>

      {/* Provider clearance reminder — only for pending_provider orders */}
      {workflow.status === "pending_provider" && (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#92400e", marginBottom: 4 }}>⏰ Awaiting Provider Clearance</div>
          <div style={{ fontSize: 12, color: "#78350f", marginBottom: 10 }}>
            Patient has not yet connected with a provider. Send a reminder email with their visit link.
          </div>
          {reminderResult && (
            <div style={{ fontSize: 12, padding: "6px 10px", borderRadius: 6, marginBottom: 8,
              background: reminderResult.startsWith("✓") ? "#f0fdf4" : "#fef2f2",
              color: reminderResult.startsWith("✓") ? "#166534" : "#dc2626" }}>
              {reminderResult}
            </div>
          )}
          <button
            onClick={sendProviderReminder}
            disabled={sendingReminder}
            style={{ padding: "8px 16px", background: "#d97706", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: sendingReminder ? 0.7 : 1 }}
          >
            {sendingReminder ? "Sending…" : "📧 Send Provider Clearance Reminder"}
          </button>
        </div>
      )}

      {/* Dosages */}
      {workflow.treatment_dosages && workflow.treatment_dosages.length > 0 && (
        <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "#166534", marginBottom: 8 }}>💊 Provider Dosages</div>
          {workflow.treatment_dosages.map((td, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
              <span style={{ fontSize: 13 }}>{td.treatmentName}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#166534" }}>{td.dosage || "—"}</span>
            </div>
          ))}
        </div>
      )}

      {/* Pharmacy submit button — shown when processing_pharmacy but not yet submitted, and pharmacy is configured */}
      {workflow.status === "processing_pharmacy" && !workflow.pharmacy_queue_id && pharmacyConfigured && (role === "super_admin" || role === "clinic_admin" || role === "pharmacist") && (
        <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#1e40af", marginBottom: 6 }}>💊 Pharmacy API Available</div>
          <div style={{ fontSize: 12, color: "#3b82f6", marginBottom: 10 }}>This order has not been submitted to the pharmacy API yet.</div>
          {pharmacyResult && (
            <div style={{ fontSize: 12, padding: "6px 10px", borderRadius: 6, marginBottom: 8, background: pharmacyResult.startsWith("✓") ? "#f0fdf4" : "#fef2f2", color: pharmacyResult.startsWith("✓") ? "#166534" : "#dc2626" }}>
              {pharmacyResult}
            </div>
          )}
          <button onClick={submitToPharmacy} disabled={submittingPharmacy}
            style={{ padding: "8px 16px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            {submittingPharmacy ? "Submitting…" : "Submit to Pharmacy API"}
          </button>
        </div>
      )}

      {/* Pharmacy queue info — shown when already submitted */}
      {workflow.pharmacy_queue_id && (
        <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: 10, marginBottom: 16, fontSize: 13 }}>
          💊 Pharmacy Queue ID: <strong>{workflow.pharmacy_queue_id}</strong>
          {workflow.pharmacy_status && <span style={{ marginLeft: 8, color: "#6b7280" }}>({workflow.pharmacy_status})</span>}
        </div>
      )}

      {/* Actions */}
      {(canMdReview || canShip) && (
        <div style={{ marginBottom: 16 }}>
          <button onClick={() => setShowActions(p => !p)} style={ws.btnAction}>
            {showActions ? "Hide Actions" : canMdReview ? "⚕️ MD Review" : "📦 Mark Shipped"}
          </button>

          {showActions && canMdReview && (
            <div style={{ marginTop: 12, background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 8, padding: 12 }}>
              <label style={ws.label}>Review Notes (optional)</label>
              <textarea
                style={{ ...ws.input, height: 70, resize: "vertical", marginBottom: 10 }}
                value={mdNotes}
                onChange={e => setMdNotes(e.target.value)}
                placeholder="Add notes for pharmacy or patient file…"
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => mdDecision("approved")} disabled={processing}
                  style={{ ...ws.btnPrimary, background: "#10b981" }}>✓ Approve → Pharmacy</button>
                <button onClick={() => mdDecision("denied")} disabled={processing}
                  style={{ ...ws.btnPrimary, background: "#ef4444" }}>✗ Deny → Refund</button>
              </div>
            </div>
          )}

          {showActions && canShip && (
            <div style={{ marginTop: 12, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <div>
                  <label style={ws.label}>Carrier</label>
                  <select style={ws.input} value={tracking.carrier} onChange={e => setTracking(p => ({ ...p, carrier: e.target.value }))}>
                    {["UPS", "FedEx", "USPS", "DHL"].map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label style={ws.label}>Tracking Number</label>
                  <input style={ws.input} value={tracking.number} onChange={e => setTracking(p => ({ ...p, number: e.target.value }))} placeholder="Enter tracking #" />
                </div>
              </div>
              <button onClick={markShipped} disabled={processing || !tracking.number}
                style={{ ...ws.btnPrimary, opacity: !tracking.number ? 0.5 : 1 }}>
                📦 Confirm Shipment
              </button>
            </div>
          )}
        </div>
      )}

      {/* Tracking info if shipped */}
      {workflow.status === "shipped" && workflow.tracking_number && (
        <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: 10, marginBottom: 16, fontSize: 13 }}>
          📦 Shipped via <strong>{workflow.carrier}</strong> — {workflow.tracking_number}
        </div>
      )}

      {/* Refund section — clinic admin and super admin only */}
      {canRefund && (
        <RefundSection
          clinicId={clinicId!}
          orderId={order.id}
          onRefunded={() => {
            loadWorkflow(clinicId!, order.id)
            loadComments(clinicId!, order.id)
          }}
        />
      )}

      {/* GFE Portal link */}
      {workflow.gfe_id && gfePortalUrl && (
        <div style={{ marginBottom: 16 }}>
          <a
            href={`${gfePortalUrl}/gfe-pro?id=${workflow.gfe_id}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, fontSize: 13, fontWeight: 600, color: "#166534", textDecoration: "none" }}
          >
            🔗 View Patient GFE
          </a>
        </div>
      )}

      {/* Comments section */}
      <div style={{ borderTop: "1px solid #f3f4f6", paddingTop: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>💬 Comments ({comments.length})</div>

        <div style={{ maxHeight: 250, overflowY: "auto", marginBottom: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {comments.length === 0 ? (
            <div style={{ color: "#9ca3af", fontSize: 12 }}>No comments yet</div>
          ) : comments.map(c => (
            <div key={c.id} style={{ background: "#f9fafb", borderRadius: 8, padding: "8px 10px", border: "1px solid #f3f4f6" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontWeight: 600, fontSize: 12 }}>{c.user_name || c.user_email}</span>
                  <span style={{
                    padding: "1px 6px", borderRadius: 8, fontSize: 10, fontWeight: 600,
                    background: c.role === "medical_director" ? "#ede9fe" : c.role === "pharmacist" ? "#dbeafe" : "#f3f4f6",
                    color: c.role === "medical_director" ? "#7c3aed" : c.role === "pharmacist" ? "#1e40af" : "#374151",
                  }}>
                    {ROLE_LABELS[c.role] || c.role}
                  </span>
                </div>
                <span style={{ fontSize: 10, color: "#9ca3af" }}>{new Date(c.created_at).toLocaleString()}</span>
              </div>
              <p style={{ margin: 0, fontSize: 12, color: "#374151" }}>{c.comment}</p>
            </div>
          ))}
        </div>

        {/* Add comment */}
        <textarea
          style={{ ...ws.input, height: 60, resize: "none", marginBottom: 8 }}
          value={newComment}
          onChange={e => setNewComment(e.target.value)}
          placeholder="Add a comment…"
        />
        <button
          onClick={addComment}
          disabled={savingComment || !newComment.trim()}
          style={{ ...ws.btnPrimary, opacity: !newComment.trim() ? 0.5 : 1 }}
        >
          {savingComment ? "Saving…" : "Add Comment"}
        </button>
      </div>
    </div>
  )
}

// ── Refund Section Component ─────────────────────────────────────────────
function RefundSection({ clinicId, orderId, onRefunded }: { 
  clinicId: string
  orderId: string
  onRefunded: () => void 
}) {
  const [showRefund, setShowRefund] = useState(false)
  const [refundReason, setRefundReason] = useState("")
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState("")

  const issueRefund = async () => {
    if (!refundReason.trim()) { setError("Please provide a reason"); return }
    setProcessing(true)
    setError("")
    try {
      const res = await fetch(`/admin/clinics/${clinicId}/orders/${orderId}/refund`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: refundReason }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.message || "Refund failed"); return }
      setShowRefund(false)
      setRefundReason("")
      onRefunded()
    } catch (e: any) {
      setError(e.message || "Refund failed")
    } finally {
      setProcessing(false)
    }
  }

  return (
    <div style={{ borderTop: "1px solid #f3f4f6", paddingTop: 12, marginBottom: 12 }}>
      {!showRefund ? (
        <button onClick={() => setShowRefund(true)} style={{
          padding: "6px 14px", borderRadius: 6, border: "1px solid #fecaca",
          background: "#fef2f2", fontSize: 12, color: "#dc2626", cursor: "pointer", fontWeight: 500
        }}>
          💸 Issue Refund
        </button>
      ) : (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: "#dc2626", marginBottom: 8 }}>Issue Refund</div>
          <label style={ws.label}>Reason for refund</label>
          <textarea
            style={{ ...ws.input, height: 60, resize: "none", marginBottom: 8 }}
            value={refundReason}
            onChange={e => setRefundReason(e.target.value)}
            placeholder="Enter reason for refund..."
          />
          {error && <div style={{ color: "#dc2626", fontSize: 12, marginBottom: 8 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={issueRefund} disabled={processing || !refundReason.trim()}
              style={{ padding: "7px 14px", borderRadius: 6, border: "none", background: "#dc2626", 
                       color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer",
                       opacity: !refundReason.trim() ? 0.5 : 1 }}>
              {processing ? "Processing…" : "Confirm Refund"}
            </button>
            <button onClick={() => { setShowRefund(false); setRefundReason(""); setError("") }}
              style={{ padding: "7px 14px", borderRadius: 6, border: "1px solid #d1d5db",
                       background: "#fff", fontSize: 12, cursor: "pointer" }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Widget styles
const ws: Record<string, React.CSSProperties> = {
  container: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 20, marginTop: 16 },
  header: { fontWeight: 700, fontSize: 15, marginBottom: 16, color: "#111" },
  label: { display: "block", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#6b7280", marginBottom: 4 },
  input: { width: "100%", padding: "8px 10px", border: "1px solid #e5e7eb", borderRadius: 6, fontSize: 13, outline: "none", boxSizing: "border-box" },
  btnPrimary: { padding: "8px 16px", borderRadius: 6, border: "none", background: "#111", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  btnAction: { padding: "8px 16px", borderRadius: 6, border: "1px solid #e5e7eb", background: "#fff", fontSize: 12, fontWeight: 500, cursor: "pointer", color: "#111" },
}

export const config = defineWidgetConfig({
  zone: "order.details.side.before",
})

export default OrderWorkflowWidget