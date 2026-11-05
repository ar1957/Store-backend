import { Migration } from "@mikro-orm/migrations"

/**
 * Migration 30: rx_statuses on pharmacy_sub_order.
 *
 * Strive sends one status webhook PER medication_request (foreignrxnumber =
 * our sender_med_request_id) even when several share one order. This holds
 * the latest status/tracking per rx — { "<sender_med_request_id>": {...} } —
 * so the sub-order's own pharmacy_status/tracking are derived from all of
 * them instead of whichever callback arrived last.
 */
export class Migration20240101000030 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "pharmacy_sub_order"
        ADD COLUMN IF NOT EXISTS "rx_statuses" JSONB;
    `)
  }

  async down(): Promise<void> {
    this.addSql(`ALTER TABLE "pharmacy_sub_order" DROP COLUMN IF EXISTS "rx_statuses";`)
  }
}

export default Migration20240101000030
