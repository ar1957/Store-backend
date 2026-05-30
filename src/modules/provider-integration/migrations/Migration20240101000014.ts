import { Migration } from "@mikro-orm/migrations"

export class Migration20240101000014 extends Migration {
  async up(): Promise<void> {
    // Allow pharmacist to override the pharmacy cost for a specific order at ship time.
    // When set, this value is used instead of the product_payout_cost default.
    this.addSql(`
      ALTER TABLE order_workflow
      ADD COLUMN IF NOT EXISTS pharmacy_cost_override NUMERIC(10,2)
    `)
  }

  async down(): Promise<void> {
    this.addSql(`ALTER TABLE order_workflow DROP COLUMN IF EXISTS pharmacy_cost_override`)
  }
}
