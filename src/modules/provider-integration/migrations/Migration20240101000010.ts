import { Migration } from "@mikro-orm/migrations"

/**
 * Migration 10: Add PayPal payment fields to clinic table
 * and create clinic_promotion table for per-clinic promotion management.
 */
export class Migration20240101000010 extends Migration {
  async up(): Promise<void> {
    // PayPal + payment provider selection on clinic
    this.addSql(`
      ALTER TABLE "clinic"
        ADD COLUMN IF NOT EXISTS "payment_provider"      VARCHAR(20)  DEFAULT 'stripe',
        ADD COLUMN IF NOT EXISTS "paypal_client_id"      VARCHAR(500),
        ADD COLUMN IF NOT EXISTS "paypal_client_secret"  VARCHAR(500),
        ADD COLUMN IF NOT EXISTS "paypal_mode"           VARCHAR(20)  DEFAULT 'sandbox';
    `)

    // Per-clinic promotion assignments
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "clinic_promotion" (
        "id"           VARCHAR(255) NOT NULL,
        "clinic_id"    VARCHAR(255) NOT NULL,
        "promotion_id" VARCHAR(255) NOT NULL,
        "created_at"   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        PRIMARY KEY ("id"),
        UNIQUE ("clinic_id", "promotion_id"),
        CONSTRAINT "clinic_promotion_clinic_fkey"
          FOREIGN KEY ("clinic_id") REFERENCES "clinic" ("id") ON DELETE CASCADE
      );
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_clinic_promotion_clinic"
      ON "clinic_promotion" ("clinic_id");
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_clinic_promotion_promotion"
      ON "clinic_promotion" ("promotion_id");
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "clinic_promotion";`)
    this.addSql(`
      ALTER TABLE "clinic"
        DROP COLUMN IF EXISTS "payment_provider",
        DROP COLUMN IF EXISTS "paypal_client_id",
        DROP COLUMN IF EXISTS "paypal_client_secret",
        DROP COLUMN IF EXISTS "paypal_mode";
    `)
  }
}

export default Migration20240101000010
