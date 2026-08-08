import { Migration } from "@mikro-orm/migrations"

/**
 * Migration 22: pharmacy_submission_payload / pharmacy_submission_response
 * Persists the actual request sent to the pharmacy API (RxVortex, RMM,
 * DigitalRX — whichever) and the raw response received, so submissions can
 * be inspected in the DB instead of only in ephemeral server logs.
 */
export class Migration20240101000022 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "order_workflow"
        ADD COLUMN IF NOT EXISTS "pharmacy_submission_payload"  JSONB,
        ADD COLUMN IF NOT EXISTS "pharmacy_submission_response" JSONB;
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "order_workflow"
        DROP COLUMN IF EXISTS "pharmacy_submission_payload",
        DROP COLUMN IF EXISTS "pharmacy_submission_response";
    `)
  }
}

export default Migration20240101000022
