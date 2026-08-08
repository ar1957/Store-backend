import { Migration } from "@mikro-orm/migrations"

/**
 * Migration 21: treatment_dosage_catalog_map
 * Maps a (treatment, dosage) pair to a pharmacy preset catalog ID, so orders
 * are submitted with the catalog item matching the patient's actual
 * prescribed dosage rather than a single fixed catalog ID per product.
 * Mirrors product_treatment_map's tenant_domain scoping.
 */
export class Migration20240101000021 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "treatment_dosage_catalog_map" (
        "id"                         VARCHAR(255) NOT NULL,
        "tenant_domain"              VARCHAR(255) NOT NULL,
        "treatment_id"               INTEGER      NOT NULL,
        "treatment_name"             VARCHAR(255),
        "dosage"                     VARCHAR(255) NOT NULL,
        "dosage_key"                 VARCHAR(100),
        "rxvortex_preset_catalog_id" VARCHAR(255) NOT NULL,
        "rxvortex_instructions"      TEXT,
        "created_at"                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        "updated_at"                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        "deleted_at"                 TIMESTAMPTZ,
        PRIMARY KEY ("id"),
        UNIQUE ("tenant_domain", "treatment_id", "dosage")
      );
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_treatment_dosage_catalog_tenant"
      ON "treatment_dosage_catalog_map" ("tenant_domain");
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_treatment_dosage_catalog_treatment"
      ON "treatment_dosage_catalog_map" ("tenant_domain", "treatment_id");
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "treatment_dosage_catalog_map";`)
  }
}

export default Migration20240101000021
