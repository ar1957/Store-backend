import { MedusaService } from "@medusajs/framework/utils"
import ProviderSettings from "./models/provider-settings"

export interface ProviderSettingsData {
  id: string
  tenant_domain: string
  client_id: string | null
  client_secret: string | null
  api_base_url: string
  api_env: string
  connect_url_test: string | null
  connect_url_prod: string | null
  redirect_url: string | null
  is_active: boolean
}

export interface Location {
  customerLocationId: number
  state: string
  city: string
  streetName: string
  zip: string
}

export interface Treatment {
  id: number
  name: string
}

export interface PatientInput {
  firstname: string
  lastname: string
  dob: string
  email?: string
  phone?: string
  medicalHistory: {
    "1": string
    "2": string
    "3": string
    "4": string
    "5": string
    "6": string
  }
}

export interface GfeInput {
  patientId: number
  treatmentIds: number[]
  customerLocationId: number
}

export interface GfeResult {
  gfeId: number
  roomNo: number
  virtualRoomUrl: string
}

export interface GfeStatus {
  status: string
  providerName: string
  providerLicense: string
  completedAt: string
  treatments: Array<{
    treatmentId: number
    name: string
    status: "approved" | "defer" | "pending" | string
  }>
}

// ── In-memory caches ────────────────────────────────────────────────────────
interface TokenCache { token: string; expiresAt: number }
interface LocationCache { locations: Location[]; fetchedAt: number }
interface TreatmentCache { treatments: Treatment[]; fetchedAt: number }

const TOKEN_TTL = 50 * 60 * 1000
const LOC_TTL = 24 * 60 * 60 * 1000
const TREAT_TTL = 24 * 60 * 60 * 1000

const tokenCache: Record<string, TokenCache> = {}
const locationCache: Record<string, LocationCache> = {}
const treatmentCache: Record<string, TreatmentCache> = {}

