import { Migration } from "@mikro-orm/migrations"

/**
 * Migration 23: latest pharmacy status-check response on order_workflow.
 * Captures the raw response from whichever mechanism last reported this
 * order's pharmacy status — RxVortex's webhook push, or an active API poll
 * (RMM/DigitalRX) — so it can be inspected the same way the submission
 * payload/response already can.
 */
export class Migration20240101000023 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "order_workflow"
        ADD COLUMN IF NOT EXISTS "pharmacy_status_check_response" JSONB,
        ADD COLUMN IF NOT EXISTS "pharmacy_status_check_source"   VARCHAR(20),
        ADD COLUMN IF NOT EXISTS "pharmacy_status_checked_at"     TIMESTAMPTZ;
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "order_workflow"
        DROP COLUMN IF EXISTS "pharmacy_status_check_response",
        DROP COLUMN IF EXISTS "pharmacy_status_check_source",
        DROP COLUMN IF EXISTS "pharmacy_status_checked_at";
    `)
  }
}

export default Migration20240101000023
