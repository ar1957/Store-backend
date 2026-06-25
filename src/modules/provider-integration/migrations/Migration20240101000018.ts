import { Migration } from "@mikro-orm/migrations"

/**
 * Migration 18: Add rxvortex_preset_catalog_id to product_treatment_map.
 * Allows each product-to-treatment mapping to store a Strive/RxVortex
 * preset catalog ID so orders are submitted with the correct medication.
 */
export class Migration20240101000018 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "product_treatment_map"
        ADD COLUMN IF NOT EXISTS "rxvortex_preset_catalog_id" VARCHAR(255);
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "product_treatment_map"
        DROP COLUMN IF EXISTS "rxvortex_preset_catalog_id";
    `)
  }
}

export default Migration20240101000018
