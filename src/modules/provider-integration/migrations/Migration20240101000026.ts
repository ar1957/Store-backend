import { Migration } from "@mikro-orm/migrations"

/**
 * Migration 26: RxVortex medication_form + quantity_units + quantity on the
 * catalog mapping tables (product_treatment_map, treatment_dosage_catalog_map).
 *
 * Strive/RxVortex feedback:
 *  - quantity_units must reflect the actual dosage form of the medication
 *    ("each" / "ML" / "grams") instead of the previous flat "each" sent for
 *    every line item.
 *  - injectables must be submitted with days_supply_duration capped at 28
 *    (vial safety window) instead of the flat 30 used for everything.
 *  - quantity must match the product volume/count on the catalog item itself
 *    (e.g. a 2ML vial submits quantity: 2, quantity_units: "ML"), not the
 *    number of units the patient added to their cart — those are different
 *    numbers (cart quantity is almost always 1 in this subscription-dosing
 *    model; order_split_count already handles monthly refills).
 * All three values live on the RxVortex catalog item (medication_form,
 * quantity_units, quantity) already surfaced by the catalog picker
 * (GET /admin/clinics/:id/rxvortex-catalog), so rather than re-fetching the
 * catalog at submission time (this repo's stated convention — dosage tiers
 * are resolved from treatment_dosage_catalog_map alone, never a live call at
 * submission time, per Migration20240101000021), they're captured once when
 * an admin picks a catalog item in provider-settings and stored alongside
 * the existing rxvortex_preset_catalog_id.
 */
export class Migration20240101000026 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "product_treatment_map"
        ADD COLUMN IF NOT EXISTS "rxvortex_medication_form" VARCHAR(255);
    `)
    this.addSql(`
      ALTER TABLE "product_treatment_map"
        ADD COLUMN IF NOT EXISTS "rxvortex_quantity_units" VARCHAR(50);
    `)
    this.addSql(`
      ALTER TABLE "product_treatment_map"
        ADD COLUMN IF NOT EXISTS "rxvortex_quantity" VARCHAR(50);
    `)
    this.addSql(`
      ALTER TABLE "treatment_dosage_catalog_map"
        ADD COLUMN IF NOT EXISTS "rxvortex_medication_form" VARCHAR(255);
    `)
    this.addSql(`
      ALTER TABLE "treatment_dosage_catalog_map"
        ADD COLUMN IF NOT EXISTS "rxvortex_quantity_units" VARCHAR(50);
    `)
    this.addSql(`
      ALTER TABLE "treatment_dosage_catalog_map"
        ADD COLUMN IF NOT EXISTS "rxvortex_quantity" VARCHAR(50);
    `)
  }

  async down(): Promise<void> {
    this.addSql(`ALTER TABLE "treatment_dosage_catalog_map" DROP COLUMN IF EXISTS "rxvortex_quantity";`)
    this.addSql(`ALTER TABLE "treatment_dosage_catalog_map" DROP COLUMN IF EXISTS "rxvortex_quantity_units";`)
    this.addSql(`ALTER TABLE "treatment_dosage_catalog_map" DROP COLUMN IF EXISTS "rxvortex_medication_form";`)
    this.addSql(`ALTER TABLE "product_treatment_map" DROP COLUMN IF EXISTS "rxvortex_quantity";`)
    this.addSql(`ALTER TABLE "product_treatment_map" DROP COLUMN IF EXISTS "rxvortex_quantity_units";`)
    this.addSql(`ALTER TABLE "product_treatment_map" DROP COLUMN IF EXISTS "rxvortex_medication_form";`)
  }
}

export default Migration20240101000026
