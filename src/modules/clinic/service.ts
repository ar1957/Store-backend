import { MedusaService } from "@medusajs/framework/utils"
import Clinic from "./models/clinic"

export interface ClinicData {
  id: string
  name: string
  slug: string
  domains: string[]
  contact_email: string | null
  is_active: boolean
  logo_url: string | null
  brand_color: string
  api_client_id: string | null
  api_client_secret: string | null
  api_env: string
  api_base_url_test: string
  api_base_url_prod: string
  connect_env: string
  connect_url_test: string
  connect_url_prod: string
  redirect_url: string | null
  publishable_api_key: string | null
  sales_channel_id: string | null
  pharmacy_staff_id: string | null
}

// ── Clinic domain cache ────────────────────────────────────────────────────
const CLINIC_CACHE_TTL = 5 * 60 * 1000 // 5 minutes
let clinicListCache: { data: ClinicData[]; fetchedAt: number } | null = null
interface TokenCache { token: string; expiresAt: number }
interface LocationCache { locations: any[]; fetchedAt: number }
interface TreatmentCache { treatments: any[]; fetchedAt: number }

const TOKEN_TTL   = 50 * 60 * 1000
const LOC_TTL     = 5 * 60 * 1000  // 5 minutes — refresh often to pick up new locations
const TREAT_TTL   = 24 * 60 * 60 * 1000

const tokenCache:     Record<string, TokenCache>     = {}
const locationCache:  Record<string, LocationCache>  = {}
const treatmentCache: Record<string, TreatmentCache> = {}

class ClinicService extends MedusaService({ Clinic }) {

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async getAllClinics(activeOnly = false): Promise<ClinicData[]> {
    const filter = activeOnly ? { is_active: true } : {}
    return (await this.listClinics(filter as any)) as ClinicData[]
  }

  async getClinicById(id: string): Promise<ClinicData | null> {
    const results = await this.listClinics({ id } as any)
    return (results[0] as ClinicData) ?? null
  }

  async getClinicByDomain(domain: string): Promise<ClinicData | null> {
    // Use cached clinic list to avoid full table scan on every request
    if (!clinicListCache || Date.now() - clinicListCache.fetchedAt > CLINIC_CACHE_TTL) {
      clinicListCache = { data: (await this.listClinics({} as any)) as ClinicData[], fetchedAt: Date.now() }
    }
    const all = clinicListCache.data

    // 1. Exact match first
    let match = (all as ClinicData[]).find(c =>
      c.domains?.includes(domain)
    )
    if (match) return match

    // 2. Strip port and try again (localhost:8000 → localhost)
    const domainNoPort = domain.split(":")[0]
    match = (all as ClinicData[]).find(c =>
      c.domains?.some(d => d.split(":")[0] === domainNoPort)
    )
    if (match) return match

    // 3. Match .local dev domains to their production equivalent
    // e.g. myclassywellness.local → myclassywellness.com
    // e.g. spaderx.local → spaderx.com
    // e.g. contour-wellness.local → contour-wellness.com
    const localMatch = domainNoPort.replace(/\.local$/, "")
    match = (all as ClinicData[]).find(c =>
      c.domains?.some(d => {
        const dNoPort = d.split(":")[0]
        const dNoTld = dNoPort.replace(/\.(com|net|org|io)$/, "")
        return dNoTld === localMatch
      })
    )
    if (match) return match

    return null
  }

  async createClinic(data: Partial<ClinicData>): Promise<ClinicData> {
    return (await this.createClinics(data as any)) as ClinicData
  }

  async updateClinic(id: string, data: Partial<ClinicData>): Promise<ClinicData> {
    const results = await this.updateClinics({ id } as any, data as any)
    clinicListCache = null // invalidate domain cache
    this.clearCaches(id)
    return results[0] as ClinicData
  }

  async deleteClinic(id: string): Promise<void> {
    await this.deleteClinics({ id } as any)
    this.clearCaches(id)
  }

  getApiBaseUrl(clinic: ClinicData): string {
    return clinic.api_env === "prod"
      ? clinic.api_base_url_prod
      : clinic.api_base_url_test
  }

