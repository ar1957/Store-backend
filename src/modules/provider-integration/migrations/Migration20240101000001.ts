import { Migration } from "@mikro-orm/migrations"

export class Migration20240101000001 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "provider_settings" (
        "id"                    VARCHAR(255) NOT NULL,
        "tenant_domain"         VARCHAR(255) NOT NULL,
        "client_id"             VARCHAR(500),
        "client_secret"         VARCHAR(500),
        "api_base_url"          VARCHAR(500) NOT NULL DEFAULT 'https://api-dev.healthcoversonline.com/endpoint/v2',
        "api_env"               VARCHAR(20)  NOT NULL DEFAULT 'test',
        "connect_url_test"      VARCHAR(500),
        "connect_url_prod"      VARCHAR(500),
        "connect_env"           VARCHAR(20)  NOT NULL DEFAULT 'test',
        "redirect_url"          VARCHAR(500),
        "is_active"             BOOLEAN      NOT NULL DEFAULT false,
        "created_at"            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        "updated_at"            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT "provider_settings_tenant_domain_unique" UNIQUE ("tenant_domain"),
        PRIMARY KEY ("id")
      );
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_provider_settings_tenant" 
      ON "provider_settings" ("tenant_domain");
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "provider_settings";`)
  }
}

export default Migration20240101000001