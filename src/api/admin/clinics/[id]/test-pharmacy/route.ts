/**
 * POST /admin/clinics/:id/test-pharmacy
 * Tests the pharmacy API connection from the backend (avoids CORS).
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
    const {
      pharmacy_type,
      pharmacy_api_url,
      pharmacy_api_key,
      pharmacy_store_id,
      pharmacy_username,
      pharmacy_password,
      pharmacy_client_id,
      pharmacy_client_secret,
      pharmacy_subdomain,
    } = req.body as any

    const baseUrl = (pharmacy_api_url || "").replace(/\/$/, "")

    // ── RxVortex (Strive) ──────────────────────────────────────────────────
    if (pharmacy_type === "rxvortex") {
      // Always read credentials from DB to avoid masked-secret problem.
      // The UI GET endpoint masks pharmacy_client_secret as "••••••••xxxx",
      // so the form value is unusable for the actual auth call.
      const pg = req.scope.resolve("__pg_connection__") as any
      const clinicResult = await pg.raw(
        `SELECT pharmacy_client_id, pharmacy_client_secret, pharmacy_api_url, pharmacy_subdomain
         FROM clinic WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [req.params.id]
      )
      const dbClinic = clinicResult.rows[0]

      const resolvedClientId = dbClinic?.pharmacy_client_id || pharmacy_client_id
      const resolvedSecret   = dbClinic?.pharmacy_client_secret || pharmacy_client_secret

      // Resolve URL: DB value → form value → subdomain → sandbox default
      const dbUrl = (dbClinic?.pharmacy_api_url || "").trim().replace(/\/$/, "")
      const resolvedUrl = dbUrl
        || baseUrl
        || (dbClinic?.pharmacy_subdomain?.trim() ? `https://${dbClinic.pharmacy_subdomain.trim()}.rxvortex.net` : "")
        || (pharmacy_subdomain?.trim() ? `https://${pharmacy_subdomain.trim()}.rxvortex.net` : "")
        || "https://sandbox.rxvortex.net"

      if (!resolvedClientId || !resolvedSecret) {
        return res.status(400).json({ success: false, message: "client_id and client_secret are required for RxVortex" })
      }

      const authUrl = `${resolvedUrl}/api/v1/generate-access-token`
      console.log(`[TestPharmacy] RxVortex auth URL: ${authUrl}`)

      const authRes = await fetch(authUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: resolvedClientId, client_secret: resolvedSecret }),
      })

      const { ok: isJson, data, raw } = await safeJson(authRes)
      console.log(`[TestPharmacy] RxVortex response status=${authRes.status} isJson=${isJson} body=${raw}`)

      if (!isJson) {
        return res.status(400).json({
          success: false,
          message: `RxVortex API returned non-JSON (HTTP ${authRes.status}). Response: ${raw}`,
        })
      }

      if (authRes.ok && data?.access_token && !data?.error) {
        return res.json({ success: true, message: `Authentication successful — ${data.msg || "access token obtained"}` })
      }

      const errMsg = data?.msg || data?.message || (data?.error === true ? "Invalid credentials" : `Auth failed (HTTP ${authRes.status})`)
      return res.status(400).json({ success: false, message: errMsg })
    }

    // ── RMM (RequestMyMeds) ────────────────────────────────────────────────
    if (pharmacy_type === "rmm") {
      if (!baseUrl) {
        return res.status(400).json({ success: false, message: "No pharmacy API URL configured" })
      }

      const authUrl = `${baseUrl}/getJWTkey`
      console.log(`[TestPharmacy] RMM auth URL: ${authUrl}`)

      const authRes = await fetch(authUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: pharmacy_username, password: pharmacy_password }),
      })

      const { ok: isJson, data, raw } = await safeJson(authRes)
      console.log(`[TestPharmacy] RMM response status=${authRes.status} isJson=${isJson} body=${raw}`)

      if (!isJson) {
        return res.status(400).json({
          success: false,
          message: `RMM API returned non-JSON (HTTP ${authRes.status}). Check the API URL. Response: ${raw}`,
        })
      }

      if (authRes.ok && data?.token) {
        return res.json({ success: true, message: "Authentication successful" })
      }

      return res.status(400).json({
        success: false,
        message: data?.error || data?.message || `Auth failed (HTTP ${authRes.status})`,
      })
    }

    // ── DigitalRX (default) ────────────────────────────────────────────────
    const testRes = await fetch(`${baseUrl}/RxRequestStatus`, {
      method: "POST",
      headers: { "Authorization": pharmacy_api_key, "Content-Type": "application/json" },
      body: JSON.stringify({ StoreID: pharmacy_store_id, QueueID: "test" }),
    })
    const success = testRes.status < 400
    return res.json({
      success,
      message: success
        ? `Connection successful (HTTP ${testRes.status})`
        : `Connection failed (HTTP ${testRes.status}) — check your API URL and credentials`,
    })

  } catch (err: any) {
    console.error("[TestPharmacy] Error:", err.message)
    return res.status(500).json({ success: false, message: err.message })
  }
}
