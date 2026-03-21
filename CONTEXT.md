# MHC Store — Session Context

## Workspaces
- Backend: `c:\MHCStore\my-medusa-store` (Medusa v2, Node)
- Storefront: `c:\MHCStore\my-medusa-store-storefront` (Next.js 14, App Router)
- Admin UI: served at `http://localhost:9000/app` (Medusa built-in admin)
- Storefront runs at port 8000 (e.g. `http://spaderx.local:8000`)

## Multi-Tenant Architecture
Each clinic is a "tenant" identified by domain (e.g. `spaderx.local:8000`).
- Middleware (`src/middleware.ts`) reads the host, fetches `/store/clinics/tenant-config` with `cache: "no-store"`, sets `x-tenant-api-key` and `x-tenant-domain` cookies.
- `src/lib/config.ts` reads the publishable API key from the `x-tenant-api-key` cookie (set by middleware) for server actions.
- The "Initiating Medusa client with default headers" log always shows the env default key — this is the SDK constructor, NOT the actual request key. Ignore it.
- Full server restart required when changing `middleware.ts` or `config.ts`.

## Key Backend Routes
| Route | Purpose |
|---|---|
| `GET/POST /admin/clinics/:id/ui-config` | Admin saves/loads storefront UI config |
| `GET /store/clinics/ui-config` | Storefront reads UI config by host header |
| `GET /store/clinics/tenant-config` | Middleware reads publishable key + stripe key |

## Database
- PostgreSQL: `postgres://postgres:2190@localhost/medusa-my-medusa-store`
- Custom table: `clinic_ui_config` — stores all storefront UI config as JSONB
- Migrations in: `src/modules/provider-integration/migrations/`
- Latest migration: `Migration20240101000006` — adds contact/social/bottom_links columns
- To run migrations: `npx medusa db:migrate` (from `my-medusa-store/`)
- If migration doesn't pick up new file, run ALTER TABLE directly via psql

### clinic_ui_config columns
```
id, tenant_domain, clinic_id,
nav_links (jsonb), footer_links (jsonb), bottom_links (jsonb),
logo_url, get_started_url,
contact_phone, contact_email, contact_address,
social_links (jsonb), certification_image_url,
created_at, updated_at
```

### NavLink JSON shape
```json
{ "label": "string", "url": "string", "open_new_tab": false, "children": [...NavLink] }
```
Children make dropdowns in nav and grouped columns in footer.

### SocialLink JSON shape
```json
{ "platform": "Facebook|Instagram|TikTok|...", "url": "string" }
```

## Storefront Layout
- `(main)` route group: `src/app/[countryCode]/(main)/layout.tsx` — has Nav + Footer
- `(checkout)` route group: `src/app/[countryCode]/(checkout)/layout.tsx` — also has Nav + Footer (added in earlier session)
- Both layouts call `fetchUiConfig(host)` with `cache: "no-store"` and pass all props to Footer

## Nav Component
- `src/modules/layout/templates/nav/index.tsx` — server component, imports `NavDropdown`
- `src/modules/layout/templates/nav/nav-dropdown.tsx` — `"use client"`, handles hover dropdowns for items with `children`
- Items without children render as plain links; items with children get a chevron + dropdown on hover/mouseenter

## Footer Component
- `src/modules/layout/templates/footer/index.tsx` — async server component
- Left column: logo → social icons (filled dark circles) → phone → email → address → certification badge
- Middle/right: dynamic link groups (children = separate column with header), flat links = "Links" column, plus Medusa categories/collections
- Bottom bar: copyright left, `bottom_links` center, MedusaCTA right
- Text colors: `text-gray-700` for contact info, `text-gray-600` for links, `text-gray-800` for headers — NOT pale `text-ui-fg-subtle`

## Admin UI Config Tab (provider-settings)
File: `src/admin/routes/provider-settings/page.tsx`

Sections in the Storefront UI tab:
1. Logo URL + Get Started URL
2. Contact Info (phone, email, multi-line address)
3. Social Media Links (platform dropdown + URL, add/remove rows)
4. Certification/Badge Image (URL + live preview)
5. Navigation Links (parent + child links, `+ Child` button per row)
6. Footer Links (same parent/child structure)
7. Bottom Bar Links (flat list for bottom strip)

## Cart / Checkout Flow
- `src/lib/data/cart.ts` — all cart server actions (`addToCart`, `deleteLineItem`, etc.)
- `src/lib/data/cookies.ts` — `getCacheTag` falls back to base tag name (not empty string) so `revalidateTag` always fires
- Cart page: `src/app/[countryCode]/(main)/cart/page.tsx` — has `export const dynamic = "force-dynamic"`
- Delete button: `src/modules/common/components/delete-button/index.tsx` — uses `.finally(() => setIsDeleting(false))` + `router.refresh()`
- Do NOT add `router.refresh()` in `product-actions` — caused regressions previously

## Product Eligibility + Add to Cart
File: `src/modules/products/components/product-actions/index.tsx`

Flow:
1. On mount, checks if product requires eligibility via `/store/eligibility/check`
2. If yes and not yet screened → shows `EligibilityModal`
3. After modal approval → `handleEligibilityApproved`: adds to cart, saves metadata to `/store/carts/eligibility-metadata`, caches in `sessionStorage`, navigates to cart
4. If already screened (`alreadyScreened = true`) → calls `handleAddToCart` directly (skips metadata save — already saved first time)
5. `handleAddToCart` wraps in `try/finally` so spinner always clears, then navigates to `/${countryCode}/cart`

Key fix: second-item spinning was caused by `handleButtonClick` calling `handleEligibilityApproved` for already-screened users, which ran a retry loop + backend fetch that could hang.

## Checkout (Single Page)
File: `src/modules/checkout/components/single-page-checkout/index.tsx`

- `liveCart` state updated after `initiatePaymentSession` → `retrieveCart()` with payment_collection fields
- `PaymentWrapper` lives inside `SinglePageCheckout`, receives `liveCart`
- `canPlaceOrder` checks `liveCart.shipping_methods` (not stale server prop)
- `handleSetShipping` fetches fresh cart after setting shipping, updates `liveCart`
- `PaymentButton` has `onBeforeSubmit` prop that runs `saveShippingAddress` sequentially before Stripe confirms

## Stripe / Payment
- Per-clinic Stripe keys stored in `clinic` table (`stripe_publishable_key`, `stripe_secret_key`)
- Storefront fetches publishable key via `/api/tenant-stripe-key` Next.js API route (server-side proxy, avoids browser blocking `host` header)
- `payment-wrapper` reads key from `data.tenant.stripe_publishable_key` (not `data.tenant.ui_config.stripe_publishable_key`)

## Known Constraints
- Only one git commit exists (initial) — no prior history to revert to
- Storefront hot-reloads code changes; `middleware.ts` and `config.ts` require full server restart
- `router.refresh()` in product-actions causes regressions — do not add it back
