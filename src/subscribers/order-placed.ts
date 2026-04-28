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
    // 1. Get order with metadata + total (total lives in order_summary.totals JSONB)
    const orderResult = await pgConnection.raw(`
      SELECT o.id, o.metadata, o.email,
             COALESCE(
               (os.totals->>'current_order_total')::numeric,
               (os.totals->>'original_order_total')::numeric,
               (os.totals->>'total')::numeric,
               0
             ) AS total,
             oa.first_name, oa.last_name
      FROM "order" o
      LEFT JOIN order_address oa ON oa.id = o.shipping_address_id
      LEFT JOIN LATERAL (
        SELECT totals FROM order_summary
        WHERE order_id = o.id AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      ) os ON true
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
      logger.info(`[OrderPlaced] Order ${orderId} has no eligibility data — recording as pending_pharmacy`)
      try {
        // Resolve tenant domain from metadata or from the clinic tied to the sales channel
        let tenantDomain: string | null = metadata.tenant_domain || null
        let clinicIdNoElig: string | null = null
        if (!tenantDomain) {
          const domainResult = await pgConnection.raw(`
            SELECT id, domains[1] AS domain
            FROM clinic
            WHERE sales_channel_id = (
              SELECT sales_channel_id FROM "order" WHERE id = ? LIMIT 1
            )
            AND deleted_at IS NULL
            LIMIT 1
          `, [orderId])
          tenantDomain = domainResult.rows[0]?.domain || null
          clinicIdNoElig = domainResult.rows[0]?.id || null
        }
        if (tenantDomain) {
          const workflowId = `wf_${Date.now()}`
          await pgConnection.raw(`
            INSERT INTO order_workflow
              (id, order_id, tenant_domain, gfe_id, patient_id, room_no,
               virtual_room_url, status, created_at, updated_at)
            VALUES (?, ?, ?, NULL, NULL, NULL, NULL, 'pending_pharmacy', NOW(), NOW())
            ON CONFLICT DO NOTHING
          `, [workflowId, orderId, tenantDomain])
          await pgConnection.raw(`
            UPDATE "order" SET metadata = ?, updated_at = NOW() WHERE id = ?
          `, [JSON.stringify({ ...metadata, workflowStatus: "pending_pharmacy" }), orderId])
          if (clinicIdNoElig) {
            await createLedgerEntries(pgConnection, clinicIdNoElig, orderId, Number(order.total || 0), logger)
          }
          logger.info(`[OrderPlaced] ✓ Order ${orderId} recorded as pending_pharmacy (no eligibility data)`)
        } else {
          logger.warn(`[OrderPlaced] Could not determine tenant domain for order ${orderId} — skipping workflow record`)
        }
      } catch (e: any) {
        logger.error(`[OrderPlaced] Failed to create pending_pharmacy record: ${e.message}`)
      }
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
      // No products in this order are mapped to MHC treatments.
      // Skip patient/GFE creation entirely — order goes straight to pharmacy.
      logger.info(`[OrderPlaced] No mapped treatments for order ${orderId} — recording as pending_pharmacy, skipping MHC API`)

      const workflowId = `wf_${Date.now()}`
      await pgConnection.raw(`
        INSERT INTO order_workflow
          (id, order_id, tenant_domain, gfe_id, patient_id, room_no,
           virtual_room_url, status, created_at, updated_at)
        VALUES (?, ?, ?, NULL, NULL, NULL, NULL, 'pending_pharmacy', NOW(), NOW())
        ON CONFLICT (gfe_id) DO NOTHING
      `, [workflowId, orderId, domain])

      const updatedMetadata = {
        ...metadata,
        workflowStatus: "pending_pharmacy",
      }
      await pgConnection.raw(`
        UPDATE "order" SET metadata = ?, updated_at = NOW() WHERE id = ?
      `, [JSON.stringify(updatedMetadata), orderId])

      await createLedgerEntries(pgConnection, clinic.id, orderId, Number(order.total || 0), logger)
      logger.info(`[OrderPlaced] ✓ Order ${orderId} recorded as pending_pharmacy (no MHC GFE)`)
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

    await createLedgerEntries(pgConnection, clinic.id, orderId, Number(order.total || 0), logger)
    logger.info(`[OrderPlaced] ✓ Patient ${patientId} + GFE ${gfeId} created for order ${orderId}`)

  } catch (err) {
    logger.error(`[OrderPlaced] Error:`, err)
  }
}

export const config = {
  event: "order.placed",
}

/**
 * Creates vendor_ledger entries for both vendor types if a payout config exists.
 * Called after every order_workflow row is inserted.
 */
async function createLedgerEntries(
  pgConnection: any,
  clinicId: string,
  orderId: string,
  orderTotal: number,
  logger: any,
) {
  try {
    // Get line items for this order (product_id + quantity)
    const itemsRes = await pgConnection.raw(`
      SELECT ol.product_id, oi.quantity
      FROM order_line_item ol
      INNER JOIN order_item oi ON oi.item_id = ol.id
      WHERE oi.order_id = ? AND ol.product_id IS NOT NULL
    `, [orderId])

    if (!itemsRes.rows.length) return

    const productIds: string[] = [...new Set(itemsRes.rows.map((r: any) => r.product_id))]
    const placeholders = productIds.map(() => "?").join(", ")

    // Look up configured pharmacy costs for these products
    const costsRes = await pgConnection.raw(`
      SELECT product_id, pharmacy_cost
      FROM product_payout_cost
      WHERE clinic_id = ? AND product_id IN (${placeholders})
    `, [clinicId, ...productIds])

    if (!costsRes.rows.length) return  // no costs configured — nothing to split

    const costMap = new Map<string, number>(
      costsRes.rows.map((r: any) => [r.product_id, Number(r.pharmacy_cost)])
    )

    // pharmacy amount = sum of (cost × quantity) per line item
    let pharmacyAmount = 0
    for (const item of itemsRes.rows) {
      const cost = costMap.get(item.product_id) ?? 0
      pharmacyAmount += cost * (Number(item.quantity) || 1)
    }
    pharmacyAmount = Number(pharmacyAmount.toFixed(2))

    // clinic gets the remainder
    const clinicAmount = Number(Math.max(0, orderTotal - pharmacyAmount).toFixed(2))

    const ts = Date.now()
    if (pharmacyAmount > 0) {
      const ledgerId = `vl_${ts}_pharmacy_${orderId.slice(-6)}`
      await pgConnection.raw(`
        INSERT INTO vendor_ledger (id, clinic_id, vendor_type, order_id, order_total, amount_owed, currency, status)
        VALUES (?, ?, 'pharmacy', ?, ?, ?, 'usd', 'pending')
        ON CONFLICT DO NOTHING
      `, [ledgerId, clinicId, orderId, orderTotal, pharmacyAmount])
    }

    if (clinicAmount > 0) {
      const ledgerId = `vl_${ts + 1}_clinic_${orderId.slice(-6)}`
      await pgConnection.raw(`
        INSERT INTO vendor_ledger (id, clinic_id, vendor_type, order_id, order_total, amount_owed, currency, status)
        VALUES (?, ?, 'clinic', ?, ?, ?, 'usd', 'pending')
        ON CONFLICT DO NOTHING
      `, [ledgerId, clinicId, orderId, orderTotal, clinicAmount])
    }

    logger.info(`[OrderPlaced] ✓ Ledger entries for order ${orderId} — pharmacy $${pharmacyAmount} / clinic $${clinicAmount}`)
  } catch (e: any) {
    logger.error(`[OrderPlaced] Failed to create ledger entries: ${e.message}`)
  }
}