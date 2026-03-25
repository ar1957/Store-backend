import { Migration } from "@mikro-orm/migrations"

/**
 * Migration 8: Add missing columns to order_workflow and create order_comment table.
 * These were added directly to the local DB without a migration file.
 * All statements use IF NOT EXISTS / IF EXISTS so they are safe to re-run.
 */
export class Migration20240101000008 extends Migration {
  async up(): Promise<void> {
    // ── order_workflow missing columns ──────────────────────────────────────
    this.addSql(`
      ALTER TABLE "order_workflow"
        ADD COLUMN IF NOT EXISTS "deleted_at"          TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "pharmacy_staff_id"   TEXT,
        ADD COLUMN IF NOT EXISTS "provider_decided_at" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "md_decided_at"       TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "refunded_at"         TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "refund_reason"       TEXT;
    `)

    // Unique constraint on gfe_id (may already exist locally)
    this.addSql(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'order_workflow_gfe_id_unique'
        ) THEN
          ALTER TABLE "order_workflow"
            ADD CONSTRAINT "order_workflow_gfe_id_unique" UNIQUE ("gfe_id");
        END IF;
      END $$;
    `)

    // ── clinic_staff missing column ─────────────────────────────────────────
    this.addSql(`
      ALTER TABLE "clinic_staff"
        ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ;
    `)

    // ── order_comment table ─────────────────────────────────────────────────
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "order_comment" (
        "id"               VARCHAR(255) NOT NULL,
        "order_workflow_id" VARCHAR(255) NOT NULL,
        "user_id"          VARCHAR(255) NOT NULL,
        "user_email"       VARCHAR(255) NOT NULL,
        "user_name"        VARCHAR(255) NOT NULL,
        "role"             VARCHAR(255) NOT NULL,
        "comment"          TEXT         NOT NULL,
        "created_at"       TIMESTAMPTZ  DEFAULT NOW(),
        PRIMARY KEY ("id"),
        CONSTRAINT "order_comment_order_workflow_id_fkey"
          FOREIGN KEY ("order_workflow_id")
          REFERENCES "order_workflow" ("id")
          ON DELETE CASCADE
      );
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_order_comment_workflow"
      ON "order_comment" ("order_workflow_id");
    `)

    // ── stripe columns on clinic ────────────────────────────────────────────
    this.addSql(`
      ALTER TABLE "clinic"
        ADD COLUMN IF NOT EXISTS "stripe_publishable_key" VARCHAR(500),
        ADD COLUMN IF NOT EXISTS "stripe_secret_key"      VARCHAR(500),
        ADD COLUMN IF NOT EXISTS "deleted_at"             TIMESTAMPTZ;
    `)

    // ── clinic_ui_config clinic_id column ───────────────────────────────────
    this.addSql(`
      ALTER TABLE "clinic_ui_config"
        ADD COLUMN IF NOT EXISTS "clinic_id" VARCHAR(255);
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "order_comment";`)
    this.addSql(`
      ALTER TABLE "order_workflow"
        DROP COLUMN IF EXISTS "deleted_at",
        DROP COLUMN IF EXISTS "pharmacy_staff_id",
        DROP COLUMN IF EXISTS "provider_decided_at",
        DROP COLUMN IF EXISTS "md_decided_at",
        DROP COLUMN IF EXISTS "refunded_at",
        DROP COLUMN IF EXISTS "refund_reason";
    `)
    this.addSql(`
      ALTER TABLE "clinic"
        DROP COLUMN IF EXISTS "stripe_publishable_key",
        DROP COLUMN IF EXISTS "stripe_secret_key",
        DROP COLUMN IF EXISTS "deleted_at";
    `)
    this.addSql(`
      ALTER TABLE "clinic_ui_config"
        DROP COLUMN IF EXISTS "clinic_id";
    `)
    this.addSql(`
      ALTER TABLE "clinic_staff"
        DROP COLUMN IF EXISTS "deleted_at";
    `)
  }
}

export default Migration20240101000008
