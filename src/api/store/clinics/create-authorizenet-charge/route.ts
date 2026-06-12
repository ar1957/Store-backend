import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { generateEntityId } from "@medusajs/utils"

/**
 * POST /store/clinics/create-authorizenet-charge
 *
 * Charges a card via the clinic's own Authorize.net account.
 *
 * Production (HTTPS): storefront tokenizes via Accept.js and sends opaqueData.
 * Sandbox / local dev (HTTP): storefront sends raw card fields directly;
 *   backend submits them to Authorize.net's sandbox API server-side.
 *
 * Body: {
 *   domain: string
 *   amount: number          (in cents)
 *   currency?: string
 *   cartId: string
 *   // Accept.js path (production):
 *   opaqueDataDescriptor?: string
 *   opaqueDataValue?: string
 *   // Direct card path (sandbox only):
 *   cardNumber?: string
 *   cardMonth?: string
 *   cardYear?: string
 *   cardCode?: string
 * }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const body = req.body as any
    const {
      domain, amount, currency = "usd", cartId,
      opaqueDataDescriptor, opaqueDataValue,
      cardNumber, cardMonth, cardYear, cardCode,
    } = body

    const hasOpaqueData = opaqueDataDescriptor && opaqueDataValue
    const hasCardData = cardNumber && cardMonth && cardYear && cardCode

    if (!domain || !amount || !cartId || (!hasOpaqueData && !hasCardData)) {
      return res.status(400).json({ message: "domain, amount, cartId, and either opaqueData or card fields are required" })
    }

    // 1. Get clinic's Authorize.net credentials
    // Match exact domain OR hostname-only (strips port from stored domains) OR slug
    const clinicResult = await pg.raw(
      `SELECT id, name, authorizenet_api_login_id, authorizenet_transaction_key, authorizenet_mode
       FROM clinic
       WHERE ? = ANY(domains)
          OR ? = ANY(SELECT split_part(d, ':', 1) FROM unnest(domains) AS d)
          OR slug = ?
       LIMIT 1`,
      [domain, domain, domain]
    )
    const clinic = clinicResult.rows[0]
    if (!clinic) return res.status(404).json({ message: "Clinic not found" })
    if (!clinic.authorizenet_api_login_id || !clinic.authorizenet_transaction_key) {
      return res.status(400).json({ message: "Authorize.net not configured for this clinic" })
    }

    const isSandbox = clinic.authorizenet_mode !== "production"
    const apiUrl = isSandbox
      ? "https://apitest.authorize.net/xml/v1/request.api"
      : "https://api.authorize.net/xml/v1/request.api"

    // Direct card path only allowed in sandbox
    if (hasCardData && !hasOpaqueData && !isSandbox) {
      return res.status(400).json({ message: "Direct card submission is only allowed in sandbox mode" })
    }

    const payment = hasOpaqueData
      ? { opaqueData: { dataDescriptor: opaqueDataDescriptor, dataValue: opaqueDataValue } }
      : { creditCard: { cardNumber: cardNumber.replace(/\s/g, ""), expirationDate: `${cardMonth}/${cardYear}`, cardCode } }

    // 2. Submit charge to Authorize.net
    const authnetPayload = {
      createTransactionRequest: {
        merchantAuthentication: {
          name: clinic.authorizenet_api_login_id,
          transactionKey: clinic.authorizenet_transaction_key,
        },
        transactionRequest: {
          transactionType: "authCaptureTransaction",
          amount: (amount / 100).toFixed(2), // Authorize.net uses dollars, not cents
          payment,
          order: {
            invoiceNumber: cartId.slice(0, 20),
          },
          userFields: {
            userField: [
              { name: "cartId", value: cartId },
              { name: "clinicId", value: clinic.id },
            ],
          },
        },
      },
    }

    const authnetRes = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(authnetPayload),
    })

    const authnetData = await authnetRes.json() as any

    // Strip the BOM that Authorize.net sometimes prepends to their JSON
    const txnResponse = authnetData?.transactionResponse
    const messages = authnetData?.messages

    if (messages?.resultCode !== "Ok" || !txnResponse) {
      const errMsg = messages?.message?.[0]?.text || "Authorize.net charge failed"
      console.error("[create-authorizenet-charge] API error:", JSON.stringify(authnetData))
      return res.status(400).json({ message: errMsg })
    }

    if (txnResponse.responseCode !== "1") {
      const errMsg = txnResponse.errors?.[0]?.errorText || txnResponse.messages?.[0]?.description || "Card declined"
      console.error("[create-authorizenet-charge] Transaction declined:", JSON.stringify(txnResponse))
      return res.status(400).json({ message: errMsg })
    }

    const transactionId = txnResponse.transId
    // accountNumber comes back as "XXXX1234" — extract last 4 for refunds
    const last4 = (txnResponse.accountNumber || "").slice(-4) || null
    const accountType = txnResponse.accountType || null
    console.log(`[create-authorizenet-charge] Transaction approved: ${transactionId} last4: ${last4}`)

    // 3. Mark payment authorized in Medusa — same pattern as mark-payment-authorized
    const sessionResult = await pg.raw(`
      SELECT ps.id, ps.amount, ps.currency_code, ps.payment_collection_id, ps.provider_id
      FROM payment_session ps
      WHERE ps.payment_collection_id = (
        SELECT payment_collection_id FROM cart WHERE id = ? LIMIT 1
      )
      AND ps.status = 'pending'
      ORDER BY ps.created_at DESC
      LIMIT 1
    `, [cartId])

    if (!sessionResult.rows.length) {
      return res.status(404).json({ message: "No pending payment session found for cart" })
    }

    const session = sessionResult.rows[0]
    const sessionAmount = session.amount
    const rawAmount = JSON.stringify({ value: String(sessionAmount), precision: 20 })
    const intentData = { id: transactionId, status: "approved", amount, currency, provider: "authorizenet", last4, accountType }

    const existingPayment = await pg.raw(
      `SELECT id FROM payment WHERE payment_session_id = ? LIMIT 1`,
      [session.id]
    )

    if (existingPayment.rows.length) {
      // Already recorded — idempotent
      return res.json({ success: true, transactionId, sessionId: session.id, paymentId: existingPayment.rows[0].id })
    }

    await pg.raw(
      `UPDATE payment_session SET status = 'authorized', authorized_at = NOW(), updated_at = NOW() WHERE id = ?`,
      [session.id]
    )

    const paymentId = generateEntityId("", "pay")
    await pg.raw(`
      INSERT INTO payment (id, amount, raw_amount, currency_code, provider_id, payment_collection_id, payment_session_id, data, captured_at, created_at, updated_at)
      VALUES (?, ?, ?::jsonb, ?, ?, ?, ?, ?::jsonb, NOW(), NOW(), NOW())
    `, [paymentId, sessionAmount, rawAmount, session.currency_code, session.provider_id,
        session.payment_collection_id, session.id, JSON.stringify(intentData)])

    const captureId = generateEntityId("", "capt")
    await pg.raw(`
      INSERT INTO capture (id, amount, raw_amount, payment_id, created_at, updated_at)
      VALUES (?, ?, ?::jsonb, ?, NOW(), NOW())
    `, [captureId, sessionAmount, rawAmount, paymentId])

    await pg.raw(`
      UPDATE payment_collection
      SET status = 'completed', authorized_amount = ?, raw_authorized_amount = ?::jsonb,
          captured_amount = ?, raw_captured_amount = ?::jsonb, updated_at = NOW()
      WHERE id = ?
    `, [sessionAmount, rawAmount, sessionAmount, rawAmount, session.payment_collection_id])

    console.log(`[create-authorizenet-charge] Payment recorded: ${paymentId}`)

    return res.json({ success: true, transactionId, sessionId: session.id, paymentId, captureId })

  } catch (err: unknown) {
    console.error("[create-authorizenet-charge] error:", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
