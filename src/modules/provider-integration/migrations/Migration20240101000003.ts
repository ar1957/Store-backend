import { Migration } from "@mikro-orm/migrations"

export class Migration20240101000003 extends Migration {
  async up(): Promise<void> {

    this.addSql(`
      CREATE TABLE IF NOT EXISTS "clinic" (
        "id"                    VARCHAR(255) NOT NULL,
        "name"                  VARCHAR(255) NOT NULL,
        "slug"                  VARCHAR(100) NOT NULL,
        "domains"               TEXT[]       NOT NULL DEFAULT '{}',
        "contact_email"         VARCHAR(255),
        "is_active"             BOOLEAN      NOT NULL DEFAULT true,
        "logo_url"              VARCHAR(500),
        "brand_color"           VARCHAR(20)  DEFAULT '#111111',
        "api_client_id"         VARCHAR(500),
        "api_client_secret"     VARCHAR(500),
        "api_env"               VARCHAR(20)  NOT NULL DEFAULT 'test',
        "api_base_url_test"     VARCHAR(500) DEFAULT 'https://api-dev.healthcoversonline.com/endpoint/v2',
        "api_base_url_prod"     VARCHAR(500) DEFAULT 'https://api.healthcoversonline.com/endpoint/v2',
        "connect_env"           VARCHAR(20)  NOT NULL DEFAULT 'test',
        "connect_url_test"      VARCHAR(500) DEFAULT 'https://app.healthcoversonline.com/connect/patient',
        "connect_url_prod"      VARCHAR(500) DEFAULT 'https://app.healthcoversonline.com/connect/patient',
        "redirect_url"          VARCHAR(500),
        "publishable_api_key"   VARCHAR(500),
        "sales_channel_id"      VARCHAR(255),
        "pharmacy_staff_id"     VARCHAR(255),
        "created_at"            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        "updated_at"            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT "clinic_slug_unique" UNIQUE ("slug"),
        PRIMARY KEY ("id")
      );
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_clinic_slug"
      ON "clinic" ("slug");
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_clinic_active"
      ON "clinic" ("is_active");
    `)

    this.addSql(`
      INSERT INTO "clinic" (
        "id", "name", "slug", "domains",
        "api_env", "api_base_url_test", "api_base_url_prod",
        "connect_env", "connect_url_test", "connect_url_prod",
        "redirect_url", "is_active",
        "api_client_id", "api_client_secret"
      )
      SELECT
        id,
        tenant_domain AS name,
        REPLACE(tenant_domain, '.', '-') AS slug,
        ARRAY[tenant_domain] AS domains,
        api_env,
        CASE WHEN api_env = 'test' THEN api_base_url ELSE 'https://api-dev.healthcoversonline.com/endpoint/v2' END AS api_base_url_test,
        CASE WHEN api_env = 'prod' THEN api_base_url ELSE 'https://api.healthcoversonline.com/endpoint/v2' END AS api_base_url_prod,
        connect_env,
        connect_url_test,
        connect_url_prod,
        redirect_url,
        is_active,
        client_id,
        client_secret
      FROM "provider_settings"
      ON CONFLICT DO NOTHING;
    `)

    this.addSql(`
      ALTER TABLE "clinic_staff"
      ADD COLUMN IF NOT EXISTS "clinic_id" VARCHAR(255);
    `)

    this.addSql(`
      ALTER TABLE "order_workflow"
      ADD COLUMN IF NOT EXISTS "clinic_id" VARCHAR(255);
    `)

    this.addSql(`
      ALTER TABLE "product_treatment_map"
      ADD COLUMN IF NOT EXISTS "clinic_id" VARCHAR(255);
    `)

    this.addSql(`
      UPDATE "clinic_staff" cs
      SET clinic_id = c.id
      FROM "clinic" c
      WHERE cs.tenant_domain = ANY(c.domains);
    `)

    this.addSql(`
      UPDATE "order_workflow" ow
      SET clinic_id = c.id
      FROM "clinic" c
      WHERE ow.tenant_domain = ANY(c.domains);
    `)

    this.addSql(`
      UPDATE "product_treatment_map" ptm
      SET clinic_id = c.id
      FROM "clinic" c
      WHERE ptm.tenant_domain = ANY(c.domains);
    `)
  }

  async down(): Promise<void> {
    this.addSql(`ALTER TABLE "product_treatment_map" DROP COLUMN IF EXISTS "clinic_id";`)
    this.addSql(`ALTER TABLE "order_workflow" DROP COLUMN IF EXISTS "clinic_id";`)
    this.addSql(`ALTER TABLE "clinic_staff" DROP COLUMN IF EXISTS "clinic_id";`)
    this.addSql(`DROP TABLE IF EXISTS "clinic";`)
  }
}

export default Migration20240101000003