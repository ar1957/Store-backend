import { Migration } from "@mikro-orm/migrations"

/**
 * Migration 29: canceled_at on order_workflow.
 *
 * Mirrors the existing status+timestamp convention (shipped/shipped_at,
 * refund_issued/refund_issued_at) for a new 'canceled' order_workflow.status
 * value, set when Medusa's native order-cancel workflow fires (see the new
 * order-canceled.ts subscriber) so the clinic workflow view reflects that
 * the underlying order was canceled without requiring the order_workflow
 * row itself to be deleted.
 */
export class Migration20240101000029 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "order_workflow"
        ADD COLUMN IF NOT EXISTS "canceled_at" TIMESTAMPTZ;
    `)
  }

  async down(): Promise<void> {
    this.addSql(`ALTER TABLE "order_workflow" DROP COLUMN IF EXISTS "canceled_at";`)
  }
}

export default Migration20240101000029
