/**
 * scripts/backfill-stripe-order-metadata.js
 *
 * One-time backfill: tags every existing order's Stripe PaymentIntent with
 * { orderId, orderDisplayId } metadata, so support can search Stripe's
 * dashboard directly by Medusa order number instead of having to look up
 * the cart_id first. Going forward this happens automatically for every
 * new order via src/subscribers/order-placed.ts — this script only covers
 * orders placed before that change shipped.
 *
 * Idempotent — safe to re-run. Skips any PaymentIntent whose metadata
 * already has the correct orderDisplayId, and metadata updates merge with
 * (rather than replace) existing keys, so cartId/clinicId/clinicName/domain
 * set at PaymentIntent creation are never touched.
 *
 * Usage (run from the my-medusa-store directory, same as manual-migrate.js):
 *   node scripts/backfill-stripe-order-metadata.js            # dry run — reports what it would do, writes nothing
 *   node scripts/backfill-stripe-order-metadata.js --live     # actually writes to Stripe
 */
require("dotenv").config()
const { Pool } = require("pg")
const Stripe = require("stripe")

const LIVE = process.argv.includes("--live")

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function run() {
  console.log(`Starting Stripe order-metadata backfill (${LIVE ? "LIVE — will write to Stripe" : "DRY RUN — no writes, use --live to apply"})...\n`)

  const ordersResult = await pool.query(`
    SELECT o.id AS order_id, o.display_id, cl.id AS clinic_id, cl.name AS clinic_name,
           cl.stripe_secret_key, pay.data->>'id' AS pi_id
    FROM "order" o
    JOIN order_payment_collection opc ON opc.order_id = o.id
    JOIN payment_collection pc ON pc.id = opc.payment_collection_id
    JOIN payment pay ON pay.payment_collection_id = pc.id
    LEFT JOIN clinic cl ON cl.sales_channel_id = o.sales_channel_id
    WHERE o.deleted_at IS NULL
      AND pay.data->>'id' LIKE 'pi_%'
    ORDER BY o.display_id ASC
  `)

  const rows = ordersResult.rows
  console.log(`Found ${rows.length} order(s) with a Stripe PaymentIntent.\n`)

  let tagged = 0
  let alreadyTagged = 0
  let skippedNoKey = 0
  let skippedNoPi = 0
  let errors = 0
  const stripeClients = new Map() // clinic_id -> Stripe instance, reused per clinic

  for (const row of rows) {
    const { order_id, display_id, clinic_id, clinic_name, stripe_secret_key, pi_id } = row

    if (!pi_id) {
      skippedNoPi++
      continue
    }
    if (!stripe_secret_key) {
      console.log(`  ⚠ Order #${display_id} (${clinic_name || "unknown clinic"}) — no Stripe key configured, skipping`)
      skippedNoKey++
      continue
    }

    if (!stripeClients.has(clinic_id)) {
      stripeClients.set(clinic_id, new Stripe(stripe_secret_key, { apiVersion: "2024-06-20" }))
    }
    const stripe = stripeClients.get(clinic_id)

    try {
      const existing = await stripe.paymentIntents.retrieve(pi_id)
      if (existing.metadata?.orderDisplayId === String(display_id)) {
        alreadyTagged++
        continue
      }

      if (LIVE) {
        await stripe.paymentIntents.update(pi_id, {
          metadata: { orderId: order_id, orderDisplayId: String(display_id) },
        })
        console.log(`  ✓ Order #${display_id} (${clinic_name}) — tagged ${pi_id}`)
      } else {
        console.log(`  → Order #${display_id} (${clinic_name}) — would tag ${pi_id}`)
      }
      tagged++
    } catch (e) {
      console.error(`  ✗ Order #${display_id} (${clinic_name}) — error: ${e.message}`)
      errors++
    }

    // Be polite to Stripe's rate limits — trivial at this volume, but harmless.
    await new Promise(r => setTimeout(r, 150))
  }

  console.log(`\nDone.`)
  console.log(`  ${LIVE ? "Tagged" : "Would tag"}: ${tagged}`)
  console.log(`  Already tagged (skipped): ${alreadyTagged}`)
  console.log(`  No Stripe key configured: ${skippedNoKey}`)
  console.log(`  No PaymentIntent found (non-Stripe payment method): ${skippedNoPi}`)
  console.log(`  Errors: ${errors}`)
  if (!LIVE) console.log(`\nThis was a dry run — nothing was written. Re-run with --live to apply.`)

  await pool.end()
}

run().catch(e => {
  console.error("Fatal:", e.message)
  process.exit(1)
})
