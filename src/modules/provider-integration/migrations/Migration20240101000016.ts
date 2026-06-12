import { Migration } from "@mikro-orm/migrations"

export class Migration20240101000016 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE clinic
      ADD COLUMN IF NOT EXISTS authorizenet_api_login_id      TEXT,
      ADD COLUMN IF NOT EXISTS authorizenet_transaction_key   TEXT,
      ADD COLUMN IF NOT EXISTS authorizenet_public_client_key TEXT,
      ADD COLUMN IF NOT EXISTS authorizenet_mode              TEXT DEFAULT 'sandbox'
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE clinic
      DROP COLUMN IF EXISTS authorizenet_api_login_id,
      DROP COLUMN IF EXISTS authorizenet_transaction_key,
      DROP COLUMN IF EXISTS authorizenet_public_client_key,
      DROP COLUMN IF EXISTS authorizenet_mode
    `)
  }
}
