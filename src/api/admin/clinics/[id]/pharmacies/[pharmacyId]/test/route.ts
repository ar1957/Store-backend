/**
 * POST /admin/clinics/:id/pharmacies/:pharmacyId/test
 * Tests a specific clinic_pharmacy row's API connection from the backend
 * (avoids CORS). Same logic as the legacy /admin/clinics/:id/test-pharmacy
 * route, but reads credentials from clinic_pharmacy by pharmacyId instead of
 * the single set of pharmacy_* columns on clinic.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

async function safeJson(res: Response): Promise<{ ok: boolean; data: any; raw: string }> {
  const raw = await res.text()
  try {
    return { ok: true, data: JSON.parse(raw), raw }
  } catch {
    return { ok: false, data: null, raw: raw.slice(0, 200) }
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { pharmacyId } = req.params

    // Always read credentials from DB — the form may be showing a masked
    // secret ("••••••••xxxx"), which is unusable for the actual auth call.
    const pharmacyResult = await pg.raw(
      `SELECT * FROM clinic_pharmacy WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [pharmacyId]
    )
    const pharmacy = pharmacyResult.rows[0]
    if (!pharmacy) return res.status(404).json({ success: false, message: "Pharmacy not found" })

    const baseUrl = (pharmacy.pharmacy_api_url || "").trim().replace(/\/$/, "")

    // ── RxVortex (Strive) ──────────────────────────────────────────────────
    if (pharmacy.pharmacy_type === "rxvortex") {
      if (!pharmacy.pharmacy_client_id || !pharmacy.pharmacy_client_secret) {
        return res.status(400).json({ success: false, message: "client_id and client_secret are required for RxVortex" })
      }
      const subdomainUrl = (pharmacy.pharmacy_subdomain?.trim() && !pharmacy.pharmacy_subdomain.includes("."))
        ? `https://${pharmacy.pharmacy_subdomain.trim()}.rxvortex.net`
        : ""
      const resolvedUrl = baseUrl || subdomainUrl || "https://sandbox.rxvortex.net"

      const authUrl = `${resolvedUrl}/api/v1/generate-access-token`
      const authRes = await fetch(authUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: pharmacy.pharmacy_client_id, client_secret: pharmacy.pharmacy_client_secret }),
      })
      const { ok: isJson, data, raw } = await safeJson(authRes)
      if (!isJson) {
        return res.status(400).json({ success: false, message: `RxVortex API returned non-JSON (HTTP ${authRes.status}). Response: ${raw}` })
      }
      if (authRes.ok && data?.access_token && !data?.error) {
        return res.json({ success: true, message: `Authentication successful — ${data.msg || "access token obtained"}` })
      }
      const errMsg = data?.msg || data?.message || (data?.error === true ? "Invalid credentials" : `Auth failed (HTTP ${authRes.status})`)
      return res.status(400).json({ success: false, message: errMsg })
    }

    // ── RMM (RequestMyMeds) ────────────────────────────────────────────────
    if (pharmacy.pharmacy_type === "rmm") {
      if (!baseUrl) return res.status(400).json({ success: false, message: "No pharmacy API URL configured" })

      const authUrl = `${baseUrl}/getJWTkey`
      const authRes = await fetch(authUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: pharmacy.pharmacy_username, password: pharmacy.pharmacy_password }),
      })
      const { ok: isJson, data, raw } = await safeJson(authRes)
      if (!isJson) {
        return res.status(400).json({ success: false, message: `RMM API returned non-JSON (HTTP ${authRes.status}). Check the API URL. Response: ${raw}` })
      }
      if (authRes.ok && data?.token) {
        return res.json({ success: true, message: "Authentication successful" })
      }
      return res.status(400).json({ success: false, message: data?.error || data?.message || `Auth failed (HTTP ${authRes.status})` })
    }

    // ── DigitalRX (default) ────────────────────────────────────────────────
    const testRes = await fetch(`${baseUrl}/RxRequestStatus`, {
      method: "POST",
      headers: { "Authorization": pharmacy.pharmacy_api_key || "", "Content-Type": "application/json" },
      body: JSON.stringify({ StoreID: pharmacy.pharmacy_store_id, QueueID: "test" }),
    })
    const success = testRes.status < 400
    return res.json({
      success,
      message: success
        ? `Connection successful (HTTP ${testRes.status})`
        : `Connection failed (HTTP ${testRes.status}) — check your API URL and credentials`,
    })
  } catch (err: any) {
    console.error("[TestPharmacyRow] Error:", err.message)
    return res.status(500).json({ success: false, message: err.message })
  }
}