class ProviderIntegrationService extends MedusaService({
  ProviderSettings,
}) {

  // ── Settings CRUD ────────────────────────────────────────────────────────

  async getSettingsForTenant(tenantDomain: string): Promise<ProviderSettingsData | null> {
    const results = await this.listProviderSettings({
      tenant_domain: tenantDomain,
    })
    return (results[0] as ProviderSettingsData) ?? null
  }

  async upsertSettings(
    tenantDomain: string,
    data: Partial<Omit<ProviderSettingsData, "id" | "tenant_domain">>
  ): Promise<ProviderSettingsData> {
    const existing = await this.getSettingsForTenant(tenantDomain)

    if (existing) {
      const updated = await this.updateProviderSettings(
        { tenant_domain: tenantDomain },
        data
      )
      this.clearCaches(tenantDomain)
      return updated[0] as ProviderSettingsData
    } else {
      const created = await this.createProviderSettings({
        tenant_domain: tenantDomain,
        ...data,
      } as any)
      return created as ProviderSettingsData
    }
  }

  async listAllSettings(): Promise<ProviderSettingsData[]> {
    return (await this.listProviderSettings({})) as ProviderSettingsData[]
  }

  // ── Auth ─────────────────────────────────────────────────────────────────

  async getToken(tenantDomain: string): Promise<string> {
    const cached = tokenCache[tenantDomain]
    if (cached && Date.now() < cached.expiresAt) return cached.token

    const settings = await this.getSettingsForTenant(tenantDomain)
    if (!settings?.client_id || !settings?.client_secret) {
      throw new Error(`No API credentials configured for tenant: ${tenantDomain}`)
    }

    const res = await fetch(`${settings.api_base_url}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: settings.client_id,
        clientSecret: settings.client_secret,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Auth failed for ${tenantDomain}: ${res.status} ${text}`)
    }

    const data = await res.json()
    const token = data?.token || data?.payload?.token
    if (!token) throw new Error(`No token returned for ${tenantDomain}`)

    tokenCache[tenantDomain] = { token, expiresAt: Date.now() + TOKEN_TTL }
    return token
  }

  async testConnection(tenantDomain: string): Promise<{ success: boolean; message: string }> {
    try {
      delete tokenCache[tenantDomain]
      await this.getToken(tenantDomain)
      return { success: true, message: "Connection successful" }
    } catch (err: unknown) {
      return {
        success: false,
        message: err instanceof Error ? err.message : "Connection failed",
      }
    }
  }

  // ── Locations ────────────────────────────────────────────────────────────

  async getLocations(tenantDomain: string): Promise<Location[]> {
    const cached = locationCache[tenantDomain]
    if (cached && Date.now() - cached.fetchedAt < LOC_TTL) return cached.locations

    const settings = await this.getSettingsForTenant(tenantDomain)
    if (!settings) throw new Error(`No settings for ${tenantDomain}`)

    const token = await this.getToken(tenantDomain)
    const res = await fetch(`${settings.api_base_url}/customer/locations`, {
      headers: { "Authorization": `Bearer ${token}` },
    })

    if (!res.ok) throw new Error(`Failed to fetch locations: ${res.status}`)
    const data = await res.json()
    const locations: Location[] = data?.payload || []

    locationCache[tenantDomain] = { locations, fetchedAt: Date.now() }
    return locations
  }

  async getAvailableStates(tenantDomain: string): Promise<string[]> {
    const locations = await this.getLocations(tenantDomain)
    return [...new Set(locations.map(l => l.state))].sort()
  }

  async getLocationIdByState(tenantDomain: string, state: string): Promise<number | null> {
    const locations = await this.getLocations(tenantDomain)
    const match = locations.find(l => l.state.toLowerCase() === state.toLowerCase())
    return match?.customerLocationId ?? null
  }

  // ── Treatments ───────────────────────────────────────────────────────────

  async getTreatments(tenantDomain: string): Promise<Treatment[]> {
    const cached = treatmentCache[tenantDomain]
    if (cached && Date.now() - cached.fetchedAt < TREAT_TTL) return cached.treatments

    const settings = await this.getSettingsForTenant(tenantDomain)
    if (!settings) throw new Error(`No settings for ${tenantDomain}`)

    const token = await this.getToken(tenantDomain)
    const res = await fetch(`${settings.api_base_url}/customer/treatments`, {
      headers: { "Authorization": `Bearer ${token}` },
    })

    if (!res.ok) throw new Error(`Failed to fetch treatments: ${res.status}`)
    const data = await res.json()
    const treatments: Treatment[] = data?.payload || []

    treatmentCache[tenantDomain] = { treatments, fetchedAt: Date.now() }
    return treatments
  }

  // ── Patient ──────────────────────────────────────────────────────────────

  async createOrGetPatient(
    tenantDomain: string,
    input: PatientInput
  ): Promise<{ patientId: number; isNew: boolean; message: string }> {
    const settings = await this.getSettingsForTenant(tenantDomain)
    if (!settings) throw new Error(`No settings for ${tenantDomain}`)

    const token = await this.getToken(tenantDomain)
    const res = await fetch(`${settings.api_base_url}/patient`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to create patient: ${res.status} ${text}`)
    }

    const data = await res.json()
    const patientId = data?.payload?.id
    if (!patientId) throw new Error("No patient ID returned")

    return { patientId, isNew: data?.status === 201, message: data?.message || "" }
  }

  // ── GFE ──────────────────────────────────────────────────────────────────

  async requestGfe(
    tenantDomain: string,
    input: GfeInput,
    patientDob: string
  ): Promise<GfeResult> {
    const settings = await this.getSettingsForTenant(tenantDomain)
    if (!settings) throw new Error(`No settings for ${tenantDomain}`)

    const token = await this.getToken(tenantDomain)
    const res = await fetch(`${settings.api_base_url}/gfe`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        patientId: input.patientId,
        treatments: input.treatmentIds,
        customerLocationId: input.customerLocationId,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to request GFE: ${res.status} ${text}`)
    }

    const data = await res.json()
    const { gfeId, roomNo } = data?.payload || {}
    if (!gfeId || roomNo === undefined) throw new Error("Invalid GFE response")

    const connectBase = settings.api_env === "prod"
      ? settings.connect_url_prod
      : settings.connect_url_test
    const birthYear = patientDob.split("-")[0] || ""
    const redirectUrl = settings.redirect_url || `https://${tenantDomain}/order-status`
    const virtualRoomUrl = `${connectBase}/${roomNo}${birthYear}?isFromExternal=true&redirectUrl=${encodeURIComponent(redirectUrl)}`

    return { gfeId, roomNo, virtualRoomUrl }
  }

  async getGfeStatus(tenantDomain: string, gfeId: number): Promise<GfeStatus> {
    const settings = await this.getSettingsForTenant(tenantDomain)
    if (!settings) throw new Error(`No settings for ${tenantDomain}`)

    const token = await this.getToken(tenantDomain)
    const res = await fetch(`${settings.api_base_url}/gfe/status/${gfeId}`, {
      headers: { "Authorization": `Bearer ${token}` },
    })

    if (!res.ok) throw new Error(`Failed to get GFE status: ${res.status}`)
    const data = await res.json()
    return data?.payload as GfeStatus
  }

  // ── Cache helpers ─────────────────────────────────────────────────────────

  clearCaches(tenantDomain?: string) {
    if (tenantDomain) {
      delete tokenCache[tenantDomain]
      delete locationCache[tenantDomain]
      delete treatmentCache[tenantDomain]
    } else {
      Object.keys(tokenCache).forEach(k => delete tokenCache[k])
      Object.keys(locationCache).forEach(k => delete locationCache[k])
      Object.keys(treatmentCache).forEach(k => delete treatmentCache[k])
    }
  }
}

export default ProviderIntegrationService