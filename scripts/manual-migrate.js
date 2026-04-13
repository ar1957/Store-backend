/**
 * manual-migrate.js
 * 
 * Run this script to apply all custom schema changes to a fresh database.
 * Safe to run multiple times — all statements use IF NOT EXISTS / IF EXISTS.
 * 
 * Usage (on AWS backend server):
 *   export DATABASE_URL=$(/opt/elasticbeanstalk/bin/get-config environment --key DATABASE_URL)
 *   cd /var/app/current/.medusa/server && node /var/app/current/scripts/manual-migrate.js
 * 
 * Usage (locally):
 *   node scripts/manual-migrate.js
 */

const { Pool } = require("pg")

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000,
})

const steps = [
  {
    name: "provider_settings table",
    sql: `CREATE TABLE IF NOT EXISTS "provider_settings" (
      "id" VARCHAR(255) NOT NULL,
      "tenant_domain" VARCHAR(255) NOT NULL,
      "client_id" VARCHAR(500),
      "client_secret" VARCHAR(500),
      "api_base_url" VARCHAR(500) NOT NULL DEFAULT 'https://api-dev.healthcoversonline.com/endpoint/v2',
      "api_env" VARCHAR(20) NOT NULL DEFAULT 'test',
      "connect_url_test" VARCHAR(500),
      "connect_url_prod" VARCHAR(500),
      "connect_env" VARCHAR(20) NOT NULL DEFAULT 'test',
      "redirect_url" VARCHAR(500),
      "is_active" BOOLEAN NOT NULL DEFAULT false,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT "provider_settings_tenant_domain_unique" UNIQUE ("tenant_domain"),
      PRIMARY KEY ("id")
    )`,
  },
  {
    name: "clinic_staff table",
    sql: `CREATE TABLE IF NOT EXISTS "clinic_staff" (
      "id" VARCHAR(255) NOT NULL,
      "tenant_domain" VARCHAR(255) NOT NULL,
      "user_id" VARCHAR(255) NOT NULL,
      "email" VARCHAR(255) NOT NULL,
      "full_name" VARCHAR(255),
      "role" VARCHAR(50) NOT NULL,
      "is_active" BOOLEAN NOT NULL DEFAULT true,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "clinic_id" VARCHAR(255),
      "deleted_at" TIMESTAMPTZ,
      PRIMARY KEY ("id"),
      UNIQUE ("tenant_domain", "user_id")
    )`,
  },
  {
    name: "order_workflow table",
    sql: `CREATE TABLE IF NOT EXISTS "order_workflow" (
      "id" VARCHAR(255) NOT NULL,
      "order_id" VARCHAR(255) NOT NULL,
      "tenant_domain" VARCHAR(255) NOT NULL,
      "patient_id" INTEGER,
      "gfe_id" INTEGER,
      "room_no" INTEGER,
      "virtual_room_url" TEXT,
      "status" VARCHAR(50) NOT NULL DEFAULT 'awaiting_provider_review',
      "provider_status" VARCHAR(50),
      "provider_name" VARCHAR(255),
      "provider_reviewed_at" TIMESTAMPTZ,
      "md_user_id" VARCHAR(255),
      "md_decision" VARCHAR(20),
      "md_notes" TEXT,
      "md_reviewed_at" TIMESTAMPTZ,
      "pharmacist_user_id" VARCHAR(255),
      "pharmacy_notes" TEXT,
      "tracking_number" VARCHAR(255),
      "carrier" VARCHAR(100),
      "shipped_at" TIMESTAMPTZ,
      "refund_id" VARCHAR(255),
      "refund_issued_at" TIMESTAMPTZ,
      "clinic_id" VARCHAR(255),
      "deleted_at" TIMESTAMPTZ,
      "pharmacy_staff_id" TEXT,
      "provider_decided_at" TIMESTAMPTZ,
      "md_decided_at" TIMESTAMPTZ,
      "refunded_at" TIMESTAMPTZ,
      "refund_reason" TEXT,
      "treatment_dosages" JSONB DEFAULT '[]',
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT "order_workflow_order_id_unique" UNIQUE ("order_id"),
      PRIMARY KEY ("id")
    )`,
  },
  {
    name: "order_workflow gfe_id unique constraint",
    sql: `DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'order_workflow_gfe_id_unique'
      ) THEN
        ALTER TABLE "order_workflow" ADD CONSTRAINT "order_workflow_gfe_id_unique" UNIQUE ("gfe_id");
      END IF;
    END $$`,
  },
  {
    name: "product_treatment_map table",
    sql: `CREATE TABLE IF NOT EXISTS "product_treatment_map" (
      "id" VARCHAR(255) NOT NULL,
      "tenant_domain" VARCHAR(255) NOT NULL,
      "product_id" VARCHAR(255) NOT NULL,
      "product_title" VARCHAR(255),
      "variant_id" VARCHAR(255),
      "treatment_id" INTEGER NOT NULL,
      "treatment_name" VARCHAR(255),
      "requires_eligibility" BOOLEAN NOT NULL DEFAULT true,
      "clinic_id" VARCHAR(255),
      "deleted_at" TIMESTAMPTZ,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY ("id"),
      UNIQUE ("tenant_domain", "product_id", "treatment_id")
    )`,
  },
  {
    name: "clinic table",
    sql: `CREATE TABLE IF NOT EXISTS "clinic" (
      "id" VARCHAR(255) NOT NULL,
      "name" VARCHAR(255) NOT NULL,
      "slug" VARCHAR(100) NOT NULL,
      "domains" TEXT[] NOT NULL DEFAULT '{}',
      "contact_email" VARCHAR(255),
      "is_active" BOOLEAN NOT NULL DEFAULT true,
      "logo_url" VARCHAR(500),
      "brand_color" VARCHAR(20) DEFAULT '#111111',
      "api_client_id" VARCHAR(500),
      "api_client_secret" VARCHAR(500),
      "api_env" VARCHAR(20) NOT NULL DEFAULT 'test',
      "api_base_url_test" VARCHAR(500) DEFAULT 'https://api-dev.healthcoversonline.com/endpoint/v2',
      "api_base_url_prod" VARCHAR(500) DEFAULT 'https://api.healthcoversonline.com/endpoint/v2',
      "connect_env" VARCHAR(20) NOT NULL DEFAULT 'test',
      "connect_url_test" VARCHAR(500) DEFAULT 'https://app.healthcoversonline.com/connect/patient',
      "connect_url_prod" VARCHAR(500) DEFAULT 'https://app.healthcoversonline.com/connect/patient',
      "redirect_url" VARCHAR(500),
      "publishable_api_key" VARCHAR(500),
      "sales_channel_id" VARCHAR(255),
      "pharmacy_staff_id" VARCHAR(255),
      "deleted_at" TIMESTAMPTZ,
      "stripe_secret_key" TEXT,
      "stripe_publishable_key" TEXT,
      "from_email" VARCHAR(255),
      "from_name" VARCHAR(255),
      "reply_to" VARCHAR(255),
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT "clinic_slug_unique" UNIQUE ("slug"),
      PRIMARY KEY ("id")
    )`,
  },
  {
    name: "clinic_ui_config table",
    sql: `CREATE TABLE IF NOT EXISTS "clinic_ui_config" (
      "id" VARCHAR(255) NOT NULL,
      "tenant_domain" VARCHAR(255) NOT NULL,
      "nav_links" JSONB DEFAULT '[]',
      "footer_links" JSONB DEFAULT '[]',
      "logo_url" VARCHAR(500),
      "get_started_url" VARCHAR(500),
      "clinic_id" VARCHAR(255),
      "bottom_links" JSONB DEFAULT '[]',
      "contact_phone" VARCHAR(100),
      "contact_email" VARCHAR(255),
      "contact_address" TEXT,
      "social_links" JSONB DEFAULT '[]',
      "certification_image_url" VARCHAR(500),
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY ("id")
    )`,
  },
  {
    name: "order_comment table",
    sql: `CREATE TABLE IF NOT EXISTS "order_comment" (
      "id" VARCHAR(255) NOT NULL,
      "order_workflow_id" VARCHAR(255) NOT NULL,
      "user_id" VARCHAR(255) NOT NULL,
      "user_email" VARCHAR(255) NOT NULL,
      "user_name" VARCHAR(255) NOT NULL,
      "role" VARCHAR(255) NOT NULL,
      "comment" TEXT NOT NULL,
      "created_at" TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY ("id"),
      CONSTRAINT "order_comment_order_workflow_id_fkey"
        FOREIGN KEY ("order_workflow_id")
        REFERENCES "order_workflow" ("id")
        ON DELETE CASCADE
    )`,
  },
  {
    name: "indexes",
    sql: `
      CREATE INDEX IF NOT EXISTS "idx_provider_settings_tenant" ON "provider_settings" ("tenant_domain");
      CREATE INDEX IF NOT EXISTS "idx_clinic_staff_tenant" ON "clinic_staff" ("tenant_domain");
      CREATE INDEX IF NOT EXISTS "idx_clinic_staff_user" ON "clinic_staff" ("user_id");
      CREATE INDEX IF NOT EXISTS "idx_order_workflow_order" ON "order_workflow" ("order_id");
      CREATE INDEX IF NOT EXISTS "idx_order_workflow_tenant" ON "order_workflow" ("tenant_domain");
      CREATE INDEX IF NOT EXISTS "idx_order_workflow_status" ON "order_workflow" ("status");
      CREATE INDEX IF NOT EXISTS "idx_product_treatment_tenant" ON "product_treatment_map" ("tenant_domain");
      CREATE INDEX IF NOT EXISTS "idx_product_treatment_product" ON "product_treatment_map" ("product_id");
      CREATE INDEX IF NOT EXISTS "idx_clinic_slug" ON "clinic" ("slug");
      CREATE INDEX IF NOT EXISTS "idx_clinic_active" ON "clinic" ("is_active");
      CREATE INDEX IF NOT EXISTS "idx_clinic_ui_config_tenant" ON "clinic_ui_config" ("tenant_domain");
      CREATE INDEX IF NOT EXISTS "idx_order_comment_workflow" ON "order_comment" ("order_workflow_id");
    `,
  },
  {
    name: "Migration8 - missing columns on clinic, order_workflow, clinic_staff",
    sql: `
      ALTER TABLE "clinic"
        ADD COLUMN IF NOT EXISTS "stripe_publishable_key" VARCHAR(500),
        ADD COLUMN IF NOT EXISTS "stripe_secret_key"      TEXT,
        ADD COLUMN IF NOT EXISTS "deleted_at"             TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "from_email"             VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "from_name"              VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "reply_to"               VARCHAR(255);
      ALTER TABLE "order_workflow"
        ADD COLUMN IF NOT EXISTS "deleted_at"          TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "pharmacy_staff_id"   TEXT,
        ADD COLUMN IF NOT EXISTS "provider_decided_at" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "md_decided_at"       TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "refunded_at"         TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "refund_reason"       TEXT,
        ADD COLUMN IF NOT EXISTS "treatment_dosages"   JSONB DEFAULT '[]';
      ALTER TABLE "clinic_staff"
        ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ;
      ALTER TABLE "clinic_ui_config"
        ADD COLUMN IF NOT EXISTS "clinic_id" VARCHAR(255);
      ALTER TABLE "product_treatment_map"
        ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ;
    `,
  },
  {
    name: "Migration9 - pharmacy fields on clinic + order_workflow",
    sql: `
      ALTER TABLE "clinic"
        ADD COLUMN IF NOT EXISTS "pharmacy_type"               VARCHAR(100),
        ADD COLUMN IF NOT EXISTS "pharmacy_api_url"            VARCHAR(500),
        ADD COLUMN IF NOT EXISTS "pharmacy_api_key"            VARCHAR(500),
        ADD COLUMN IF NOT EXISTS "pharmacy_store_id"           VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "pharmacy_vendor_name"        VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "pharmacy_doctor_first_name"  VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "pharmacy_doctor_last_name"   VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "pharmacy_doctor_npi"         VARCHAR(50),
        ADD COLUMN IF NOT EXISTS "pharmacy_enabled"            BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS "pharmacy_username"           VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "pharmacy_password"           VARCHAR(500),
        ADD COLUMN IF NOT EXISTS "pharmacy_prescriber_id"      VARCHAR(100),
        ADD COLUMN IF NOT EXISTS "pharmacy_prescriber_address" VARCHAR(500),
        ADD COLUMN IF NOT EXISTS "pharmacy_prescriber_city"    VARCHAR(150),
        ADD COLUMN IF NOT EXISTS "pharmacy_prescriber_state"   VARCHAR(50),
        ADD COLUMN IF NOT EXISTS "pharmacy_prescriber_zip"     VARCHAR(50),
        ADD COLUMN IF NOT EXISTS "pharmacy_prescriber_phone"   VARCHAR(100),
        ADD COLUMN IF NOT EXISTS "pharmacy_prescriber_dea"     VARCHAR(20),
        ADD COLUMN IF NOT EXISTS "pharmacy_ship_type"          VARCHAR(50),
        ADD COLUMN IF NOT EXISTS "pharmacy_ship_rate"          VARCHAR(50),
        ADD COLUMN IF NOT EXISTS "pharmacy_pay_type"           VARCHAR(50);
      ALTER TABLE "order_workflow"
        ADD COLUMN IF NOT EXISTS "pharmacy_queue_id"     TEXT,
        ADD COLUMN IF NOT EXISTS "pharmacy_submitted_at" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "pharmacy_status"       TEXT;
    `,
  },
  {
    name: "Migration10 - PayPal fields on clinic + clinic_promotion table",
    sql: `
      ALTER TABLE "clinic"
        ADD COLUMN IF NOT EXISTS "payment_provider"     VARCHAR(20)  DEFAULT 'stripe',
        ADD COLUMN IF NOT EXISTS "paypal_client_id"     VARCHAR(500),
        ADD COLUMN IF NOT EXISTS "paypal_client_secret" VARCHAR(500),
        ADD COLUMN IF NOT EXISTS "paypal_mode"          VARCHAR(20)  DEFAULT 'sandbox';
      CREATE TABLE IF NOT EXISTS "clinic_promotion" (
        "id"           VARCHAR(255) NOT NULL,
        "clinic_id"    VARCHAR(255) NOT NULL,
        "promotion_id" VARCHAR(255) NOT NULL,
        "created_at"   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        PRIMARY KEY ("id"),
        UNIQUE ("clinic_id", "promotion_id"),
        CONSTRAINT "clinic_promotion_clinic_fkey"
          FOREIGN KEY ("clinic_id") REFERENCES "clinic" ("id") ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "idx_clinic_promotion_clinic"     ON "clinic_promotion" ("clinic_id");
      CREATE INDEX IF NOT EXISTS "idx_clinic_promotion_promotion"  ON "clinic_promotion" ("promotion_id");
    `,
  },
  {
    name: "order_workflow gfe_id as text",
    sql: `ALTER TABLE "order_workflow" ALTER COLUMN "gfe_id" TYPE TEXT USING gfe_id::TEXT`,
  },
  {
    name: "record migrations as done",
    sql: `INSERT INTO mikro_orm_migrations (name) VALUES
      ('Migration20240101000001'),
      ('Migration20240101000002'),
      ('Migration20240101000003'),
      ('Migration20240101000004'),
      ('Migration20240101000005'),
      ('Migration20240101000006'),
      ('Migration20240101000007'),
      ('Migration20240101000008'),
      ('Migration20240101000009'),
      ('Migration20240101000010')
      ON CONFLICT DO NOTHING`,
  },
]

async function run() {
  console.log("Starting manual migration...")
  const client = await pool.connect()
  
  try {
    for (const step of steps) {
      try {
        await client.query(step.sql)
        console.log(`✓ ${step.name}`)
      } catch (e) {
        console.error(`✗ ${step.name}: ${e.message}`)
      }
    }
    console.log("\n✓ Manual migration complete")
  } finally {
    client.release()
    await pool.end()
  }
}

run().catch(e => {
  console.error("Fatal:", e.message)
  process.exit(1)
})
