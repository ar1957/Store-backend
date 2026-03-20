import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"

/**
 * POST /store/eligibility/submit
 *
 * 1. Gets clinic by domain
 * 2. Gets auth token
 * 3. Creates patient via provider API
 * 4. Creates GFE via provider API
 * 5. Returns virtual room URL for patient to join
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const clinicSvc = req.scope.resolve(CLINIC_MODULE) as any
    const pgConnection = req.scope.resolve("__pg_connection__") as any

    const body = req.body as any
    const {
      domain, locationId, dob, sex, pregnancy,
      medicalHistory, allergies, currentMedications,
      heightFt, heightIn, weightLbs, goalWeightLbs, bmi,
    } = body

    if (!domain || !locationId || !dob || !sex) {
      return res.status(400).json({ message: "Missing required fields" })
    }

    // 1. Get clinic
    const clinic = await clinicSvc.getClinicByDomain(domain)
    if (!clinic) return res.status(404).json({ message: "Clinic not found" })

    // 2. Get token
    const token = await clinicSvc.getToken(clinic.id)
    const baseUrl = clinic.connect_env === "production"
      ? clinic.api_base_url_prod
      : clinic.api_base_url_test

    // 3. Parse DOB
    const dobDate = new Date(dob)
    const birthYear = dobDate.getFullYear()
    const birthMonth = String(dobDate.getMonth() + 1).padStart(2, "0")
    const birthDay = String(dobDate.getDate()).padStart(2, "0")

    // 4. Create patient
    const patientPayload = {
      customerLocationId: locationId,
      dateOfBirth: `${birthYear}-${birthMonth}-${birthDay}`,
      gender: sex === "male" ? "M" : "F",
      medicalHistory: medicalHistory || "None",
      allergies: allergies || "None",
      currentMedications: currentMedications || "None",
      height: `${heightFt}'${heightIn}"`,
      weight: `${weightLbs} lbs`,
      goalWeight: `${goalWeightLbs} lbs`,
      bmi: String(bmi),
      ...(sex === "female" && pregnancy ? { pregnancyStatus: pregnancy } : {}),
    }

    const patientRes = await fetch(`${baseUrl}/patient`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(patientPayload),
    })

    if (!patientRes.ok) {
      const errText = await patientRes.text()
      console.error("Patient create error:", errText)
      return res.status(502).json({ message: `Failed to create patient: ${errText}` })
    }

    const patientData = await patientRes.json()
    const patientId = patientData?.payload?.patientId || patientData?.patientId

    if (!patientId) {
      return res.status(502).json({ message: "No patientId returned from provider" })
    }

    // 5. Create GFE
    const gfeRes = await fetch(`${baseUrl}/gfe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ patientId }),
    })

    if (!gfeRes.ok) {
      const errText = await gfeRes.text()
      console.error("GFE create error:", errText)
      return res.status(502).json({ message: `Failed to create GFE: ${errText}` })
    }

    const gfeData = await gfeRes.json()
    const gfeId = gfeData?.payload?.gfeId || gfeData?.gfeId
    const roomNo = gfeData?.payload?.roomNo || gfeData?.roomNo

    if (!gfeId || !roomNo) {
      return res.status(502).json({ message: "No gfeId/roomNo returned from provider" })
    }

    // 6. Build virtual room URL
    const connectBase = clinic.connect_env === "production"
      ? clinic.connect_url_prod
      : clinic.connect_url_test
    const redirectUrl = encodeURIComponent(clinic.redirect_url || `https://${domain}/order/status`)
    const virtualRoomUrl = `${connectBase}/connect/patient/${roomNo}${birthYear}?isFromExternal=true&redirectUrl=${redirectUrl}`

    // 7. Store GFE record for polling later (keyed to gfeId)
    const recordId = `gfe_${Date.now()}`
    await pgConnection.raw(`
      INSERT INTO order_workflow
        (id, tenant_domain, gfe_id, patient_id, room_no, virtual_room_url, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending_provider', NOW(), NOW())
      ON CONFLICT (gfe_id) DO UPDATE SET updated_at = NOW()
    `, [recordId, domain, String(gfeId), String(patientId), String(roomNo), virtualRoomUrl])

    return res.json({
      success: true,
      gfeId,
      roomNo,
      virtualRoomUrl,
      patientId,
    })
  } catch (err: unknown) {
    console.error("Eligibility submit error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Server error" })
  }
}