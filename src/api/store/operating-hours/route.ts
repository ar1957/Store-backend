/**
 * GET /store/operating-hours
 * Returns MHC operating hours for the current tenant, with isOpen computed in PST.
 * Authenticates with the MHC API using the clinic's api_client_id/secret.
 * Token cached 50 min; hours result cached 60s.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Pool } from "pg"

const pool = new Pool({ connectionString: process.env.DATABASE_URL, min: 1, max: 3 })
const TZ   = "America/Los_Angeles"

interface HourEntry {
  id: number
  day: number
  startTime: string
  endTime: string
}

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const DAY_SHORT  = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function parseMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number)
  return h * 60 + m
}

function formatTime(t: string): string {
  const [h, m] = t.split(":").map(Number)
  const ampm = h >= 12 ? "PM" : "AM"
  const h12  = h % 12 || 12
  return m === 0 ? `${h12} ${ampm}` : `${h12}:${m.toString().padStart(2, "0")} ${ampm}`
}

function computeIsOpen(schedule: HourEntry[]): boolean {
  try {
    const nowPT  = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }))
    const day    = nowPT.getDay()
    const nowMin = nowPT.getHours() * 60 + nowPT.getMinutes()
    const entry  = schedule.find(e => e.day === day)
    if (!entry) return false
    return nowMin >= parseMinutes(entry.startTime) && nowMin < parseMinutes(entry.endTime)
  } catch {
    return true
  }
}

function groupSchedule(schedule: HourEntry[]): string[] {
  const sorted = [...schedule].sort((a, b) => (a.day === 0 ? 7 : a.day) - (b.day === 0 ? 7 : b.day))
  const groups: { days: number[]; start: string; end: string }[] = []
  for (const e of sorted) {
    const last = groups[groups.length - 1]
    if (last && last.start === e.startTime && last.end === e.endTime) {
      last.days.push(e.day)
    } else {
      groups.push({ days: [e.day], start: e.startTime, end: e.endTime })
    }
  }
  return groups.map(g => {
    const first  = g.days[0]
    const last   = g.days[g.days.length - 1]
    const dayStr = g.days.length === 1
      ? DAY_LABELS[first]
      : `${DAY_SHORT[first]}–${DAY_SHORT[last]}`
    return `${dayStr}: ${formatTime(g.start)} – ${formatTime(g.end)}`
  })
}

// Token cache keyed by clinic id — 50 min TTL (MHC tokens last ~60 min)
const tokenCache = new Map<string, { token: string; expiresAt: number }>()

async function getToken(clinicId: string, baseUrl: string, clientId: string, clientSecret: string): Promise<string> {
  const cached = tokenCache.get(clinicId)
  if (cached && Date.now() < cached.expiresAt) return cached.token

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64")
  const res = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Basic ${basicAuth}`,
      "ClientId":      clientId,
      "ClientSecret":  clientSecret,
    },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`MHC login ${res.status}`)
  const data = await res.json()
  const token = data?.token || data?.payload?.token
  if (!token) throw new Error("No token in MHC login response")

  tokenCache.set(clinicId, { token, expiresAt: Date.now() + 50 * 60 * 1000 })
  return token
}

// Hours result cache keyed by the operating-hours URL — 60s TTL
const hoursCache = new Map<string, { payload: object; ts: number }>()
const CACHE_TTL = 60_000

const FAIL_OPEN = { isOpen: true, schedule: [], formattedHours: [], timezone: "Pacific Time (PT)" }

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const host   = ((req.headers["x-forwarded-host"] || req.headers["host"] || "") as string)
    const domain = host.split(":")[0]

    const result = await pool.query(
      `SELECT id, api_env, api_base_url_test, api_base_url_prod,
              api_client_id, api_client_secret
       FROM clinic
       WHERE ($1 = ANY(domains) OR $2 = ANY(domains))
         AND deleted_at IS NULL
       LIMIT 1`,
      [host, domain]
    )

    const clinic = result.rows[0]
    if (!clinic?.api_client_id || !clinic?.api_client_secret) {
      console.error("[operating-hours] No clinic credentials found for host:", host)
      return res.json(FAIL_OPEN)
    }

    const baseUrl = clinic.api_env === "prod"
      ? (clinic.api_base_url_prod || "https://api.healthcoversonline.com/endpoint/v2")
      : (clinic.api_base_url_test || "https://api-dev.healthcoversonline.com/endpoint/v2")

    const origin   = new URL(baseUrl).origin
    const hoursUrl = `${origin}/api/operatinghour`

    // Serve from cache if fresh
    const cached = hoursCache.get(hoursUrl)
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return res.json(cached.payload)
    }

    const token    = await getToken(clinic.id, baseUrl, clinic.api_client_id, clinic.api_client_secret)
    const upstream = await fetch(hoursUrl, {
      headers: { "Authorization": `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    })

    if (!upstream.ok) throw new Error(`MHC hours ${upstream.status}`)
    const json     = await upstream.json()
    const schedule: HourEntry[] = json.payload ?? []

    const payload = {
      isOpen:         computeIsOpen(schedule),
      schedule,
      formattedHours: groupSchedule(schedule),
      timezone:       "Pacific Time (PT)",
    }

    hoursCache.set(hoursUrl, { payload, ts: Date.now() })
    return res.json(payload)

  } catch (err: any) {
    console.error("[operating-hours]", err?.message)
    return res.json(FAIL_OPEN)
  }
}
