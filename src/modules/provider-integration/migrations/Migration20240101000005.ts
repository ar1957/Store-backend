import { Migration } from "@mikro-orm/migrations"

export class Migration20240101000005 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "clinic_ui_config" (
        "id"                VARCHAR(255) NOT NULL,
        "tenant_domain"     VARCHAR(255) NOT NULL,
        "nav_links"         JSONB        DEFAULT '[]',
        "footer_links"      JSONB        DEFAULT '[]',
        "logo_url"          VARCHAR(500),
        "get_started_url"   VARCHAR(500),
        "created_at"        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        "updated_at"        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        PRIMARY KEY ("id")
      );
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_clinic_ui_config_tenant" 
      ON "clinic_ui_config" ("tenant_domain");
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "clinic_ui_config";`)
  }
}

export default Migration20240101000005