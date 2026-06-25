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
    const { pharmacy_type, pharmacy_api_url, pharmacy_api_key, pharmacy_store_id,
            pharmacy_username, pharmacy_password,
            pharmacy_client_id, pharmacy_client_secret, pharmacy_subdomain } = req.body as any

    const baseUrl = (pharmacy_api_url || "").replace(/\/$/, "")

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

    } else if (pharmacy_type === "rxvortex") {
      // RxVortex — test by obtaining an access token
      const resolvedUrl = baseUrl ||
        (pharmacy_subdomain ? `https://${pharmacy_subdomain.trim()}.rxvortex.net` : "https://sandbox.rxvortex.net")

      if (!pharmacy_client_id || !pharmacy_client_secret) {
        return res.status(400).json({ success: false, message: "client_id and client_secret are required for RxVortex" })
      }

      const authUrl = `${resolvedUrl}/api/v1/generate-access-token`
      console.log(`[TestPharmacy] RxVortex auth URL: ${authUrl}`)

      const authRes = await fetch(authUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: pharmacy_client_id, client_secret: pharmacy_client_secret }),
      })

      const { ok: isJson, data, raw } = await safeJson(authRes)

      console.log(`[TestPharmacy] RxVortex response status=${authRes.status} isJson=${isJson} body=${raw}`)

      if (!isJson) {
        return res.status(400).json({
          success: false,
          message: `RxVortex API returned non-JSON (HTTP ${authRes.status}). Check your credentials and URL. Response: ${raw}`,
        })
      }

      if (authRes.ok && data?.access_token && !data?.error) {
        return res.json({ success: true, message: `Authentication successful — ${data.msg || "access token obtained"}` })
      }

      // data.error === true means auth failed; use data.msg for the message (RxVortex uses "msg" not "message")
      const errMsg = data?.msg || data?.message || (data?.error === true ? "Invalid credentials" : `Auth failed (HTTP ${authRes.status})`)
      return res.status(400).json({
        success: false,
        message: errMsg,
      })

    } else {
      // DigitalRX — just check connectivity, don't parse body
      const testRes = await fetch(`${baseUrl}/RxRequestStatus`, {
        method: "POST",
        headers: { "Authorization": pharmacy_api_key, "Content-Type": "application/json" },
        body: JSON.stringify({ StoreID: pharmacy_store_id, QueueID: "test" }),
      })
      return res.json({ success: testRes.status < 500, message: `Connection status: ${testRes.status}` })
    }
  } catch (err: any) {
    console.error("[TestPharmacy] Error:", err.message)
    return res.status(500).json({ success: false, message: err.message })
  }
}
