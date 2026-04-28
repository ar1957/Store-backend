# MHC Store — Developer Handoff Context

## Project Overview
Multi-tenant Medusa v2 backend + Next.js 15 storefront. Each clinic/store is a tenant with its own domain, branding, Stripe keys, PayPal keys, and GFE (telehealth) API credentials. The admin UI is a custom Medusa admin extension.

## Workspaces
- `my-medusa-store` — Medusa v2 backend (port 9000)
- `my-medusa-store-storefront` — Next.js 15 storefront (port 8000)

---

## AWS Deployment

### Infrastructure — TEST
- **Backend**: `medusa-backend-test.eba-t6prye2p.us-west-1.elasticbeanstalk.com`
- **Frontend**: `medusa-storefront-test.eba-jmypnpmk.us-west-1.elasticbeanstalk.com`
- **Database**: `medusa-db-test.czojurt1hrt9.us-west-1.rds.amazonaws.com`

### Infrastructure — PROD
- **Backend**: `api.mhc-clinic-admin.com` (EB: `medusa-backend-prod`)
- **Frontend**: `medusa-storefront-prod` EB environment
- **Database**: `medusa-db-prod.czojurt1hrt9.us-west-1.rds.amazonaws.com` (db: `medusa_prod`)
- **Admin UI**: `https://mhc-clinic-admin.com/app`
- **Spaderx storefront**: `https://shop.spaderx.com`

### CI/CD
- AWS CodeBuild + CodePipeline
- Backend: `my-medusa-store` repo → `buildspec.yml` → EB deploy
- Storefront: `my-medusa-store-storefront` repo → `buildspec.yml` → EB deploy
- `NEXT_PUBLIC_*` vars must be set in **CodeBuild** environment (baked at build time), not just EB

### Critical: postbuild.js
`scripts/postbuild.js` runs after `medusa build` and:
1. Writes routes that Medusa build silently skips: `test-connection/route.js`, `test-pharmacy/route.js`, `dashboard/route.js`, promotions routes, send-reminder route
2. Patches admin login branding ("Welcome to Medusa" → "MHC Clinic Administration")
3. Patches `@medusajs/file-s3` to disable ACL (bucket uses bucket policy)

### Critical: ebextension
`.ebextensions/01_setup.config` runs on every EB deploy:
- Adds swap space
- Fixes file permissions
- Runs `manual-migrate.js` (custom schema)
- **Does NOT run `medusa db:migrate`** — removed because it times out and exhausts DB connection pool
- Patches S3 ACL
- Fixes localhost image URLs

### EB Environment Variables (Backend)
- `DATABASE_URL`, `MEDUSA_BACKEND_URL`, `ADMIN_CORS`, `AUTH_CORS`, `STORE_CORS`
- `JWT_SECRET`, `COOKIE_SECRET`, `STRIPE_API_KEY`
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`
- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_MODE`
- `S3_BUCKET=gocbeglobal-dev`, `S3_REGION=us-west-1`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
- `S3_PREFIX=prod-images/` (prod) or `test-images/` (test) — controls S3 folder
- `NODE_ENV=production`, `PORT=9000`

### EB Environment Variables (Storefront)
- `NEXT_PUBLIC_MEDUSA_BACKEND_URL`, `MEDUSA_BACKEND_URL` — backend URL
- `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` — default sales channel key (also set in CodeBuild)
- `NEXT_PUBLIC_DEFAULT_REGION=us`
- `NEXT_PUBLIC_GOOGLE_PLACES_KEY`
- `NEXT_PUBLIC_STRIPE_KEY`
- `DATABASE_URL` — same RDS as backend (for direct DB queries in storefront API routes)
- `REVALIDATE_SECRET`, `NODE_ENV=production`, `PORT=8080`

### Nginx Config (Storefront)
`.platform/nginx/conf.d/elasticbeanstalk/host-header.conf` — sets `X-Forwarded-Host: $host` so Next.js middleware gets the real domain (e.g. `shop.spaderx.com`) instead of the internal EC2 IP. **Critical for multi-tenant resolution behind ALB.**

