import { Migration } from "@mikro-orm/migrations"

export class Migration20240101000015 extends Migration {
  async up(): Promise<void> {
    // Per-line-item pharmacy cost overrides set by pharmacist at ship time
    this.addSql(`
      CREATE TABLE IF NOT EXISTS order_item_pharmacy_cost (
        id            TEXT PRIMARY KEY,
        order_id      TEXT NOT NULL,
        line_item_id  TEXT NOT NULL,
        product_id    TEXT NOT NULL,
        product_title TEXT NOT NULL DEFAULT '',
        quantity      INTEGER NOT NULL DEFAULT 1,
        default_cost  NUMERIC(10,2) NOT NULL DEFAULT 0,
        actual_cost   NUMERIC(10,2) NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (order_id, line_item_id)
      )
    `)
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_order_item_pharmacy_cost_order ON order_item_pharmacy_cost (order_id)`)
    
    // Remove the old single-value override column (replaced by per-item table)
    this.addSql(`ALTER TABLE order_workflow DROP COLUMN IF EXISTS pharmacy_cost_override`)
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS order_item_pharmacy_cost`)
    this.addSql(`ALTER TABLE order_workflow ADD COLUMN IF NOT EXISTS pharmacy_cost_override NUMERIC(10,2)`)
  }
}
