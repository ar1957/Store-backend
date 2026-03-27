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
- **Frontend**: Separate EB environment (deployed via CodePipeline)
- **Database**: RDS PostgreSQL (`medusa-db-test.czojurt1hrt9.us-west-1.rds.amazonaws.com`)
- **CI/CD**: AWS CodeBuild + CodePipeline

### How to Deploy Backend
1. Push to `main` branch → CodePipeline triggers CodeBuild
2. CodeBuild runs `buildspec.yml`: `npm ci` → `npm run build` → `npm prune --production`
3. Artifact zipped and deployed to Elastic Beanstalk
4. EB runs `.ebextensions/01_setup.config` which runs `db:migrate` then starts the app

### Start Command (Critical)
The Procfile must be:
```
web: cd .medusa/server && node /var/app/current/node_modules/@medusajs/cli/dist/index.js start
```
**Do NOT use `npx medusa start`** — it resolves to the wrong (v1) binary on AWS.

### If the app crashes on AWS after an env var change
EB rewrites the systemd service from the Procfile. If it reverts to `npx medusa start`, fix manually:
```bash
sudo sed -i 's|npx medusa start|node /var/app/current/node_modules/@medusajs/cli/dist/index.js start|g' /etc/systemd/system/web.service
sudo systemctl daemon-reload && sudo systemctl restart web
```

### EB Environment Variables (Critical)
Get the full DATABASE_URL via:
```bash
/opt/elasticbeanstalk/bin/get-config environment --key DATABASE_URL
```
The shell `$DATABASE_URL` only has the hostname — always use `get-config` in scripts.

Key env vars:
- `DATABASE_URL` — full postgres connection string with credentials
- `ADMIN_CORS` — must be lowercase: `https://medusa-backend-test.eba-...`
- `AUTH_CORS` — same as ADMIN_CORS + storefront domains
- `STORE_CORS` — storefront domains only (clinic domains handled dynamically)
- `JWT_SECRET`, `COOKIE_SECRET`, `STRIPE_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`

### 401 After Login Fix
The app runs on HTTPS on AWS. `medusa-config.ts` has `cookieSecure: false, cookieSameSite: "lax"` to prevent session cookie being dropped. If login succeeds (200) but `/admin/users/me` returns 401, check CORS values are lowercase and match the actual browser URL exactly.

### Migrations
Custom migrations are in `my-medusa-store/src/modules/provider-integration/migrations/` (Migration20240101000001 through Migration20240101000008). These were manually run on the AWS DB on 2026-03-26 and are recorded in `mikro_orm_migrations`. Future migrations will run automatically via `db:migrate` in the ebextension.

To run migrations manually on AWS:
```bash
export DATABASE_URL=$(/opt/elasticbeanstalk/bin/get-config environment --key DATABASE_URL)
cd /var/app/current/.medusa/server && node /var/app/current/node_modules/@medusajs/cli/dist/index.js db:migrate
```

---

## Architecture

### Multi-Tenancy
- Each clinic has a record in the `clinic` table with `domains[]`, `publishable_api_key`, `stripe_publishable_key`, etc.
- The storefront middleware (`src/middleware.ts`) calls `/store/clinics/tenant-config` on every request to get the tenant's API key and inject it as a cookie
- CORS for clinic domains is handled dynamically by `src/api/middlewares.ts` — reads from DB with 60s cache, no restart needed when adding a new clinic

### Key Custom Tables
- `clinic` — tenant config (domains, API keys, branding)
- `clinic_staff` — staff members per clinic with roles
- `order_workflow` — tracks GFE/telehealth order lifecycle
- `order_comment` — comments on orders
- `product_treatment_map` — maps Medusa products to GFE treatments
- `clinic_ui_config` — nav/footer links, logo, contact info per clinic

### Roles
- `super_admin` — sees everything
- `clinic_admin` — sees clinic-orders, products, clinic operations
- `pharmacist` / `medical_director` — sees clinic-orders only

### Email
Uses Resend. Template `"order.confirmation"`, `"order.status_update"`, `"order.shipped"`, `"order.md_denied"`, `"order.refund_issued"` are all in `src/modules/resend/service.ts`.

---

## Pending / Known Issues

### 1. test-connection route missing on AWS (deploy pending)
`POST /admin/clinics/:id/test-connection` returns 404 on AWS because the route was created after the last build. It exists in source at `src/api/admin/clinics/[id]/test-connection/route.ts`. **Next deploy will fix this.**

### 2. Zero-downtime clinic CORS
Dynamic CORS middleware is in `src/api/middlewares.ts`. New clinic domains are picked up within 60 seconds from DB. `STORE_CORS` env var only needs `http://localhost:8000` — clinic domains are DB-driven.

### 3. Storefront eligibility check performance
`/api/eligibility-check` in the storefront now queries Postgres directly (bypassing the Medusa backend hop) with a 60s in-process cache. `DATABASE_URL` must be set in `my-medusa-store-storefront/.env.local`.

---

## Local Development

### Backend
```bash
cd my-medusa-store
npx medusa develop
```
Runs on port 9000. Hot-reloads on file changes.

### Storefront
```bash
cd my-medusa-store-storefront
npm run dev
```
Runs on port 8000.

### Local hosts file (for multi-tenant testing)
Add to `C:\Windows\System32\drivers\etc\hosts`:
```
127.0.0.1 myclassywellness.local
127.0.0.1 spaderx.local
127.0.0.1 contour-wellness.local
```

---

## Important Code Patterns

### Always use x-forwarded-host not host
Node.js `fetch` silently drops the `host` header. Always use `x-forwarded-host` when passing tenant domain to backend.

### Next.js 15 params must be awaited
```ts
const { id } = await params  // NOT: const { id } = params
```

### tenant_domain vs clinic domains
`order_workflow.tenant_domain` is stored WITHOUT port (e.g. `myclassywellness.local`). Clinic `domains[]` array has WITH port (e.g. `myclassywellness.local:8000`). Always strip port when comparing.

### CSS variable for brand color
`--color-primary` (NOT `--brand-primary`)

### Button styles
`border-radius: 16px`, `font-size: 14px`

### export const dynamic = "force-dynamic"
Required on all Next.js layouts that read tenant headers from the request.
