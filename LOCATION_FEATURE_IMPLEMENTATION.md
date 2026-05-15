# Location Feature Implementation Guide

## Overview
This feature allows clinics to manage multiple locations and track which location referred each patient.

## Completed Steps

### 1. Database Migration ✅
- Created `Migration20240101000013.ts`
- Adds `clinic_location` table
- Adds `location_id` and `location_name` columns to `order_workflow`

### 2. Backend API Endpoints ✅
- `GET/POST /admin/clinics/:id/locations` - Manage locations (admin)
- `GET /store/clinics/locations` - Fetch active locations (storefront)
- `POST /store/carts/location` - Save location to cart metadata

### 3. Storefront API Proxies ✅
- `/api/clinic-locations` - Fetch locations
- `/api/cart-location` - Save location selection

## Remaining Steps

### 4. Admin UI - Locations Tab
**File**: `my-medusa-store/src/admin/routes/provider-settings/page.tsx`

Add a new `LocationsTab` component similar to other tabs:

```typescript
function LocationsTab({ clinic }: { clinic: Clinic }) {
  const [locations, setLocations] = useState<any[]>([])
  const [editing, setEditing] = useState(false)
  const [editData, setEditData] = useState<any[]>([])
  
  // Load locations
  // Add/Edit/Delete UI
  // Save functionality
}
```

Add to the tab navigation around line 400:
```typescript
{tab === "locations" && <LocationsTab clinic={selectedClinic} />}
```

### 5. Storefront - Location Selector in Checkout
**File**: `my-medusa-store-storefront/src/modules/checkout/components/single-page-checkout/index.tsx`

Add after the shipping address section (around line 300):

```typescript
// Fetch locations
const [locations, setLocations] = useState<any[]>([])
const [selectedLocation, setSelectedLocation] = useState<string>("")

useEffect(() => {
  fetch("/api/clinic-locations")
    .then(r => r.json())
    .then(d => setLocations(d.locations || []))
}, [])

// Save location when selected
const handleLocationChange = async (locationId: string) => {
  const loc = locations.find(l => l.id === locationId)
  if (loc) {
    await fetch("/api/cart-location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cartId: cart.id,
        locationId: loc.id,
        locationName: loc.name,
      }),
    })
    setSelectedLocation(locationId)
  }
}
```

Add UI after shipping address:
```tsx
{locations.length > 0 && (
  <section className="bg-white">
    <h2 className="text-3xl-regular font-semibold mb-6">Referral Location</h2>
    <p className="text-sm text-ui-fg-muted mb-4">
      Which location referred you?
    </p>
    <select
      value={selectedLocation}
      onChange={(e) => handleLocationChange(e.target.value)}
      required
      className="w-full rounded-md border border-ui-border-base bg-ui-bg-field px-4 py-3"
    >
      <option value="">Select a location *</option>
      {locations.map(loc => (
        <option key={loc.id} value={loc.id}>
          {loc.name} {loc.city && `- ${loc.city}, ${loc.state}`}
        </option>
      ))}
    </select>
    <hr className="mt-8" />
  </section>
)}
```

### 6. Transfer Location from Cart to Order Workflow
**File**: Find where `order_workflow` is created (likely in a job or subscriber)

When creating order_workflow record, add:
```typescript
const cartMetadata = order.metadata || {}
const locationId = cartMetadata.location_id
const locationName = cartMetadata.location_name

// Include in INSERT:
location_id = ?,
location_name = ?
```

### 7. Display Location in Order Workflow Widget
**File**: `my-medusa-store/src/admin/widgets/order-workflow.tsx`

Add to WorkflowData interface (around line 17):
```typescript
interface WorkflowData {
  // ... existing fields
  location_id: string | null
  location_name: string | null
}
```

Add display before comments section (around line 650):
```tsx
{/* Location info */}
{workflow.location_name && (
  <div style={{ background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 8, padding: 10, marginBottom: 16, fontSize: 13 }}>
    📍 Referred by: <strong>{workflow.location_name}</strong>
  </div>
)}
```

## Testing Checklist

1. ✅ Run migration: `npm run migration:run`
2. ⬜ Admin: Add locations in Clinic Operations → Locations tab
3. ⬜ Storefront: Verify location selector appears during checkout
4. ⬜ Storefront: Select a location and complete order
5. ⬜ Admin: Verify location appears in order workflow widget

## Database Schema

### clinic_location
- `id` (TEXT, PK)
- `clinic_id` (TEXT)
- `name` (TEXT)
- `address`, `city`, `state`, `zip`, `phone` (TEXT, optional)
- `is_active` (BOOLEAN)
- `display_order` (INTEGER)
- `created_at`, `updated_at` (TIMESTAMPTZ)

### order_workflow (new columns)
- `location_id` (TEXT, nullable)
- `location_name` (TEXT, nullable)
