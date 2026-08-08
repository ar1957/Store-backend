import { Migration } from "@mikro-orm/migrations"

/**
 * Migration 24: order_split_count on product_treatment_map + pharmacy_sub_order table.
 *
 * order_split_count: set by admin at product-mapping time. 0 (default) = process
 * as a single pharmacy order, exactly as before. N > 0 = this product's order must
 * be submitted to the pharmacy as N SEPARATE orders (e.g. a "3 months supply"
 * product ships as 3 independent monthly orders, each at the next dosage tier),
 * because the pharmacy staggers shipping per order, not per line item.
 *
 * pharmacy_sub_order: every pharmacy order actually submitted for a Medusa order
 * gets one row here — 1 row for the normal (non-split) case, N rows for a split
 * product. Unifies tracking/status/display instead of having two code paths.
 */
export class Migration20240101000024 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "product_treatment_map"
        ADD COLUMN IF NOT EXISTS "order_split_count" INTEGER NOT NULL DEFAULT 0;
    `)

    this.addSql(`
      CREATE TABLE IF NOT EXISTS "pharmacy_sub_order" (
        "id"                            VARCHAR(255) NOT NULL,
        "order_workflow_id"             VARCHAR(255) NOT NULL,
        "split_index"                   INTEGER      NOT NULL,
        "split_count"                   INTEGER      NOT NULL DEFAULT 1,
        "treatment_id"                  INTEGER,
        "product_id"                    VARCHAR(255),
        "dosage"                        VARCHAR(255),
        "dosage_key"                    VARCHAR(100),
        "rxvortex_preset_catalog_id"    VARCHAR(255),
        "pharmacy_queue_id"             TEXT,
        "pharmacy_status"               TEXT,
        "pharmacy_submitted_at"         TIMESTAMPTZ,
        "tracking_number"               VARCHAR(255),
        "carrier"                       VARCHAR(100),
        "shipped_at"                    TIMESTAMPTZ,
        "pharmacy_submission_payload"   JSONB,
        "pharmacy_submission_response"  JSONB,
        "pharmacy_status_check_response" JSONB,
        "pharmacy_status_check_source"  VARCHAR(20),
        "pharmacy_status_checked_at"    TIMESTAMPTZ,
        "created_at"                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        "updated_at"                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        PRIMARY KEY ("id"),
        UNIQUE ("order_workflow_id", "split_index")
      );
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_pharmacy_sub_order_workflow" ON "pharmacy_sub_order" ("order_workflow_id");
    `)
    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_pharmacy_sub_order_queue" ON "pharmacy_sub_order" ("pharmacy_queue_id");
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "pharmacy_sub_order";`)
    this.addSql(`
      ALTER TABLE "product_treatment_map"
        DROP COLUMN IF EXISTS "order_split_count";
    `)
  }
}

export default Migration20240101000024
