/**
 * POST /admin/clinics/:id/test-pharmacy
 * Tests the pharmacy API connection from the backend (avoids CORS).
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const { pharmacy_type, pharmacy_api_url, pharmacy_api_key, pharmacy_store_id,
            pharmacy_username, pharmacy_password } = req.body as any

    const baseUrl = (pharmacy_api_url || "").replace(/\/$/, "")

    if (pharmacy_type === "rmm") {
      // Test RMM JWT auth
      const authRes = await fetch(`${baseUrl}/getJWTkey`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: pharmacy_username, password: pharmacy_password }),
      })
      const data = await authRes.json()
      if (authRes.ok && data.token) {
        return res.json({ success: true, message: "Authentication successful" })
      }
      return res.status(400).json({ success: false, message: data.error || `Auth failed (${authRes.status})` })
    } else {
      // Test DigitalRX connection
      const testRes = await fetch(`${baseUrl}/RxRequestStatus`, {
        method: "POST",
        headers: { "Authorization": pharmacy_api_key, "Content-Type": "application/json" },
        body: JSON.stringify({ StoreID: pharmacy_store_id, QueueID: "test" }),
      })
      return res.json({ success: testRes.status < 500, message: `Connection status: ${testRes.status}` })
    }
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message })
  }
}
