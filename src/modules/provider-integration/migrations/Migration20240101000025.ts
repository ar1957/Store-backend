import { Migration } from "@mikro-orm/migrations"

/**
 * Migration 25: multi-pharmacy-per-clinic support + pharmacist pharmacy scoping.
 *
 * Introduces `clinic_pharmacy` — a clinic can now configure multiple pharmacies
 * (previously the pharmacy_* columns on `clinic` supported exactly one). Every
 * clinic that already had pharmacy_enabled=true gets one `clinic_pharmacy` row
 * backfilled from its existing columns, flagged is_default=true, so routing
 * behavior for every clinic is unchanged unless/until an admin adds a second
 * pharmacy and starts assigning products to it.
 *
 * `clinic_staff_pharmacy` scopes which pharmacy(ies) a pharmacist can see —
 * many-to-many, since one pharmacist can work across multiple pharmacies.
 * Existing pharmacist staff are backfilled onto their clinic's new default
 * pharmacy so nobody loses access on deploy day; the fail-closed default
 * (no assignment = no visibility) only actually applies once a clinic adds a
 * second pharmacy and an admin hasn't yet assigned a pharmacist to it.
 *
 * clinic_pharmacy_id is added to product_treatment_map (which pharmacy a
 * product routes to — NULL falls back to the clinic's default pharmacy),
 * pharmacy_sub_order (which pharmacy actually handled that sub-order), and
 * order_workflow (same, for the simple non-split case; NULL when an order
 * was split across multiple pharmacies, where pharmacy_sub_order is
 * authoritative per item).
 *
 * The legacy pharmacy_* columns on `clinic` are left in place untouched —
 * source of truth for this backfill, kept for rollback safety.
 */
