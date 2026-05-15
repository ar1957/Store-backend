# Location Feature - Remaining Implementation Steps

## Overview
This document contains the exact code changes needed to complete the location feature.

---

## STEP 1: Add Location Selector to Checkout (Storefront)

**File**: `my-medusa-store-storefront/src/modules/checkout/components/single-page-checkout/index.tsx`

### 1.1 Add State Variables
Find the line with `const [eligibilitySaving, setEligibilitySaving] = useState(false)` (around line 90) and add after it:

```typescript
  // Location selection state
  const [locations, setLocations] = useState<any[]>([])
  const [selectedLocation, setSelectedLocation] = useState<string>("")
  const [locationSaving, setLocationSaving] = useState(false)
```

### 1.2 Add Location Fetch Effect
Find the eligibility check `useEffect` (around line 100) and add this new effect after it:

```typescript
  // Fetch available locations for this clinic
  useEffect(() => {
    const fetchLocations = async () => {
      try {
        const res = await fetch("/api/clinic-locations")
        const data = await res.json()
        setLocations(data.locations || [])
        
        // Check if location already selected in cart metadata
        const cartMeta = (liveCart as any).metadata as Record<string, any> | null
        if (cartMeta?.location_id) {
          setSelectedLocation(cartMeta.location_id)
        }
      } catch (err) {
        console.error("Failed to fetch locations:", err)
      }
    }
    fetchLocations()
  }, [])
```

### 1.3 Add Location Change Handler
Find the `handleEligibilityApproved` function (around line 200) and add this new handler after it:

```typescript
  const handleLocationChange = async (locationId: string) => {
    if (!locationId) {
      setSelectedLocation("")
      return
    }
    
    const loc = locations.find(l => l.id === locationId)
    if (!loc) return
    
    setLocationSaving(true)
    try {
      await fetch("/api/cart-location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cartId: liveCart.id,
          locationId: loc.id,
          locationName: loc.name,
        }),
      })
      setSelectedLocation(locationId)
    } catch (err) {
      console.error("Failed to save location:", err)
    } finally {
      setLocationSaving(false)
    }
  }
```

### 1.4 Update canPlaceOrder Logic
Find the `canPlaceOrder` constant (around line 250) and update it to include location check:

```typescript
  const canPlaceOrder =
    addressComplete &&
    (liveCart.shipping_methods?.length ?? 0) > 0 &&
    (noPaymentNeeded || activeSession || isPaypal(selectedPaymentMethod)) &&
    (noPaymentNeeded || !isStripeLike(selectedPaymentMethod) || cardComplete) &&
    consentTerms &&
    consentPrivacy &&
    (!cartRequiresEligibility || eligibilityVerified) &&
    (locations.length === 0 || selectedLocation !== "")  // Add this line
```

### 1.5 Add Location Section UI
Find the shipping address section (around line 300, look for `{/* ── SECTION 1: Shipping Address ── */}`) and add this NEW section after it (before the delivery method section):

```tsx
      {/* ── SECTION: Referral Location (if clinic has locations) ── */}
      {locations.length > 0 && (
        <section className="bg-white">
          <h2 className="text-3xl-regular font-semibold mb-2">Referral Location</h2>
          <p className="text-ui-fg-muted text-sm mb-6">
            Which location referred you to us?
          </p>
          <div className="relative">
            <select
              value={selectedLocation}
              onChange={(e) => handleLocationChange(e.target.value)}
              required
              disabled={locationSaving}
              className="w-full rounded-md border border-ui-border-base bg-ui-bg-field px-4 py-3 text-base text-ui-fg-base focus:border-ui-border-interactive focus:outline-none appearance-none"
              style={{ paddingRight: "2.5rem" }}
            >
              <option value="">Select a location *</option>
              {locations.map(loc => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                  {loc.city && loc.state ? ` - ${loc.city}, ${loc.state}` : ""}
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-ui-fg-muted">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>
          <hr className="mt-8" />
        </section>
      )}
```

### 1.6 Update Checklist Before Place Order
Find the checklist that shows what's missing (around line 450, look for "Before placing your order, please complete:") and add location to the list:

