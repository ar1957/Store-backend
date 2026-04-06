import { Migration } from "@mikro-orm/migrations"

/**
 * Migration 9: Add pharmacy integration fields to clinic table
 * and pharmacy_queue_id to order_workflow.
 */
export class Migration20240101000009 extends Migration {
  async up(): Promise<void> {
    // Pharmacy API config on clinic
    this.addSql(`
      ALTER TABLE "clinic"
        ADD COLUMN IF NOT EXISTS "pharmacy_type"        VARCHAR(100),
        ADD COLUMN IF NOT EXISTS "pharmacy_api_url"     VARCHAR(500),
        ADD COLUMN IF NOT EXISTS "pharmacy_api_key"     VARCHAR(500),
        ADD COLUMN IF NOT EXISTS "pharmacy_store_id"    VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "pharmacy_vendor_name" VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "pharmacy_doctor_first_name" VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "pharmacy_doctor_last_name"  VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "pharmacy_doctor_npi"        VARCHAR(50),
        ADD COLUMN IF NOT EXISTS "pharmacy_enabled"     BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS "pharmacy_username"    VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "pharmacy_password"    VARCHAR(500),
        ADD COLUMN IF NOT EXISTS "pharmacy_prescriber_id"     VARCHAR(100),
        ADD COLUMN IF NOT EXISTS "pharmacy_prescriber_address" VARCHAR(500),
        ADD COLUMN IF NOT EXISTS "pharmacy_prescriber_city"   VARCHAR(150),
        ADD COLUMN IF NOT EXISTS "pharmacy_prescriber_state"  VARCHAR(50),
        ADD COLUMN IF NOT EXISTS "pharmacy_prescriber_zip"    VARCHAR(50),
        ADD COLUMN IF NOT EXISTS "pharmacy_prescriber_phone"  VARCHAR(100),
        ADD COLUMN IF NOT EXISTS "pharmacy_prescriber_dea"    VARCHAR(20),
        ADD COLUMN IF NOT EXISTS "pharmacy_ship_type"   VARCHAR(50),
        ADD COLUMN IF NOT EXISTS "pharmacy_ship_rate"   VARCHAR(50),
        ADD COLUMN IF NOT EXISTS "pharmacy_pay_type"    VARCHAR(50);
    `)

    // Track pharmacy submission on order_workflow
    this.addSql(`
      ALTER TABLE "order_workflow"
        ADD COLUMN IF NOT EXISTS "pharmacy_queue_id"    TEXT,
        ADD COLUMN IF NOT EXISTS "pharmacy_submitted_at" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "pharmacy_status"      TEXT;
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "clinic"
        DROP COLUMN IF EXISTS "pharmacy_type",
        DROP COLUMN IF EXISTS "pharmacy_api_url",
        DROP COLUMN IF EXISTS "pharmacy_api_key",
        DROP COLUMN IF EXISTS "pharmacy_store_id",
        DROP COLUMN IF EXISTS "pharmacy_vendor_name",
        DROP COLUMN IF EXISTS "pharmacy_doctor_first_name",
        DROP COLUMN IF EXISTS "pharmacy_doctor_last_name",
        DROP COLUMN IF EXISTS "pharmacy_doctor_npi";
    `)
    this.addSql(`
      ALTER TABLE "order_workflow"
        DROP COLUMN IF EXISTS "pharmacy_queue_id",
        DROP COLUMN IF EXISTS "pharmacy_submitted_at",
        DROP COLUMN IF EXISTS "pharmacy_status";
    `)
  }
}

export default Migration20240101000009
