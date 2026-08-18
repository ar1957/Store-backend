import { Migration } from "@mikro-orm/migrations"

/**
 * Migration 27: RxVortex catalog item's own `instruction` template text on
 * the catalog mapping tables (product_treatment_map, treatment_dosage_catalog_map).
 *
 * Strive/RxVortex feedback: when submitting with preset_catalog_id, whatever
 * is sent in `instructions` OVERRIDES the catalog template's own instruction
 * text — sending a generic "Take as directed — 14 mg (x4)" (our own dose
 * label appended to a placeholder) caused a real order to get flagged for
 * pharmacist clarification. Strive wants the catalog item's own instruction
 * (e.g. "Inject 140 units (1.4 mL) subcutaneously once weekly for 4 weeks",
 * already surfaced by GET /api/v1/preset-catalog-items as `instruction`)
 * sent verbatim instead. This is distinct from the existing
 * rxvortex_instructions column, which holds an admin's own manually-typed
 * override (with the patient's dose auto-appended) — that manual path is
 * preserved for when a clinic deliberately wants custom wording; this new
 * column is the catalog's own template text, used when no manual override
 * is set, so orders default to Strive's own clinically-correct phrasing
 * rather than a generic placeholder.
 */
export class Migration20240101000027 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "product_treatment_map"
        ADD COLUMN IF NOT EXISTS "rxvortex_catalog_instruction" TEXT;
    `)
    this.addSql(`
      ALTER TABLE "treatment_dosage_catalog_map"
        ADD COLUMN IF NOT EXISTS "rxvortex_catalog_instruction" TEXT;
    `)
  }

  async down(): Promise<void> {
    this.addSql(`ALTER TABLE "treatment_dosage_catalog_map" DROP COLUMN IF EXISTS "rxvortex_catalog_instruction";`)
    this.addSql(`ALTER TABLE "product_treatment_map" DROP COLUMN IF EXISTS "rxvortex_catalog_instruction";`)
  }
}

export default Migration20240101000027
