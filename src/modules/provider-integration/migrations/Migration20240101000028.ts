import { Migration } from "@mikro-orm/migrations"

/**
 * Migration 28: admin-typed quantity override on the catalog mapping tables
 * (product_treatment_map, treatment_dosage_catalog_map).
 *
 * Strive's catalog only has discrete vial sizes (1/2/3/4ML for Tirzepatide),
 * which don't line up with every dose on a clinic's actual titration
 * schedule (e.g. an 11mg dose needs 4.4mL total for a 4-week/28-day supply,
 * but no existing vial is labeled that size). Mirrors the existing
 * rxvortex_instructions manual-override pattern: rxvortex_quantity (added in
 * Migration20240101000026) is captured automatically from the picked catalog
 * item and used by default; this new column lets an admin independently
 * override just the quantity number for a specific dosage tier, so an
 * existing (clinically-appropriate but not exactly-sized) catalog item can
 * be reused with the correct total volume instead of requiring Strive to add
 * a new catalog item, or the clinic creating a new MHC treatment, every time
 * a dose doesn't land on an exact vial breakpoint.
 *
 * Does NOT affect days_supply_duration — that stays hardcoded to 28 for
 * injectables regardless of quantity (resolveDaysSupply in
 * pharmacy-submit-rxvortex.ts), independently satisfying Strive's 28-day
 * multi-dose vial puncture rule no matter what quantity is submitted.
 */
export class Migration20240101000028 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "product_treatment_map"
        ADD COLUMN IF NOT EXISTS "rxvortex_quantity_override" VARCHAR(50);
    `)
    this.addSql(`
      ALTER TABLE "treatment_dosage_catalog_map"
        ADD COLUMN IF NOT EXISTS "rxvortex_quantity_override" VARCHAR(50);
    `)
  }

  async down(): Promise<void> {
    this.addSql(`ALTER TABLE "treatment_dosage_catalog_map" DROP COLUMN IF EXISTS "rxvortex_quantity_override";`)
    this.addSql(`ALTER TABLE "product_treatment_map" DROP COLUMN IF EXISTS "rxvortex_quantity_override";`)
  }
}

export default Migration20240101000028
