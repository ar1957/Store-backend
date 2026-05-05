import { Migration } from "@mikro-orm/migrations"

/**
 * Migration 10: Add is_translation_allowed flag to clinic table.
 * Controls whether the EN/ES language toggle appears on the storefront.
 */
export class Migration20240101000010 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "clinic"
        ADD COLUMN IF NOT EXISTS "is_translation_allowed" BOOLEAN NOT NULL DEFAULT false;
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "clinic"
        DROP COLUMN IF EXISTS "is_translation_allowed";
    `)
  }
}

export default Migration20240101000010
