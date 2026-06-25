import { Migration } from "@mikro-orm/migrations"

/**
 * Migration 17: Add RxVortex (Strive) pharmacy integration fields to clinic table.
 * RxVortex uses client_id/client_secret OAuth and requires a preset_catalog_id
 * (or product_id) per medication, plus an optional subdomain for the production URL.
 */
export class Migration20240101000017 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "clinic"
        ADD COLUMN IF NOT EXISTS "pharmacy_client_id"       VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "pharmacy_client_secret"   VARCHAR(500),
        ADD COLUMN IF NOT EXISTS "pharmacy_subdomain"       VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "pharmacy_preset_catalog_id" VARCHAR(255);
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "clinic"
        DROP COLUMN IF EXISTS "pharmacy_client_id",
        DROP COLUMN IF EXISTS "pharmacy_client_secret",
        DROP COLUMN IF EXISTS "pharmacy_subdomain",
        DROP COLUMN IF EXISTS "pharmacy_preset_catalog_id";
    `)
  }
}

export default Migration20240101000017
