import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { completeCartWorkflow } from "@medusajs/core-flows"
import { Modules } from "@medusajs/framework/utils"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const { cartId } = req.body as any
    const pg = req.scope.resolve("__pg_connection__") as any

    if (!cartId) {
      return res.status(400).json({ message: "cartId is required" })
    }

    // For zero-total carts (100% promo applied before checkout loaded), the
    // storefront skips initiatePaymentSession so no session exists. Without a
    // session, completeCartWorkflow has nothing to authorize and the order lands
    // as "not_paid". Create a pp_system_default session now so the workflow can
    // authorize it and the order will show "captured".
    //
    // Safety guard: only runs when session_count=0 AND cart total is zero.
    try {
      const cartState = await pg.raw(`
        SELECT c.currency_code,
               cpc.payment_collection_id AS pc_id,
               COALESCE(pc.amount, -1)   AS pc_amount,
               COALESCE(
                 (SELECT COUNT(*) FROM payment_session ps
                  WHERE ps.payment_collection_id = cpc.payment_collection_id
                  AND ps.deleted_at IS NULL), 0
               ) AS session_count
        FROM cart c
        LEFT JOIN cart_payment_collection cpc ON cpc.cart_id = c.id
        LEFT JOIN payment_collection pc
          ON pc.id = cpc.payment_collection_id AND pc.deleted_at IS NULL
        WHERE c.id = ? LIMIT 1
      `, [cartId])

      const row = cartState.rows[0]
      const sessionCount = Number(row?.session_count ?? 1)
      const pcAmount     = Number(row?.pc_amount ?? -1)
      const noCollection = !row?.pc_id
      const isZeroTotal  = noCollection || pcAmount === 0

      if (sessionCount === 0 && isZeroTotal) {
        const paymentMod = req.scope.resolve(Modules.PAYMENT) as any
        const currency   = row?.currency_code || 'usd'
        let pcId: string = row?.pc_id ?? null

        if (!pcId) {
          const [pc] = await paymentMod.createPaymentCollections([{
            currency_code: currency,
            amount: 0,
          }])
          pcId = pc.id
          await pg.raw(
            `INSERT INTO cart_payment_collection (id, cart_id, payment_collection_id, created_at, updated_at) VALUES (gen_random_uuid()::text, ?, ?, NOW(), NOW()) ON CONFLICT DO NOTHING`,
            [cartId, pcId]
          )
        } else if (pcAmount !== 0) {
          await paymentMod.updatePaymentCollections([{ id: pcId, amount: 0 }])
        }

        await paymentMod.createPaymentSession(pcId, {
          provider_id: "pp_system_default",
          currency_code: currency,
          amount: 0,
          data: {},
        })
      }
    } catch (preErr: any) {
      console.warn("[complete-cart] Pre-workflow session setup failed (non-fatal):", preErr.message)
    }

    const { result } = await completeCartWorkflow(req.scope).run({
      input: { id: cartId },
    })

    const r = result as any

    // completeCartWorkflow returns { id: orderId } — extract the order ID
    const orderId: string | null =
      r?.id ||
      r?.order?.id ||
      null

    if (orderId) {
      return res.json({ type: "order", order: { id: orderId } })
    }

    // Fallback: result didn't carry an ID. Query order_cart to find the created order.
    try {
      const ocResult = await pg.raw(
        `SELECT order_id FROM order_cart WHERE cart_id = ? LIMIT 1`,
        [cartId]
      )
      if (ocResult.rows.length && ocResult.rows[0].order_id) {
        return res.json({ type: "order", order: { id: ocResult.rows[0].order_id } })
      }
    } catch (fbErr) {
      console.error("[complete-cart] order_cart fallback query failed:", fbErr)
    }

    return res.json({ type: "cart", cart: r })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Error"
    if (msg.includes("409") || msg.includes("already being completed") || msg.includes("conflicted")) {
      return res.status(409).json({ message: msg })
    }
    console.error("[complete-cart] error:", err)
    return res.status(500).json({ message: msg })
  }
}
