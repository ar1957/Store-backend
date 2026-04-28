import { Migration } from "@mikro-orm/migrations"

export class Migration20240101000012 extends Migration {
  async up(): Promise<void> {
    // Bank details for clinic and pharmacy vendors (no split % — amounts derived from product costs)
    this.addSql(`
      CREATE TABLE IF NOT EXISTS vendor_payout_config (
        id                    TEXT PRIMARY KEY,
        clinic_id             TEXT NOT NULL UNIQUE,
        clinic_name           TEXT NOT NULL DEFAULT '',
        clinic_bank_routing   TEXT,
        clinic_bank_account   TEXT,
        clinic_bank_name      TEXT,
        clinic_account_name   TEXT,
        pharmacy_name         TEXT NOT NULL DEFAULT '',
        pharmacy_bank_routing TEXT,
        pharmacy_bank_account TEXT,
        pharmacy_bank_name    TEXT,
        pharmacy_account_name TEXT,
        notes                 TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    // Per-product pharmacy cost for a clinic.
    // pharmacy_cost = what the pharmacy charges for one unit of this product.
    // Clinic receives: order_total - sum(pharmacy_cost * qty) for that order.
    this.addSql(`
      CREATE TABLE IF NOT EXISTS product_payout_cost (
        id            TEXT PRIMARY KEY,
        clinic_id     TEXT NOT NULL,
        product_id    TEXT NOT NULL,
        product_title TEXT NOT NULL DEFAULT '',
        pharmacy_cost NUMERIC(10,2) NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (clinic_id, product_id)
      )
    `)

    this.addSql(`CREATE INDEX IF NOT EXISTS idx_product_payout_cost_clinic
      ON product_payout_cost (clinic_id)`)

    // Per-order amounts owed to each vendor (one row per vendor type per order)
    this.addSql(`
      CREATE TABLE IF NOT EXISTS vendor_ledger (
        id          TEXT PRIMARY KEY,
        clinic_id   TEXT NOT NULL,
        vendor_type TEXT NOT NULL CHECK (vendor_type IN ('clinic','pharmacy')),
        order_id    TEXT NOT NULL,
        order_total NUMERIC(10,2) NOT NULL DEFAULT 0,
        amount_owed NUMERIC(10,2) NOT NULL DEFAULT 0,
        currency    TEXT NOT NULL DEFAULT 'usd',
        status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
        payout_id   TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    this.addSql(`CREATE INDEX IF NOT EXISTS idx_vendor_ledger_clinic_vendor_status
      ON vendor_ledger (clinic_id, vendor_type, status)`)

    // One row per disbursement recorded by admin
    this.addSql(`
      CREATE TABLE IF NOT EXISTS vendor_payout (
        id               TEXT PRIMARY KEY,
        clinic_id        TEXT NOT NULL,
        vendor_type      TEXT NOT NULL CHECK (vendor_type IN ('clinic','pharmacy')),
        total_amount     NUMERIC(10,2) NOT NULL DEFAULT 0,
        currency         TEXT NOT NULL DEFAULT 'usd',
        reference_number TEXT,
        transfer_method  TEXT NOT NULL DEFAULT 'manual',
        notes            TEXT,
        status           TEXT NOT NULL DEFAULT 'completed',
        paid_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        paid_by          TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    this.addSql(`CREATE INDEX IF NOT EXISTS idx_vendor_payout_clinic
      ON vendor_payout (clinic_id, vendor_type)`)
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS vendor_ledger`)
    this.addSql(`DROP TABLE IF EXISTS vendor_payout`)
    this.addSql(`DROP TABLE IF EXISTS product_payout_cost`)
    this.addSql(`DROP TABLE IF EXISTS vendor_payout_config`)
  }
}