After any manual `sudo systemctl restart web`, must also run `sudo systemctl reload nginx` to re-apply this config.

### Migrations
Custom migrations in `src/modules/provider-integration/migrations/` (Migration20240101000001 through **Migration20240101000012**).
Run manually on server:
```bash
export DATABASE_URL=$(/opt/elasticbeanstalk/bin/get-config environment --key DATABASE_URL)
cd /var/app/current/.medusa/server && node /var/app/current/scripts/manual-migrate.js
```

---

## Architecture

### Multi-Tenancy
- Each clinic has a record in the `clinic` table with `domains[]`, `publishable_api_key`, `stripe_publishable_key`, etc.
- Storefront middleware (`src/middleware.ts`) reads `x-forwarded-host` (set by nginx) → calls `/store/clinics/tenant-config` → injects `window.__TENANT_API_KEY__` and `window.__TENANT_DOMAIN__`
- CORS for clinic domains handled dynamically by `src/api/middlewares.ts` (60s cache)

### Key Custom Tables
- `clinic` — tenant config (domains, API keys, branding, pharmacy config, from_email, from_name, **payment_provider, paypal_client_id, paypal_client_secret, paypal_mode**)
- `clinic_staff` — staff members per clinic with roles
- `order_workflow` — tracks GFE/telehealth order lifecycle + pharmacy submission
- `order_comment` — comments on orders
- `product_treatment_map` — maps Medusa products to GFE treatments
- `clinic_ui_config` — nav/footer links, logo, contact info per clinic
- `clinic_promotion` — maps Medusa promotion IDs to clinics (per-clinic promotion scoping)
- `vendor_payout_config` — bank details for clinic + pharmacy vendors (routing, account numbers). One row per clinic. No split % — amounts derived from product costs.
- `product_payout_cost` — pharmacy cost per product per clinic. `pharmacy_cost` × qty = what pharmacy receives per line item. Clinic receives remainder.
- `vendor_ledger` — one row per vendor type ('clinic'|'pharmacy') per order. Created when payment is recorded. `status` = 'pending'|'paid'. `payout_id` links to vendor_payout.
- `vendor_payout` — one disbursement record per Pay Out action. Stores `reference_number` (ACH/wire trace #), `total_amount`, `paid_at`. One payout can cover many orders.

### Roles
- `super_admin` — sees everything including Clinic Dashboard
- `clinic_admin` — sees clinic-orders, products, clinic operations (read-only on Details/API tabs), **can manage their own clinic's promotions**
- `pharmacist` / `medical_director` — sees clinic-orders only, no dashboard

### Payment Providers (per-clinic)
Each clinic can choose `payment_provider`: `stripe`, `paypal`, or `both`.
- Stripe keys: `stripe_publishable_key`, `stripe_secret_key` on clinic table
- PayPal keys: `paypal_client_id`, `paypal_client_secret`, `paypal_mode` on clinic table
- Backend provider: `medusa-plugin-paypal` (id: `payment-paypal`)
- Storefront reads `payment_provider` from `/store/clinics/tenant-config` and loads the appropriate SDK
- Admin UI: API & Credentials tab has Payment Provider selector + PayPal fields

### Per-Clinic Promotions
- `clinic_promotion` table links Medusa promotion IDs to clinic IDs
- API: `GET/POST /admin/clinics/:id/promotions`, `DELETE /admin/clinics/:id/promotions/:promotionId`
- `GET /admin/promotions-list` — lists all Medusa promotions for the assignment dropdown
- Admin UI: Promotions tab in Clinic Operations (visible to clinic_admin and super_admin)
- clinic_admin can only see/manage their own clinic's promotions
- super_admin can assign any promotion to any clinic and see all

### Email
Uses Resend. Domain `mhc-clinic-admin.com` verified in Resend.
Templates: `order.confirmation`, `order.status_update`, `order.shipped`, `order.md_denied`, `order.refund_issued`, `order.pending_provider_reminder` — all in `src/modules/resend/service.ts`.
Per-clinic `from_email`, `from_name`, `reply_to` stored on clinic table.
Email subscriber joins clinic via `sales_channel_id` fallback (not just `tenant_domain`) to handle race condition where `order_workflow` doesn't exist yet when confirmation fires.

---

## Order Workflow / GFE Flow

1. Patient places order → `order.placed` event fires
2. `order-placed.ts` subscriber creates patient + GFE via provider API → saves `virtual_room_url` to `order_workflow`
3. GFE poll job (`src/jobs/poll-gfe-status.ts`) checks provider status every 5 min → auto-submits to pharmacy on approval
4. If provider **approves** → status = `processing_pharmacy` → auto-submit to pharmacy API
5. If provider **defers** → status = `pending_md_review` → MD reviews in admin → approves → `processing_pharmacy` → auto-submit
6. Pharmacy poll job (`src/jobs/pharmacy-poll.ts`) checks pharmacy status every 5 min → updates tracking when shipped
7. Daily reminder job (`src/jobs/pending-provider-reminder.ts`) runs at 1AM → emails patients still in `pending_provider`

### Order Statuses
`pending_provider` → `pending_md_review` (if deferred) → `processing_pharmacy` → `shipped` → (or `md_denied` / `refund_issued`)

---

## Pharmacy Integration

### Supported Pharmacies
1. **DigitalRX (SmartConnect)** — `pharmacy_type = "digitalrx"`
2. **Partell Pharmacy (RequestMyMeds)** — `pharmacy_type = "rmm"`
   - Sandbox: `https://requestmymeds.net/api/v2/sandbox`
   - Status endpoint: `GET /prescriptions/{rx_unique_id}`

### Key Files
- `src/api/admin/utils/pharmacy-submit.ts` — shared helper, handles both DigitalRX and RMM
- `src/api/admin/utils/pharmacy-submit-rmm.ts` — RMM-specific submission
- `src/jobs/pharmacy-poll.ts` — cron every 5 min, Step 1: auto-submit unsubmitted orders, Step 2: poll status
- `src/api/admin/clinics/[id]/test-pharmacy/route.ts` — test connection (in postbuild.js, not compiled by Medusa build)

### Pharmacy Poll — Clinic JOIN Fix
All pharmacy/dashboard queries join clinic using both domain AND sales_channel_id:
```sql
JOIN clinic c ON (
  ow.tenant_domain = ANY(c.domains)
  OR ow.tenant_domain = ANY(SELECT split_part(d,':',1) FROM unnest(c.domains) AS d)
  OR o.sales_channel_id = c.sales_channel_id
)
```
This handles historical orders with old domains after domain changes.

---

## Admin Extensions

### Clinic Dashboard (`/app/clinic-dashboard`)
- Shows order analytics: by status (pie chart, clickable drill-down to clinic-orders), by product
- Revenue from `order_transaction` table (`reference = 'capture'`)
- Filters: date range, clinic (super_admin only)
- Visible to: `super_admin`, `clinic_admin` only (hidden from pharmacist/medical_director)

### Clinic Operations (`/app/provider-settings`)
- Details tab and API & Credentials tab: **read-only for `clinic_admin`** (shows lock banner)
- Pharmacy tab: fully editable by clinic_admin
- **Payouts tab**: bank details, product pharmacy costs, pending pharmacy payout card, payout history
  - Products list filtered by clinic's `sales_channel_id` (not all products)
  - Pending amounts calculated live from `order_workflow` + `product_payout_cost` — no pre-population needed
  - Pharmacy payout only includes `workflow_status = 'shipped'` orders
  - Refunded orders (`workflow_status = 'refund_issued'`) are excluded
  - Pay Out modal requires a reference number (ACH trace # / wire confirmation)
  - Date range filter based on `order_workflow.created_at`

### Clinic Orders (`/app/clinic-orders`)
- Filter bar includes: search, clinic, workflow status, pharmacy payout status (Unpaid / Paid)
- Order # cell shows green `✓ PAID` badge when pharmacy has been paid (tooltip shows ref # + date)
- "Pharmacy Payout" column shows amount, paid date, ref # for each order
- `pending_pharmacy` status shown as "Pending Pharmacy" (teal badge)

### Order Workflow Widget
- Shows GFE portal link: `{connect_url}/gfe-pro?id={gfe_id}`
- Submit to Pharmacy API button: only shown if `pharmacy_enabled = true` AND credentials exist
- **Pharmacy payout bar**: shown on all `shipped` orders
  - Green "✓ Pharmacy Paid · $X · Ref: Y · Date" when paid
  - Amber "⏳ Pharmacy Payment Pending" when shipped but not yet paid
  - Fetches from `GET /admin/order-workflow/:orderId/payout-status`

---

## Storefront

### Store Page (`/us/store`)
- Products grouped by category using `CategoryRail` component
- 4 products per row on desktop
- Category heading is `text-4xl font-bold`

### Product Detail Page
- Image gallery uses `product.images` array
- `listProducts` fields include `*variants.images` (variant images) but NOT `*images` (product-level) — if images don't show, re-upload through admin
- `force-dynamic` on categories and products pages to avoid build-time backend calls

### Mobile Navigation
- Uses `LocalizedClientLink` (not plain `<a>`) for internal links — prepends country code
- External links use plain `<a>`

### Logo Links
- Nav logo → `/store`
- Footer logo → `/store`

### Track Order
- `/us/order/status` — search by email or order ID
- `/us/order/status/[gfeId]` — 5-step timeline with pharmacy status

### Important Patterns
- `window.__TENANT_API_KEY__` and `window.__TENANT_DOMAIN__` injected by layout
- `NEXT_PUBLIC_*` vars baked at CodeBuild time — must be set in CodeBuild env, not just EB
- `export const dynamic = "force-dynamic"` on pages that call backend at build time

---

## Important Code Patterns

### Domain matching in SQL
Always use both domain AND sales_channel_id for clinic joins (see Pharmacy Poll section above).

### x-forwarded-host
Storefront middleware reads `x-forwarded-host` first (set by nginx), falls back to `host`. Backend routes read `x-forwarded-host` || `host`.

### CSS variable for brand color
`--color-primary` (NOT `--brand-primary`)

### Button styles
`border-radius: 16px`, `font-size: 14px`

### Clinic list/detail routes use raw SQL
Both `GET /admin/clinics` and `GET /admin/clinics/:id` use raw SQL (`SELECT *`) to return all columns including pharmacy fields not in the ORM model.

---

## S3 Image Storage
- Bucket: `gocbeglobal-dev`, region `us-west-1`
- Prefix controlled by `S3_PREFIX` env var (default: `medusa`)
- Prod: `S3_PREFIX=prod-images/`, Test: `S3_PREFIX=test-images/`
- Bucket uses bucket policy for public read (no per-object ACLs)
- `@medusajs/file-s3` patched on every deploy to remove ACL header

---

## Vendor Payout System

### How It Works
1. Admin sets pharmacy cost per product in **Payouts tab** of Clinic Operations
2. When orders are shipped, they appear in **Pending Payouts → Pharmacy** card
3. Admin selects date range → clicks **Pay Out** → enters ACH/wire reference number → confirms
4. One `vendor_payout` record created; all covered orders get a `vendor_ledger` row marked `paid` with the `payout_id`
5. Each order shows payout status in Clinic Orders list (badge on order #) and in the Order Detail widget

### Key API Routes
- `GET/POST /admin/clinics/:id/payout-config` — bank details (no split %)
- `GET/POST /admin/clinics/:id/product-costs` — pharmacy cost per product
- `GET /admin/clinics/:id/payouts?from=&to=` — pending amounts (live-calculated) + history
- `POST /admin/clinics/:id/payouts` — record a payout with reference number
- `GET /admin/order-workflow/:orderId/payout-status` — payout status for order detail widget

### Amount Calculation
```
pharmacy_amount = SUM(product_payout_cost.pharmacy_cost × order_item.quantity)
                  for each line item in the order
clinic_amount   = order_total - pharmacy_amount
```
- Uses `order_item.quantity` (NOT `order_line_item.quantity` — that column does not exist)
- Uses `order_summary.totals` JSONB for order total (NOT `order.total` — that column does not exist)
- Orders matched to clinic via `order.sales_channel_id = clinic.sales_channel_id` (reliable; domain matching was unreliable)

### Payout Rules
- Pharmacy only paid for orders with `order_workflow.status = 'shipped'`
- Refunded orders (`status = 'refund_issued'`) excluded from all payout calculations
- No cron job — manual process with reference number until Mercury Bank API is integrated

### Migration 12 — Tables to create manually
```sql
vendor_payout_config, product_payout_cost, vendor_ledger, vendor_payout
```
See `Migration20240101000012.ts` for full DDL. Run DROP + CREATE when first deploying.

---

## Known Issues / Gotchas

### 1. Medusa build silently skips some routes
Routes in `[id]` subdirectories sometimes don't compile. Fixed via `scripts/postbuild.js` which manually writes the compiled JS. Currently handles: `test-connection`, `test-pharmacy`, `dashboard`.

### 2. DB connection pool exhaustion after failed deploy
If `medusa db:migrate` runs and times out, it leaves idle connections that fill the pool. Fix:
```bash
psql $DATABASE_URL -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'medusa_prod' AND state = 'idle' AND pid <> pg_backend_pid();"
sudo systemctl restart web
sudo systemctl reload nginx
```

### 3. Storefront build fails if backend is down
`generateStaticParams` calls backend during CodeBuild. Fixed with `export const dynamic = "force-dynamic"` on categories and products pages.

### 4. nginx reload required after web restart
The `.platform/nginx` config is loaded at deploy time. After manual `sudo systemctl restart web`, run `sudo systemctl reload nginx` to restore `X-Forwarded-Host` header.

### 5. `order.total` does not exist as a column
In Medusa v2, the order total is stored in `order_summary.totals` as JSONB, not as a column on `order`. Always use:
```sql
LEFT JOIN LATERAL (
  SELECT totals FROM order_summary
  WHERE order_id = o.id AND deleted_at IS NULL
  ORDER BY created_at DESC LIMIT 1
) os ON true
-- then: COALESCE((os.totals->>'current_order_total')::numeric, (os.totals->>'original_order_total')::numeric, (os.totals->>'total')::numeric, 0)
```

### 6. `order_line_item.quantity` does not exist
Quantity is on `order_item.quantity`, not `order_line_item`. The join pattern is:
```sql
FROM order_item oi
JOIN order_line_item oli ON oli.id = oi.item_id
-- use oi.quantity, oli.product_id
```

### 7. Local testing domains
Add to `C:\Windows\System32\drivers\etc\hosts`:
```
127.0.0.1 spaderx.local
127.0.0.1 myclassywellness.local
127.0.0.1 contour-wellness.local
```

---

## Local Development

### Backend
```bash
cd my-medusa-store
npx medusa develop
```
Requires PostgreSQL running as Administrator on Windows.

### Storefront
```bash
cd my-medusa-store-storefront
npm run dev
```

### Run migration manually (local)
```bash
set DATABASE_URL=postgres://postgres:2190@localhost/medusa-my-medusa-store && node scripts/manual-migrate.js
```

### Test built version locally (to verify postbuild patches)
```bash
cd my-medusa-store
npm run build
set DATABASE_URL=postgres://postgres:2190@localhost/medusa-my-medusa-store && cd .medusa/server && node ../../node_modules/@medusajs/cli/dist/index.js start
```

---

## SEV1 OPEN ISSUE: Per-Clinic Stripe Keys

### Problem
Medusa's payment module uses one global `STRIPE_API_KEY` to create payment sessions. When a clinic has their own live Stripe key (`pk_live_...`), the frontend loads Stripe with that live key but the backend created the session with the global test key (`sk_test_...`). Stripe rejects this mismatch — card fields don't appear.

### Temporary Fix (Applied to PROD)
Set `STRIPE_API_KEY` in backend EB environment to SpadeRx's live secret key. This makes Medusa create sessions with the live key matching SpadeRx's `pk_live_...`. Other test clinics break temporarily for new carts.

### Proper Fix (In Progress — NOT yet working)
New flow bypasses Medusa's payment session entirely for per-clinic Stripe:
1. `PaymentWrapper` calls `/api/create-payment-intent` (Next.js proxy route)
2. Proxy calls backend `POST /store/clinics/create-payment-intent` with clinic domain
3. Backend uses `clinic.stripe_secret_key` (raw SQL, bypasses ORM cache) to create Stripe PaymentIntent
4. `clientSecret` returned to frontend, passed to `StripeWrapper` directly
5. `StripeWrapper` now accepts explicit `clientSecret` prop

### Key Files Changed for Per-Clinic Stripe
- `src/api/store/clinics/create-payment-intent/route.ts` — backend, uses raw SQL for clinic lookup
- `src/app/api/create-payment-intent/route.ts` — storefront Next.js proxy (avoids cert issues)
- `src/modules/checkout/components/payment-wrapper/index.tsx` — calls proxy, passes clientSecret
- `src/modules/checkout/components/payment-wrapper/stripe-wrapper.tsx` — accepts `clientSecret` prop
- `src/modules/checkout/components/payment-button/index.tsx` — reads clientSecret from session data

### Status
Backend route confirmed working via curl. Storefront proxy confirmed working manually. But automatic call from `PaymentWrapper` still failing — `cartTotal` is 0 at mount time (before shipping selected), causing the PaymentIntent creation to be skipped. After shipping is selected, `cartTotal` updates and triggers re-fetch via `useEffect([cartTotal])`. Still debugging why card fields don't appear after that.

### Debug Logs Added
`PaymentWrapper` logs `[PaymentWrapper] clinicClientSecret`, `effectiveClientSecret`, `stripePromise`, `loading`, `noPaymentNeeded` to browser console on every render.

---

## New Features Added (This Session)

### PayPal Per-Clinic
- Migration 10: `payment_provider`, `paypal_client_id`, `paypal_client_secret`, `paypal_mode` on `clinic` table
- `medusa-plugin-paypal` installed, registered in `medusa-config.ts`
- Admin UI: Payment Provider selector + PayPal fields in API & Credentials tab
- Storefront: `PaypalWrapper` uses `NEXT_PUBLIC_PAYPAL_CLIENT_ID` env var
- PayPal session initiated in `PayPalPaymentButton` on mount
- Run `node scripts/add-paypal-to-regions.js` to add PayPal to all regions after backend deploy
- **Important**: `medusa-plugin-paypal` provider identifier is `paypal`, registered as `pp_paypal_paypal`
- PayPal `onApprove` must call `actions.order.capture()` before `placeOrder()` — plugin bug where `APPROVED` status isn't handled

### Per-Clinic Promotions
- Migration 10: `clinic_promotion` table
- Promotions tab in Clinic Operations — clinic_admin can create promotions directly
- Uses Medusa's `POST /admin/promotions` API with inline `campaign` for dates/limits
- `GET /admin/clinics/:id/promotions` joins `promotion`, `promotion_campaign`, `promotion_campaign_budget` tables
- Promotion table columns: `limit`, `used` (not `usage_limit`, `usage_count`)
- Campaign tables: `promotion_campaign`, `promotion_campaign_budget`

### Provider Clearance Reminder Button
- `POST /admin/clinics/:id/orders/:orderId/send-reminder` — sends same email as daily cron
- Button in Order Workflow Widget (order detail page) for `pending_provider` orders
- In `postbuild.js` for compiled output

### Order Workflow — Skip GFE for Unmapped Products
- `src/subscribers/order-placed.ts` — if no treatment mappings found for order products, skip GFE creation entirely and return early
- Order completes normally through Medusa without provider clearance workflow

### Category Description HTML
- `src/modules/categories/templates/index.tsx` — renders description as HTML (`dangerouslySetInnerHTML`) or `pre-line` text
- Use inline styles on `<ul>` for bullet points since Tailwind resets list styles
- Example: `<ul style="list-style:disc;padding-left:1.5em;margin:0.75em 0;"><li>...</li></ul>`

### DigitalRX API v2 Fixes
- Submit response field is `ID` not `QueueID` — fixed in `pharmacy-submit.ts` and manual route
- Status response is an array `[{...}]` not single object — fixed in `pharmacy-poll.ts`
- Tracking field is `Trackingnumber` (lowercase n) — fixed in poll
- Status endpoint returns empty body when no status yet (sandbox behavior) — handled gracefully

### Storefront Category Caching Fix
- `src/lib/data/categories.ts` — changed from `cache: "force-cache"` to `cache: "no-store"`
- New categories added in admin now appear immediately without redeploy

### Metadata/JSON Section Hidden for Non-Super-Admin
- `src/admin/widgets/order-workflow.tsx` — injects CSS + MutationObserver to hide Metadata and JSON sections on order detail page for non-super-admin roles

---

## Known Issues / Gotchas

### 1. Medusa build silently skips some routes
Routes in `[id]` subdirectories sometimes don't compile. Fixed via `scripts/postbuild.js` which manually writes the compiled JS. Currently handles: `test-connection`, `test-pharmacy`, `dashboard`, promotions routes, send-reminder route.

### 2. DB connection pool exhaustion after failed deploy
If `medusa db:migrate` runs and times out, it leaves idle connections that fill the pool. Fix:
```bash
psql $DATABASE_URL -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'medusa_prod' AND state = 'idle' AND pid <> pg_backend_pid();"
sudo systemctl restart web
sudo systemctl reload nginx
```

### 3. Storefront build fails if backend is down
`generateStaticParams` calls backend during CodeBuild. Fixed with `export const dynamic = "force-dynamic"` on categories and products pages.

### 4. nginx reload required after web restart
The `.platform/nginx` config is loaded at deploy time. After manual `sudo systemctl restart web`, run `sudo systemctl reload nginx` to restore `X-Forwarded-Host` header.

### 5. Local testing domains
Add to `C:\Windows\System32\drivers\etc\hosts`:
```
127.0.0.1 spaderx.local
127.0.0.1 myclassywellness.local
127.0.0.1 contour-wellness.local
```

### 6. Live Stripe keys require HTTPS
Cannot test live Stripe keys locally (HTTP). Must test on TEST or PROD EB environment.

### 7. PayPal sandbox status returns empty body
Normal behavior — sandbox doesn't return status data until pharmacy processes. Production will return real data.

### 8. DigitalRX sandbox QueueID
Sandbox submissions return a QueueID but status endpoint returns empty. This is expected sandbox behavior.

---

## Local Development

### Backend
```bash
cd my-medusa-store
npx medusa develop
```
Requires PostgreSQL running as Administrator on Windows.

### Storefront
```bash
cd my-medusa-store-storefront
npm run dev
```

### Run migration manually (local)
```bash
set DATABASE_URL=postgres://postgres:2190@localhost/medusa-my-medusa-store && node scripts/manual-migrate.js
```

### Test built version locally (to verify postbuild patches)
```bash
cd my-medusa-store
npm run build
set DATABASE_URL=postgres://postgres:2190@localhost/medusa-my-medusa-store && cd .medusa/server && node ../../node_modules/@medusajs/cli/dist/index.js start
```
