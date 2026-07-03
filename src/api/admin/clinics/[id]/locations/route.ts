import { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * GET /admin/clinics/:id/locations
 * Returns all locations for this clinic
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id } = req.params

    const result = await pg.raw(
      `SELECT id, name, address, city, state, zip, phone, is_active, display_order, created_at, updated_at
       FROM clinic_location
       WHERE clinic_id = ?
       ORDER BY display_order ASC, name ASC`,
      [id]
    )
    return res.json({ locations: result.rows })
  } catch (err: unknown) {
    console.error("[locations GET]", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

/**
 * POST /admin/clinics/:id/locations
 * Create or update locations for this clinic
 * Body: { locations: [{ id?, name, address, city, state, zip, phone, is_active, display_order }] }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id } = req.params
    const { locations } = req.body as any

    if (!Array.isArray(locations)) {
      return res.status(400).json({ message: "locations array is required" })
    }

    // Delete locations that were removed — anything with an existing ID not in the submitted list
    const submittedIds = locations.filter(loc => loc.id).map(loc => loc.id)
    if (submittedIds.length > 0) {
      await pg.raw(
        `DELETE FROM clinic_location WHERE clinic_id = ? AND id NOT IN (${submittedIds.map(() => "?").join(", ")})`,
        [id, ...submittedIds]
      )
    } else {
      // No existing IDs submitted — wipe all and start fresh
      await pg.raw(`DELETE FROM clinic_location WHERE clinic_id = ?`, [id])
    }

    for (const loc of locations) {
      if (!loc.name?.trim()) {
        return res.status(400).json({ message: "Location name is required" })
      }

      const locationId = loc.id || `loc_${id}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
      
      await pg.raw(`
        INSERT INTO clinic_location 
          (id, clinic_id, name, address, city, state, zip, phone, is_active, display_order, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          address = EXCLUDED.address,
          city = EXCLUDED.city,
          state = EXCLUDED.state,
          zip = EXCLUDED.zip,
          phone = EXCLUDED.phone,
          is_active = EXCLUDED.is_active,
          display_order = EXCLUDED.display_order,
          updated_at = NOW()
      `, [
        locationId,
        id,
        loc.name.trim(),
        loc.address || null,
        loc.city || null,
        loc.state || null,
        loc.zip || null,
        loc.phone || null,
        loc.is_active !== false,
        loc.display_order || 0,
      ])
    }

    const saved = await pg.raw(
      `SELECT id, name, address, city, state, zip, phone, is_active, display_order
       FROM clinic_location
       WHERE clinic_id = ?
       ORDER BY display_order ASC, name ASC`,
      [id]
    )
    return res.json({ locations: saved.rows })
  } catch (err: unknown) {
    console.error("[locations POST]", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}

/**
 * DELETE /admin/clinics/:id/locations/:locationId
 * Delete a location
 */
export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  try {
    const pg = req.scope.resolve("__pg_connection__") as any
    const { id, locationId } = req.params

    await pg.raw(
      `DELETE FROM clinic_location WHERE id = ? AND clinic_id = ?`,
      [locationId, id]
    )

    return res.json({ success: true })
  } catch (err: unknown) {
    console.error("[locations DELETE]", err)
    return res.status(500).json({ message: err instanceof Error ? err.message : "Error" })
  }
}
