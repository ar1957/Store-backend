# MHC Store — Developer Handoff Context

## Project Overview
Multi-tenant Medusa v2 backend + Next.js 15 storefront. Each clinic/store is a tenant with its own domain, branding, Stripe keys, and GFE (telehealth) API credentials. The admin UI is a custom Medusa admin extension.

## Workspaces
- `my-medusa-store` — Medusa v2 backend (port 9000)
- `my-medusa-store-storefront` — Next.js 15 storefront (port 8000)

---

## AWS Deployment

### Infrastructure
- **Backend**: AWS Elastic Beanstalk (`medusa-backend-test.eba-t6prye2p.us-west-1.elasticbeanstalk.com`)
- **Frontend**: Separate EB environment (`medusa-storefront-test.eba-jmypnpmk.us-west-1.elasticbeanstalk.com`)
- **Database**: RDS PostgreSQL (`medusa-db-test.czojurt1hrt9.us-west-1.rds.amazonaws.com`)
- **CI/CD**: AWS CodeBuild + CodePipeline
- **S3 Images**: `gocbeglobal-dev` bucket, `us-west-1`, public read enabled

### How to Deploy Backend
1. Push to `main` branch → CodePipeline triggers CodeBuild
2. CodeBuild runs `buildspec.yml`: `npm ci --legacy-peer-deps` → `npm run build` → `npm prune --production`
3. Artifact zipped and deployed to Elastic Beanstalk
4. EB runs `.ebextensions/01_setup.config` which runs migrations, fixes image URLs, patches S3 ACL

### Start Command (Critical)
The Procfile must be:
```
web: cd .medusa/server && node /var/app/current/node_modules/@medusajs/cli/dist/index.js start
```

### EB Environment Variables (Critical)
- `DATABASE_URL` — full postgres connection string
- `MEDUSA_BACKEND_URL` — `https://medusa-backend-test.eba-t6prye2p.us-west-1.elasticbeanstalk.com`
- `ADMIN_CORS`, `AUTH_CORS`, `STORE_CORS`
- `JWT_SECRET`, `COOKIE_SECRET`
- `STRIPE_API_KEY`
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`
- `S3_BUCKET=gocbeglobal-dev`, `S3_REGION=us-west-1`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
- `NODE_ENV=production`, `PORT=9000`

### Migrations
Custom migrations in `src/modules/provider-integration/migrations/` (Migration20240101000001 through Migration20240101000009).
Run manually: `node scripts/manual-migrate.js` (requires `DATABASE_URL` env var).
The ebextension auto-runs migrations on deploy.

---

## Architecture

### Multi-Tenancy
- Each clinic has a record in the `clinic` table with `domains[]`, `publishable_api_key`, `stripe_publishable_key`, etc.
- Storefront middleware calls `/store/clinics/tenant-config` on every request
- CORS for clinic domains handled dynamically by `src/api/middlewares.ts` (60s cache)

### Key Custom Tables
- `clinic` — tenant config (domains, API keys, branding, pharmacy config)
- `clinic_staff` — staff members per clinic with roles
- `order_workflow` — tracks GFE/telehealth order lifecycle + pharmacy submission
- `order_comment` — comments on orders
- `product_treatment_map` — maps Medusa products to GFE treatments
- `clinic_ui_config` — nav/footer links, logo, contact info per clinic

### Roles
- `super_admin` — sees everything
- `clinic_admin` — sees clinic-orders, products, clinic operations
- `pharmacist` / `medical_director` — sees clinic-orders only

### Email
Uses Resend. Templates: `order.confirmation`, `order.status_update`, `order.shipped`, `order.md_denied`, `order.refund_issued` — all in `src/modules/resend/service.ts`.
Per-clinic `from_email`, `from_name`, `reply_to` stored on clinic table.

---

## Order Workflow / GFE Flow

1. Patient places order → `order.placed` event fires
2. `order-placed.ts` subscriber creates patient + GFE via provider API → saves `virtual_room_url` to `order_workflow`
3. GFE poll job (`/admin/gfe-poll`) checks provider status every 5 min
4. If provider **approves** → status = `processing_pharmacy` → auto-submit to pharmacy API
5. If provider **defers** → status = `pending_md_review` → MD reviews in admin → approves → `processing_pharmacy` → auto-submit to pharmacy API
6. Pharmacy poll job (`src/jobs/pharmacy-poll.ts`) checks pharmacy status every 5 min → updates tracking when shipped

### Order Statuses
`pending_provider` → `pending_md_review` (if deferred) → `processing_pharmacy` → `shipped` → (or `md_denied` / `refund_issued`)

---

## Pharmacy Integration

### Supported Pharmacies
1. **DigitalRX (SmartConnect)** — `pharmacy_type = "digitalrx"`
   - Auth: `Authorization: <api_key>` header
   - Submit: `POST /RxWebRequest` → returns `QueueID`
   - Status: `POST /RxRequestStatus` with `QueueID`
   - Sandbox: StoreID `190190`, key `12345678901234567890` (portal-only, not external)
   - Production: requires real API key from SmartConnect

2. **Partell Pharmacy (RequestMyMeds)** — `pharmacy_type = "rmm"`
   - Auth: JWT via `POST /getJWTkey` (expires 1 hour)
   - Submit: `POST /prescriptions` with flat payload
   - Sandbox: `https://requestmymeds.net/api/v2/sandbox`
   - Production: `https://requestmymeds.net/api/v2`
   - Credentials: username/password stored on clinic

