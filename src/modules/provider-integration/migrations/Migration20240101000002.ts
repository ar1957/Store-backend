import { Migration } from "@mikro-orm/migrations"

export class Migration20240101000002 extends Migration {
  async up(): Promise<void> {

    this.addSql(`
      CREATE TABLE IF NOT EXISTS "clinic_staff" (
        "id"              VARCHAR(255) NOT NULL,
        "tenant_domain"   VARCHAR(255) NOT NULL,
        "user_id"         VARCHAR(255) NOT NULL,
        "email"           VARCHAR(255) NOT NULL,
        "full_name"       VARCHAR(255),
        "role"            VARCHAR(50)  NOT NULL,
        "is_active"       BOOLEAN      NOT NULL DEFAULT true,
        "created_at"      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        "updated_at"      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        PRIMARY KEY ("id"),
        UNIQUE ("tenant_domain", "user_id")
      );
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_clinic_staff_tenant"
      ON "clinic_staff" ("tenant_domain");
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_clinic_staff_user"
      ON "clinic_staff" ("user_id");
    `)

    this.addSql(`
      CREATE TABLE IF NOT EXISTS "order_workflow" (
        "id"                  VARCHAR(255) NOT NULL,
        "order_id"            VARCHAR(255) NOT NULL,
        "tenant_domain"       VARCHAR(255) NOT NULL,
        "patient_id"          INTEGER,
        "gfe_id"              INTEGER,
        "room_no"             INTEGER,
        "virtual_room_url"    TEXT,
        "status"              VARCHAR(50)  NOT NULL DEFAULT 'awaiting_provider_review',
        "provider_status"     VARCHAR(50),
        "provider_name"       VARCHAR(255),
        "provider_reviewed_at" TIMESTAMPTZ,
        "md_user_id"          VARCHAR(255),
        "md_decision"         VARCHAR(20),
        "md_notes"            TEXT,
        "md_reviewed_at"      TIMESTAMPTZ,
        "pharmacist_user_id"  VARCHAR(255),
        "pharmacy_notes"      TEXT,
        "tracking_number"     VARCHAR(255),
        "carrier"             VARCHAR(100),
        "shipped_at"          TIMESTAMPTZ,
        "refund_id"           VARCHAR(255),
        "refund_issued_at"    TIMESTAMPTZ,
        "created_at"          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        "updated_at"          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT "order_workflow_order_id_unique" UNIQUE ("order_id"),
        PRIMARY KEY ("id")
      );
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_order_workflow_order"
      ON "order_workflow" ("order_id");
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_order_workflow_tenant"
      ON "order_workflow" ("tenant_domain");
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_order_workflow_status"
      ON "order_workflow" ("status");
    `)

    this.addSql(`
      CREATE TABLE IF NOT EXISTS "product_treatment_map" (
        "id"                  VARCHAR(255) NOT NULL,
        "tenant_domain"       VARCHAR(255) NOT NULL,
        "product_id"          VARCHAR(255) NOT NULL,
        "product_title"       VARCHAR(255),
        "variant_id"          VARCHAR(255),
        "treatment_id"        INTEGER      NOT NULL,
        "treatment_name"      VARCHAR(255),
        "requires_eligibility" BOOLEAN     NOT NULL DEFAULT true,
        "created_at"          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        "updated_at"          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        PRIMARY KEY ("id"),
        UNIQUE ("tenant_domain", "product_id", "treatment_id")
      );
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_product_treatment_tenant"
      ON "product_treatment_map" ("tenant_domain");
    `)

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_product_treatment_product"
      ON "product_treatment_map" ("product_id");
    `)
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "product_treatment_map";`)
    this.addSql(`DROP TABLE IF EXISTS "order_workflow";`)
    this.addSql(`DROP TABLE IF EXISTS "clinic_staff";`)
  }
}

export default Migration20240101000002