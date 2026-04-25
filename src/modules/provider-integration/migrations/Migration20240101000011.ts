import { Migration } from "@mikro-orm/migrations"

export class Migration20240101000011 extends Migration {
  async up(): Promise<void> {
    // connect_env consolidated into api_env — drop redundant column from both tables
    this.addSql(`ALTER TABLE "clinic" DROP COLUMN IF EXISTS "connect_env"`)
    this.addSql(`ALTER TABLE "provider_settings" DROP COLUMN IF EXISTS "connect_env"`)
  }

  async down(): Promise<void> {
    this.addSql(`ALTER TABLE "clinic" ADD COLUMN IF NOT EXISTS "connect_env" VARCHAR(20) NOT NULL DEFAULT 'test'`)
    this.addSql(`ALTER TABLE "provider_settings" ADD COLUMN IF NOT EXISTS "connect_env" VARCHAR(20) NOT NULL DEFAULT 'test'`)
  }
}
