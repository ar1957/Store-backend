/**
 * Order Placed Subscriber
 * File: src/subscribers/order-placed.ts
 *
 * Fires when an order is placed (payment captured).
 * Reads eligibility answers from order metadata,
 * creates patient + GFE via provider API,
 * stores virtual room URL in order_workflow table.
 */

import { IEventBusModuleService } from "@medusajs/framework/types"
import { MedusaContainer } from "@medusajs/framework"

const CLINIC_MODULE = "clinic"

export default async function orderPlacedHandler({
  event,
  container,
}: {
  event: { data: { id: string } }
  container: MedusaContainer
}) {
  const logger = container.resolve("logger") as any
  const clinicSvc = container.resolve(CLINIC_MODULE) as any
  const pgConnection = container.resolve("__pg_connection__") as any

  const orderId = event.data.id
  logger.info(`[OrderPlaced] Processing order ${orderId}`)

  try {
    // 1. Get order with metadata
    const orderResult = await pgConnection.raw(`
      SELECT o.id, o.metadata, o.email,
             oa.first_name, oa.last_name
      FROM "order" o
      LEFT JOIN order_address oa ON oa.id = o.shipping_address_id
      WHERE o.id = ?
      LIMIT 1
    `, [orderId])

    if (!orderResult.rows.length) {
      logger.warn(`[OrderPlaced] Order ${orderId} not found`)
      return
    }

    const order = orderResult.rows[0]
    const metadata = order.metadata || {}
    const eligibility = metadata.eligibility

    if (!eligibility) {
      logger.info(`[OrderPlaced] Order ${orderId} has no eligibility data — skipping GFE creation`)
      return
    }

    const { domain, locationId, dob, sex, pregnancy,
      medicalHistory, allergies, currentMedications,
      heightFt, heightIn, weightLbs, goalWeightLbs, bmi } = eligibility

    // 2. Get clinic
    const clinic = await clinicSvc.getClinicByDomain(domain)
    if (!clinic) {
      logger.error(`[OrderPlaced] No clinic found for domain: ${domain}`)
      return
    }

    // 3. Get token
    const token = await clinicSvc.getToken(clinic.id)
    const baseUrl = clinic.api_env === "prod"
      ? clinic.api_base_url_prod
      : clinic.api_base_url_test

    // 4. Parse DOB
    const dobDate = new Date(dob)
    const birthYear = dobDate.getFullYear()
    const birthMonth = String(dobDate.getMonth() + 1).padStart(2, "0")
    const birthDay = String(dobDate.getDate()).padStart(2, "0")

    // 5. Create patient
    // Name priority: shipping address > email prefix > fallback
    const firstName = order.first_name ||
      (order.email ? order.email.split("@")[0] : "Patient")
    const lastName = order.last_name || "."

    const patientPayload = {
      firstname: firstName,
      lastname: lastName,
      dob: `${birthYear}-${birthMonth}-${birthDay}`,
      medicalHistory: {
        "1": `BMI: ${bmi} | Height: ${heightFt}'${heightIn}" | Weight: ${weightLbs}lbs | Goal: ${goalWeightLbs}lbs`,
        "2": medicalHistory && medicalHistory !== "None" ? medicalHistory : "None",
        "3": allergies && allergies !== "None" ? allergies : "None",
        "4": currentMedications && currentMedications !== "None" ? currentMedications : "None",
        "5": "None",
        "6": sex === "female" && pregnancy && pregnancy !== "none" ? pregnancy : "false",
      },
    }

    logger.info(`[OrderPlaced] Patient request body: ${JSON.stringify(patientPayload)}`)

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
      logger.error(`[OrderPlaced] Failed to create patient: ${errText}`)
      return
    }

    const patientData = await patientRes.json()
    logger.info(`[OrderPlaced] Patient API response: ${JSON.stringify(patientData)}`)
    const patientId = patientData?.payload?.id || patientData?.payload?.patientId || patientData?.patientId || patientData?.id

    if (!patientId) {
      logger.error(`[OrderPlaced] No patientId returned`)
      return
    }

    // 6. Look up treatment IDs from product_treatment_map for this order
    const orderItemsResult = await pgConnection.raw(`
      SELECT ol.variant_id, ol.product_id
      FROM order_line_item ol
      INNER JOIN order_item oi ON oi.item_id = ol.id
      WHERE oi.order_id = ?
    `, [orderId])

    const productIds = orderItemsResult.rows.map((r: any) => r.product_id).filter(Boolean)

    let treatmentIds: number[] = []
    if (productIds.length > 0) {
      // Use ALL clinic domains so mappings saved under any domain alias are found
      const allDomains = clinic.domains || [domain]
      if (!allDomains.includes(domain)) allDomains.push(domain)
      const domainPlaceholders = allDomains.map(() => "?").join(", ")
      const productPlaceholders = productIds.map(() => "?").join(", ")
      const mappingResult = await pgConnection.raw(`
        SELECT DISTINCT treatment_id FROM product_treatment_map
        WHERE tenant_domain IN (${domainPlaceholders}) AND product_id IN (${productPlaceholders})
      `, [...allDomains, ...productIds])
      treatmentIds = mappingResult.rows
        .map((r: any) => Number(r.treatment_id))
        .filter(Boolean)
    }

    if (treatmentIds.length === 0) {
      logger.warn(`[OrderPlaced] No treatment mappings found for order ${orderId} — skipping GFE creation. Order will be fulfilled outside the clinic workflow.`)
      return
    }

    // 7. Create GFE
    const gfeRes = await fetch(`${baseUrl}/gfe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        patientId,
        customerLocationId: Number(locationId),
        treatments: treatmentIds,
      }),
    })

    if (!gfeRes.ok) {
      const errText = await gfeRes.text()
      logger.error(`[OrderPlaced] Failed to create GFE: ${errText}`)
      return
    }

    const gfeData = await gfeRes.json()
    logger.info(`[OrderPlaced] GFE API response: ${JSON.stringify(gfeData)}`)
    const gfeId = gfeData?.payload?.gfeId || gfeData?.gfeId
    const roomNo = gfeData?.payload?.roomNo || gfeData?.roomNo

    if (!gfeId || !roomNo) {
      logger.error(`[OrderPlaced] No gfeId/roomNo returned`)
      return
    }

    // 7. Build virtual room URL
    const connectBase = (clinic.api_env === "prod"
      ? clinic.connect_url_prod
      : clinic.connect_url_test).replace(/\/+$/, "")
    const redirectUrl = encodeURIComponent(
      clinic.redirect_url || `https://${domain}/order/status`
    )
    const virtualRoomUrl = `${connectBase}/connect/patient/${roomNo}${birthYear}?isFromExternal=true&redirectUrl=${redirectUrl}`

    // 8. Save to order_workflow
    const workflowId = `wf_${Date.now()}`
    await pgConnection.raw(`
      INSERT INTO order_workflow
        (id, order_id, tenant_domain, gfe_id, patient_id, room_no,
         virtual_room_url, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_provider', NOW(), NOW())
      ON CONFLICT (gfe_id) DO UPDATE
        SET order_id = EXCLUDED.order_id, updated_at = NOW()
    `, [workflowId, orderId, domain, String(gfeId), String(patientId),
        String(roomNo), virtualRoomUrl])

    // 9. Update order metadata with gfeId and virtualRoomUrl for storefront
    const updatedMetadata = {
      ...metadata,
      gfeId: String(gfeId),
      virtualRoomUrl,
      workflowStatus: "pending_provider",
    }
    await pgConnection.raw(`
      UPDATE "order" SET metadata = ?, updated_at = NOW() WHERE id = ?
    `, [JSON.stringify(updatedMetadata), orderId])

    logger.info(`[OrderPlaced] ✓ Patient ${patientId} + GFE ${gfeId} created for order ${orderId}`)

  } catch (err) {
    logger.error(`[OrderPlaced] Error:`, err)
  }
}

export const config = {
  event: "order.placed",
}