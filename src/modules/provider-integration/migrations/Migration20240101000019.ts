import { Migration } from "@mikro-orm/migrations"

export class Migration20240101000019 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "product_treatment_map"
        ADD COLUMN IF NOT EXISTS "rxvortex_instructions" TEXT;
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "product_treatment_map"
        DROP COLUMN IF EXISTS "rxvortex_instructions";
    `)
  }
}

export default Migration20240101000019