```tsx
              {cartRequiresEligibility && !eligibilityVerified && (
                <li>
                  Health eligibility screening —{" "}
                  <button
                    onClick={() => setShowEligibilityModal(true)}
                    className="underline font-semibold text-amber-800 hover:text-amber-900"
                  >
                    Complete now
                  </button>
                </li>
              )}
              {locations.length > 0 && !selectedLocation && <li>Select referral location</li>}
            </ul>
```

---

## STEP 2: Transfer Location from Cart to Order Workflow

**File**: Need to find where `order_workflow` is created. Most likely in one of these files:
- `my-medusa-store/src/api/admin/gfe-poll/route.ts`
- `my-medusa-store/src/jobs/pharmacy-poll.ts`
- Or a subscriber/workflow file

### 2.1 Search for Order Workflow Creation
Run this search to find where order_workflow INSERT happens:
```bash
grep -r "order_workflow" my-medusa-store/src --include="*.ts" | grep -i "insert\|create"
```

### 2.2 Add Location Fields
Once you find where `order_workflow` is created, add these fields:

**When reading cart metadata:**
```typescript
const cartMetadata = order.metadata || {}
const locationId = cartMetadata.location_id || null
const locationName = cartMetadata.location_name || null
```

**In the INSERT statement, add:**
```sql
location_id = ?,
location_name = ?
```

**In the parameters array, add:**
```typescript
locationId,
locationName,
```

---

## STEP 3: Display Location in Order Workflow Widget

**File**: `my-medusa-store/src/admin/widgets/order-workflow.tsx`

### 3.1 Update WorkflowData Interface
Find the `interface WorkflowData` (around line 17) and add these fields:

```typescript
interface WorkflowData {
  id: string
  order_id: string
  gfe_id: string | null
  status: string
  provider_name: string
  provider_status: string
  md_decision: string
  md_notes: string
  tracking_number: string
  carrier: string
  treatment_dosages: { treatmentId: number; treatmentName: string; dosage: string | null }[]
  pharmacy_queue_id?: string | null
  pharmacy_status?: string | null
  location_id: string | null          // ADD THIS
  location_name: string | null        // ADD THIS
}
```

### 3.2 Add Location Display
Find the comments section (around line 650, look for `{/* Comments section */}` or `💬 Comments`) and add this BEFORE it:

```tsx
      {/* Location info */}
      {workflow.location_name && (
        <div style={{ background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>📍</span>
            <div>
              <div style={{ fontWeight: 600, color: "#0369a1", marginBottom: 2 }}>Referral Location</div>
              <div style={{ color: "#0c4a6e" }}>{workflow.location_name}</div>
            </div>
          </div>
        </div>
      )}
```

---

## STEP 4: Run Migration

After all code changes are complete, run the migration:

```bash
cd my-medusa-store
npm run migration:run
```

Or if using the manual script:
```bash
node scripts/manual-migrate.js
```

---

## Testing Checklist

### Admin Testing:
1. ✅ Go to Clinic Operations → Locations tab
2. ✅ Add 2-3 test locations (e.g., "Main Office", "Downtown Branch")
3. ✅ Mark them as Active
4. ✅ Save and verify they appear in the list

### Storefront Testing:
1. ✅ Go to checkout page
2. ✅ Verify "Referral Location" section appears after shipping address
3. ✅ Select a location from dropdown
4. ✅ Complete the order
5. ✅ Verify you can't place order without selecting location (if locations exist)

### Order Display Testing:
1. ✅ Go to Admin → Clinic Operations → Orders
2. ✅ Click on the test order
3. ✅ Verify location appears in the workflow widget with 📍 icon
4. ✅ Verify it shows before the comments section

---

## Troubleshooting

### Location dropdown doesn't appear:
- Check browser console for API errors
- Verify `/api/clinic-locations` returns data
- Ensure clinic has active locations in admin

### Location not saving:
- Check browser network tab for `/api/cart-location` request
- Verify request succeeds (200 status)
- Check cart metadata in database

### Location not showing in order widget:
- Verify `order_workflow` table has `location_id` and `location_name` columns
- Check if data was transferred from cart metadata
- Verify widget is reading the fields correctly

---

## Summary

**Files Modified:**
1. ✅ Migration created
2. ✅ Backend APIs created
3. ✅ Admin UI Locations tab added
4. ⏳ Storefront checkout (needs Step 1)
5. ⏳ Order workflow transfer (needs Step 2)
6. ⏳ Order widget display (needs Step 3)

**Estimated Time:** 30-45 minutes to complete remaining steps