export class Migration20240101000025 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "clinic_pharmacy" (
        "id"                            VARCHAR(255) NOT NULL,
        "clinic_id"                     VARCHAR(255) NOT NULL,
        "name"                          VARCHAR(255) NOT NULL,
        "pharmacy_type"                 VARCHAR(50),
        "is_enabled"                    BOOLEAN      NOT NULL DEFAULT true,
        "is_default"                    BOOLEAN      NOT NULL DEFAULT false,
        "pharmacy_api_url"              VARCHAR(500),
        "pharmacy_api_key"              VARCHAR(500),
        "pharmacy_store_id"             VARCHAR(255),
        "pharmacy_vendor_name"          VARCHAR(255),
        "pharmacy_doctor_first_name"    VARCHAR(255),
        "pharmacy_doctor_last_name"     VARCHAR(255),
        "pharmacy_doctor_npi"           VARCHAR(50),
        "pharmacy_username"             VARCHAR(255),
        "pharmacy_password"             VARCHAR(255),
        "pharmacy_prescriber_id"        VARCHAR(255),
        "pharmacy_prescriber_address"   VARCHAR(500),
        "pharmacy_prescriber_city"      VARCHAR(255),
        "pharmacy_prescriber_state"     VARCHAR(50),
        "pharmacy_prescriber_zip"       VARCHAR(50),
        "pharmacy_prescriber_phone"     VARCHAR(50),
        "pharmacy_prescriber_dea"       VARCHAR(50),
        "pharmacy_ship_type"            VARCHAR(50),
        "pharmacy_ship_rate"            VARCHAR(50),
        "pharmacy_pay_type"             VARCHAR(50),
        "pharmacy_client_id"            VARCHAR(255),
        "pharmacy_client_secret"        VARCHAR(500),
        "pharmacy_subdomain"            VARCHAR(255),
        "pharmacy_preset_catalog_id"    VARCHAR(255),
        "created_at"                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        "updated_at"                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        "deleted_at"                    TIMESTAMPTZ,
        PRIMARY KEY ("id")
      );
    `)
    this.addSql(`CREATE INDEX IF NOT EXISTS "idx_clinic_pharmacy_clinic" ON "clinic_pharmacy" ("clinic_id");`)

    this.addSql(`
      CREATE TABLE IF NOT EXISTS "clinic_staff_pharmacy" (
        "id"                  VARCHAR(255) NOT NULL,
        "clinic_staff_id"     VARCHAR(255) NOT NULL,
        "clinic_pharmacy_id"  VARCHAR(255) NOT NULL,
        "created_at"          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        PRIMARY KEY ("id"),
        UNIQUE ("clinic_staff_id", "clinic_pharmacy_id")
      );
    `)
    this.addSql(`CREATE INDEX IF NOT EXISTS "idx_clinic_staff_pharmacy_staff" ON "clinic_staff_pharmacy" ("clinic_staff_id");`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "idx_clinic_staff_pharmacy_pharmacy" ON "clinic_staff_pharmacy" ("clinic_pharmacy_id");`)

    this.addSql(`
      ALTER TABLE "product_treatment_map"
        ADD COLUMN IF NOT EXISTS "clinic_pharmacy_id" VARCHAR(255);
    `)
    this.addSql(`
      ALTER TABLE "pharmacy_sub_order"
        ADD COLUMN IF NOT EXISTS "clinic_pharmacy_id" VARCHAR(255);
    `)
    this.addSql(`
      ALTER TABLE "order_workflow"
        ADD COLUMN IF NOT EXISTS "clinic_pharmacy_id" VARCHAR(255);
    `)

    // Backfill: one default clinic_pharmacy row per already-configured clinic.
    this.addSql(`
      INSERT INTO "clinic_pharmacy" (
        "id", "clinic_id", "name", "pharmacy_type", "is_enabled", "is_default",
        "pharmacy_api_url", "pharmacy_api_key", "pharmacy_store_id", "pharmacy_vendor_name",
        "pharmacy_doctor_first_name", "pharmacy_doctor_last_name", "pharmacy_doctor_npi",
        "pharmacy_username", "pharmacy_password", "pharmacy_prescriber_id", "pharmacy_prescriber_address",
        "pharmacy_prescriber_city", "pharmacy_prescriber_state", "pharmacy_prescriber_zip",
        "pharmacy_prescriber_phone", "pharmacy_prescriber_dea", "pharmacy_ship_type", "pharmacy_ship_rate", "pharmacy_pay_type",
        "pharmacy_client_id", "pharmacy_client_secret", "pharmacy_subdomain", "pharmacy_preset_catalog_id",
        "created_at", "updated_at"
      )
      SELECT
        'cph_' || c."id", c."id", COALESCE(NULLIF(c."pharmacy_vendor_name", ''), c."pharmacy_type", 'Default Pharmacy'), c."pharmacy_type", true, true,
        c."pharmacy_api_url", c."pharmacy_api_key", c."pharmacy_store_id", c."pharmacy_vendor_name",
        c."pharmacy_doctor_first_name", c."pharmacy_doctor_last_name", c."pharmacy_doctor_npi",
        c."pharmacy_username", c."pharmacy_password", c."pharmacy_prescriber_id", c."pharmacy_prescriber_address",
        c."pharmacy_prescriber_city", c."pharmacy_prescriber_state", c."pharmacy_prescriber_zip",
        c."pharmacy_prescriber_phone", c."pharmacy_prescriber_dea", c."pharmacy_ship_type", c."pharmacy_ship_rate", c."pharmacy_pay_type",
        c."pharmacy_client_id", c."pharmacy_client_secret", c."pharmacy_subdomain", c."pharmacy_preset_catalog_id",
        NOW(), NOW()
      FROM "clinic" c
      WHERE c."pharmacy_enabled" = true
        AND c."pharmacy_type" IS NOT NULL
      ON CONFLICT ("id") DO NOTHING;
    `)

    // Backfill: link existing pharmacist staff to their clinic's new default
    // pharmacy so nobody loses access on deploy day. Only applies to
    // pharmacists with ZERO existing assignments — this script is re-run on
    // every deploy, and without that guard it would keep re-adding the
    // default pharmacy back onto anyone an admin has since deliberately
    // reassigned elsewhere, silently widening their visibility on every deploy.
    this.addSql(`
      INSERT INTO "clinic_staff_pharmacy" ("id", "clinic_staff_id", "clinic_pharmacy_id", "created_at")
      SELECT 'csp_' || cs."id", cs."id", cp."id", NOW()
      FROM "clinic_staff" cs
      JOIN "clinic" cl ON cs."tenant_domain" = ANY(cl."domains") AND cl."deleted_at" IS NULL
      JOIN "clinic_pharmacy" cp ON cp."clinic_id" = cl."id" AND cp."is_default" = true
      WHERE cs."role" = 'pharmacist' AND cs."is_active" = true
        AND NOT EXISTS (SELECT 1 FROM "clinic_staff_pharmacy" csp2 WHERE csp2."clinic_staff_id" = cs."id")
      ON CONFLICT ("id") DO NOTHING;
    `)

    // Backfill: tag EVERY historical order (not just already-submitted ones —
    // a manual/no-API pharmacy never "submits" at all, so gating on
    // pharmacy_queue_id would leave its orders permanently untagged) with the
    // pharmacy its actual line items resolve to via product_treatment_map,
    // falling back to the clinic's default pharmacy for unmapped products.
    // Left NULL when an order's products span more than one distinct
    // pharmacy — ambiguous at the order_workflow level, same convention used
    // for genuinely split/mixed orders at submission time.
    //
    // Neither order_workflow.clinic_id nor product_treatment_map.clinic_id
    // is ever actually populated in practice (this repo consistently
    // resolves clinic via tenant_domain matching against clinic.domains
    // instead), so this joins the same way rather than relying on those
    // columns — matching pharmacy-submit.ts's own resolution logic.
    this.addSql(`
      WITH order_products AS (
        SELECT DISTINCT ow.id AS workflow_id, cl.id AS clinic_id, oli.product_id
        FROM "order_workflow" ow
        JOIN "order" o ON o."id" = ow."order_id" AND o."deleted_at" IS NULL
        JOIN "order_item" oi ON oi."order_id" = o."id"
        JOIN "order_line_item" oli ON oli."id" = oi."item_id" AND oli."product_id" IS NOT NULL
        JOIN "clinic" cl ON (
          ow."tenant_domain" = ANY(cl."domains")
          OR ow."tenant_domain" = ANY(SELECT split_part(d, ':', 1) FROM unnest(cl."domains") AS d)
        ) AND cl."deleted_at" IS NULL
        WHERE ow."deleted_at" IS NULL
      ),
      resolved AS (
        SELECT
          op.workflow_id,
          COALESCE(
            (SELECT ptm."clinic_pharmacy_id" FROM "product_treatment_map" ptm
             WHERE ptm."product_id" = op.product_id AND ptm."deleted_at" IS NULL
               AND ptm."tenant_domain" IN (SELECT unnest("domains") FROM "clinic" WHERE "id" = op.clinic_id)
               AND ptm."clinic_pharmacy_id" IS NOT NULL
             LIMIT 1),
            (SELECT "id" FROM "clinic_pharmacy" WHERE "clinic_id" = op.clinic_id AND "is_default" = true AND "deleted_at" IS NULL LIMIT 1)
          ) AS resolved_pharmacy_id
        FROM order_products op
      ),
      per_workflow AS (
        SELECT workflow_id, COUNT(DISTINCT resolved_pharmacy_id) AS n, MAX(resolved_pharmacy_id) AS single_id
        FROM resolved
        WHERE resolved_pharmacy_id IS NOT NULL
        GROUP BY workflow_id
      )
      UPDATE "order_workflow" ow
      SET "clinic_pharmacy_id" = pw.single_id, "updated_at" = NOW()
      FROM per_workflow pw
      WHERE ow."id" = pw.workflow_id AND pw.n = 1;
    `)

    // pharmacy_sub_order rows tied to a specific product resolve the same way.
    this.addSql(`
      UPDATE "pharmacy_sub_order" pso
      SET "clinic_pharmacy_id" = r.resolved_pharmacy_id, "updated_at" = NOW()
      FROM (
        SELECT pso2."id" AS sub_order_id,
          COALESCE(
            (SELECT ptm."clinic_pharmacy_id" FROM "product_treatment_map" ptm
             WHERE ptm."product_id" = pso2."product_id" AND ptm."deleted_at" IS NULL
               AND ptm."tenant_domain" IN (SELECT unnest("domains") FROM "clinic" WHERE "id" = cl."id")
               AND ptm."clinic_pharmacy_id" IS NOT NULL
             LIMIT 1),
            (SELECT "id" FROM "clinic_pharmacy" WHERE "clinic_id" = cl."id" AND "is_default" = true AND "deleted_at" IS NULL LIMIT 1)
          ) AS resolved_pharmacy_id
        FROM "pharmacy_sub_order" pso2
        JOIN "order_workflow" ow2 ON ow2."id" = pso2."order_workflow_id"
        JOIN "clinic" cl ON (
          ow2."tenant_domain" = ANY(cl."domains")
          OR ow2."tenant_domain" = ANY(SELECT split_part(d, ':', 1) FROM unnest(cl."domains") AS d)
        ) AND cl."deleted_at" IS NULL
        WHERE pso2."clinic_pharmacy_id" IS NULL AND pso2."product_id" IS NOT NULL
      ) r
      WHERE pso."id" = r.sub_order_id AND r.resolved_pharmacy_id IS NOT NULL;
    `)

    // Remaining sub-orders with no product_id (legacy bundled submissions)
    // inherit whatever their order_workflow resolved to just above.
    this.addSql(`
      UPDATE "pharmacy_sub_order" pso
      SET "clinic_pharmacy_id" = ow."clinic_pharmacy_id", "updated_at" = NOW()
      FROM "order_workflow" ow
      WHERE pso."order_workflow_id" = ow."id"
        AND pso."clinic_pharmacy_id" IS NULL
        AND ow."clinic_pharmacy_id" IS NOT NULL;
    `)
  }

  async down(): Promise<void> {
    this.addSql(`ALTER TABLE "order_workflow" DROP COLUMN IF EXISTS "clinic_pharmacy_id";`)
    this.addSql(`ALTER TABLE "pharmacy_sub_order" DROP COLUMN IF EXISTS "clinic_pharmacy_id";`)
    this.addSql(`ALTER TABLE "product_treatment_map" DROP COLUMN IF EXISTS "clinic_pharmacy_id";`)
    this.addSql(`DROP TABLE IF EXISTS "clinic_staff_pharmacy";`)
    this.addSql(`DROP TABLE IF EXISTS "clinic_pharmacy";`)
  }
}

export default Migration20240101000025
