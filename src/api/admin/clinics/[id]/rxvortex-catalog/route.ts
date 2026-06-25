/**
 * GET /admin/clinics/:id/rxvortex-catalog
 * Proxies the RxVortex preset catalog API so the admin UI can display
 * a dropdown of medications without exposing credentials to the browser.
 * Only available when the clinic's pharmacy_type is "rxvortex".
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { getRxVortexToken } from "../../../utils/pharmacy-submit-rxvortex"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any

    const clinicResult = await pg.raw(
      `SELECT pharmacy_type, pharmacy_api_url, pharmacy_client_id, pharmacy_client_secret, pharmacy_subdomain
       FROM clinic WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [req.params.id]
    )
    const clinic = clinicResult.rows[0]

    if (!clinic) return res.status(404).json({ message: "Clinic not found" })
    if (clinic.pharmacy_type !== "rxvortex") {
      return res.status(400).json({ message: "This clinic does not use RxVortex" })
    }
    if (!clinic.pharmacy_client_id || !clinic.pharmacy_client_secret) {
      return res.status(400).json({ message: "RxVortex credentials not configured" })
    }

    // Resolve base URL (same logic as submission handler)
    let baseUrl = (clinic.pharmacy_api_url || "").trim().replace(/\/$/, "")
    if (!baseUrl && clinic.pharmacy_subdomain?.trim()) {
      baseUrl = `https://${clinic.pharmacy_subdomain.trim()}.rxvortex.net`
    }
    if (!baseUrl) baseUrl = "https://sandbox.rxvortex.net"

    const token = await getRxVortexToken(baseUrl, clinic.pharmacy_client_id, clinic.pharmacy_client_secret)

    const catalogRes = await fetch(`${baseUrl}/api/v1/preset-catalog-items`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    })

    if (!catalogRes.ok) {
      const text = await catalogRes.text()
      return res.status(catalogRes.status).json({ message: `RxVortex catalog fetch failed: ${text.slice(0, 200)}` })
    }

    const data = await catalogRes.json()

    // Normalize — API may return array directly or wrapped in a key
    const items: any[] = Array.isArray(data) ? data : (data.items || data.data || [])

    // Return only what the UI needs, filter to active only
    const catalog = items
      .filter((item: any) => item.status === "active" || !item.status)
      .map((item: any) => ({
        catalog_id: item.catalog_id,
        medication_name: item.medication_name || "",
        medication_strength: item.medication_strength || "",
        medication_form: item.medication_form || "",
        days_supply: item.days_supply,
        quantity: item.quantity,
        quantity_units: item.quantity_units || "",
        instruction: item.instruction || "",
      }))
      .sort((a: any, b: any) => a.medication_name.localeCompare(b.medication_name))

    return res.json({ catalog })
  } catch (err: any) {
    console.error("[RxVortexCatalog] Error:", err.message)
    return res.status(500).json({ message: err.message })
  }
}