  getConnectUrl(clinic: ClinicData): string {
    return clinic.connect_env === "prod"
      ? clinic.connect_url_prod
      : clinic.connect_url_test
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  async getToken(clinicId: string): Promise<string> {
    const cached = tokenCache[clinicId]
    if (cached && Date.now() < cached.expiresAt) return cached.token

    const clinic = await this.getClinicById(clinicId)
    if (!clinic?.api_client_id || !clinic?.api_client_secret) {
      throw new Error(`No API credentials configured for clinic: ${clinicId}`)
    }

    // API requires credentials in headers (Basic auth + individual headers)
    const basicAuth = Buffer.from(
      `${clinic.api_client_id}:${clinic.api_client_secret}`
    ).toString("base64")

    const res = await fetch(`${this.getApiBaseUrl(clinic)}/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${basicAuth}`,
        "ClientId": clinic.api_client_id,
        "ClientSecret": clinic.api_client_secret,
      },
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Auth failed for ${clinic.name}: ${res.status} ${text}`)
    }

    const data = await res.json()
    const token = data?.token || data?.payload?.token
    if (!token) throw new Error(`No token returned for clinic: ${clinic.name}`)

    tokenCache[clinicId] = { token, expiresAt: Date.now() + TOKEN_TTL }
    return token
  }

  async testConnection(clinicId: string): Promise<{ success: boolean; message: string }> {
    try {
      delete tokenCache[clinicId]
      await this.getToken(clinicId)
      return { success: true, message: "Connection successful" }
    } catch (err: unknown) {
      return {
        success: false,
        message: err instanceof Error ? err.message : "Connection failed",
      }
    }
  }

  // ── Locations ─────────────────────────────────────────────────────────────

  async getLocations(clinicId: string): Promise<any[]> {
    const cached = locationCache[clinicId]
    if (cached && Date.now() - cached.fetchedAt < LOC_TTL) return cached.locations

    const clinic = await this.getClinicById(clinicId)
    if (!clinic) throw new Error(`Clinic not found: ${clinicId}`)

    const token = await this.getToken(clinicId)
    const res = await fetch(`${this.getApiBaseUrl(clinic)}/customer/locations`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) throw new Error(`Failed to fetch locations: ${res.status}`)
    const data = await res.json()
    const locations = data?.payload || []

    locationCache[clinicId] = { locations, fetchedAt: Date.now() }
    return locations
  }

  async getAvailableStates(clinicId: string): Promise<string[]> {
    const locations = await this.getLocations(clinicId)
    return [...new Set(locations.map((l: any) => l.state as string))].sort()
  }

  async getLocationIdByState(clinicId: string, state: string): Promise<number | null> {
    const locations = await this.getLocations(clinicId)
    const match = locations.find(
      (l: any) => l.state.toLowerCase() === state.toLowerCase()
    )
    return match?.customerLocationId ?? null
  }

  // ── Treatments ────────────────────────────────────────────────────────────

  async getTreatments(clinicId: string): Promise<any[]> {
    const cached = treatmentCache[clinicId]
    if (cached && Date.now() - cached.fetchedAt < TREAT_TTL) return cached.treatments

    const clinic = await this.getClinicById(clinicId)
    if (!clinic) throw new Error(`Clinic not found: ${clinicId}`)

    const token = await this.getToken(clinicId)
    const res = await fetch(`${this.getApiBaseUrl(clinic)}/customer/treatments`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) throw new Error(`Failed to fetch treatments: ${res.status}`)
    const data = await res.json()
    const treatments = data?.payload || []

    treatmentCache[clinicId] = { treatments, fetchedAt: Date.now() }
    return treatments
  }

  // ── Cache ─────────────────────────────────────────────────────────────────

  clearCaches(clinicId?: string) {
    if (clinicId) {
      delete tokenCache[clinicId]
      delete locationCache[clinicId]
      delete treatmentCache[clinicId]
    } else {
      Object.keys(tokenCache).forEach(k => delete tokenCache[k])
      Object.keys(locationCache).forEach(k => delete locationCache[k])
      Object.keys(treatmentCache).forEach(k => delete treatmentCache[k])
    }
  }
}

export default ClinicService