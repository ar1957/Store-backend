/**
 * Migration: Track pharmacy auto-submit failures on order_workflow so the
 * poll job can stop retrying orders that will never succeed on their own
 * (e.g. missing catalog mapping, missing patient phone) instead of
 * re-attempting submission every 5 minutes forever.
 */
import { Migration } from "@mikro-orm/migrations"

export class Migration20240101000020 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "order_workflow"
        ADD COLUMN IF NOT EXISTS "pharmacy_submit_attempts" INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "pharmacy_last_error"       TEXT,
        ADD COLUMN IF NOT EXISTS "pharmacy_blocked_at"       TIMESTAMPTZ;
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "order_workflow"
        DROP COLUMN IF EXISTS "pharmacy_submit_attempts",
        DROP COLUMN IF EXISTS "pharmacy_last_error",
        DROP COLUMN IF EXISTS "pharmacy_blocked_at";
    `)
  }
}

export default Migration20240101000020
