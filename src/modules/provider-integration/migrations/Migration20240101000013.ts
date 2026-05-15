import { Migration } from "@mikro-orm/migrations"

export class Migration20240101000013 extends Migration {
  async up(): Promise<void> {
    // Clinic locations table - allows clinics to track which location/office referred the patient
    this.addSql(`
      CREATE TABLE IF NOT EXISTS clinic_location (
        id            TEXT PRIMARY KEY,
        clinic_id     TEXT NOT NULL,
        name          TEXT NOT NULL,
        address       TEXT,
        city          TEXT,
        state         TEXT,
        zip           TEXT,
        phone         TEXT,
        is_active     BOOLEAN NOT NULL DEFAULT true,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    this.addSql(`CREATE INDEX IF NOT EXISTS idx_clinic_location_clinic
      ON clinic_location (clinic_id, is_active)`)

    // Add location_id to order_workflow to track which location the patient selected
    this.addSql(`
      ALTER TABLE order_workflow
      ADD COLUMN IF NOT EXISTS location_id TEXT,
      ADD COLUMN IF NOT EXISTS location_name TEXT
    `)

    this.addSql(`CREATE INDEX IF NOT EXISTS idx_order_workflow_location
      ON order_workflow (location_id)`)
  }

  async down(): Promise<void> {
    this.addSql(`ALTER TABLE order_workflow DROP COLUMN IF EXISTS location_id`)
    this.addSql(`ALTER TABLE order_workflow DROP COLUMN IF EXISTS location_name`)
    this.addSql(`DROP TABLE IF EXISTS clinic_location`)
  }
}