### Pharmacy Config Fields on `clinic` table
```
pharmacy_type, pharmacy_api_url, pharmacy_api_key, pharmacy_store_id,
pharmacy_vendor_name, pharmacy_enabled (boolean),
pharmacy_doctor_first_name, pharmacy_doctor_last_name, pharmacy_doctor_npi,
pharmacy_username, pharmacy_password, pharmacy_prescriber_id,
pharmacy_prescriber_address, pharmacy_prescriber_city, pharmacy_prescriber_state,
pharmacy_prescriber_zip, pharmacy_prescriber_phone, pharmacy_prescriber_dea,
pharmacy_ship_type, pharmacy_ship_rate, pharmacy_pay_type
```

### Key Files
- `src/api/admin/utils/pharmacy-submit.ts` — shared helper, routes to correct handler
- `src/api/admin/utils/pharmacy-submit-rmm.ts` — RMM-specific submission
- `src/api/admin/utils/normalize-phone.ts` — strips country code, returns 10 digits
- `src/api/admin/clinics/[id]/orders/[orderId]/pharmacy-submit/route.ts` — manual submit button
- `src/jobs/pharmacy-poll.ts` — cron every 5 min, checks pharmacy status for both DigitalRX and RMM
- `src/api/admin/clinics/[id]/test-pharmacy/route.ts` — backend proxy for test connection (avoids CORS)

### RMM Status Polling
RMM poll uses `GET /prescriptions/{rx_unique_id}` with a fresh JWT each poll cycle.
Response fields: `status` (e.g. "Received", "Processing", "Shipped"), `tracking_number`, `shipping_label_id`.
When `tracking_number` is present → order moves to `shipped`.
Otherwise `pharmacy_status` is updated in `order_workflow` so the storefront can display it.

### Track Order — Pharmacy Steps
The storefront track order page (`/order/status/[gfeId]`) shows a 5-step timeline:
1. Pending Provider Clearance
2. Pending Physician Review (only shown if order went through MD review)
3. Processing by Pharmacy
4. Order Received by Pharmacy — shows `pharmacy_queue_id` and `pharmacy_status` badge (e.g. "Received")
5. Medication Shipped — shows tracking number

Step 4 only appears once `pharmacy_status` is populated (i.e. the pharmacy has acknowledged the order).

---

## Storefront

### Key Features
- Google Places autocomplete on shipping address (`react-google-autocomplete` package)
  - API key: `NEXT_PUBLIC_GOOGLE_PLACES_KEY` in `.env.local`
  - Validates state matches eligibility state
- Stripe Payment Element (replaces Card Element) — supports Affirm, Klarna, Apple Pay, Google Pay, ACH
- Static legal pages: `/privacy-policy`, `/terms`, `/telehealth`, `/purchase-terms`, `/glp1-waiver`, `/shipping-policy`
- Track Order page: `/order/status` — searches by email or order ID
- Order status detail: `/order/status/[gfeId]`

### Important Patterns
- All browser→backend calls go through Next.js `/api/` proxy routes (CORS)
- `window.__TENANT_API_KEY__` and `window.__TENANT_DOMAIN__` injected by layout
- `window.__GOOGLE_PLACES_KEY__` injected by layout
- `params` in Next.js 15 API routes must be awaited
- `export const dynamic = "force-dynamic"` on layouts that read tenant headers

---

## Important Code Patterns

### Always use x-forwarded-host not host
Node.js `fetch` silently drops the `host` header. Always use `x-forwarded-host`.

### tenant_domain vs clinic domains
`order_workflow.tenant_domain` stored WITHOUT port (e.g. `myclassywellness.local`).
Clinic `domains[]` array has WITH port (e.g. `myclassywellness.local:8000`).
Always strip port when comparing — both variants in `allowedDomains`.

### CSS variable for brand color
`--color-primary` (NOT `--brand-primary`)

### Button styles
`border-radius: 16px`, `font-size: 14px`

### Clinic list/detail routes use raw SQL
Both `GET /admin/clinics` and `GET /admin/clinics/:id` use raw SQL (`SELECT *`) to return all columns including pharmacy fields not in the ORM model.

---

## Pending / Known Issues

### 1. DigitalRX sandbox doesn't work externally
The sandbox key `12345678901234567890` only works through their portal tester, not from external API calls. Need a real production API key from SmartConnect.

### 2. pharmacy_enabled toggle
Fixed — uses `=== true` strict equality to handle `null` from DB. GET routes use raw SQL so all fields return correctly.

### 3. Storefront images
Product images stored in S3 (`gocbeglobal-dev` bucket, `medusa` prefix). The ebextension patches `@medusajs/file-s3` to disable ACL on every deploy (bucket uses bucket policy for public access).

### 4. Local testing domains
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

### Storefront
```bash
cd my-medusa-store-storefront
npm run dev
```

### Run migration manually (local)
```bash
set DATABASE_URL=postgres://postgres:2190@localhost/medusa-my-medusa-store && node scripts/manual-migrate.js
```
