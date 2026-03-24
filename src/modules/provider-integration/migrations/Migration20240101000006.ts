import { Migration } from "@mikro-orm/migrations"

export class Migration20240101000006 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "clinic_ui_config"
        ADD COLUMN IF NOT EXISTS "bottom_links"            JSONB        DEFAULT '[]',
        ADD COLUMN IF NOT EXISTS "contact_phone"           VARCHAR(100),
        ADD COLUMN IF NOT EXISTS "contact_email"           VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "contact_address"         TEXT,
        ADD COLUMN IF NOT EXISTS "social_links"            JSONB        DEFAULT '[]',
        ADD COLUMN IF NOT EXISTS "certification_image_url" VARCHAR(500);
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "clinic_ui_config"
        DROP COLUMN IF EXISTS "bottom_links",
        DROP COLUMN IF EXISTS "contact_phone",
        DROP COLUMN IF EXISTS "contact_email",
        DROP COLUMN IF EXISTS "contact_address",
        DROP COLUMN IF EXISTS "social_links",
        DROP COLUMN IF EXISTS "certification_image_url";
    `)
  }
}

export default Migration20240101000006
