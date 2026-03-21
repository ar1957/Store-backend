import { Migration } from "@mikro-orm/migrations"

export class Migration20240101000007 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "clinic"
        ADD COLUMN IF NOT EXISTS "from_email" VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "from_name"  VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "reply_to"   VARCHAR(255);
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "clinic"
        DROP COLUMN IF EXISTS "from_email",
        DROP COLUMN IF EXISTS "from_name",
        DROP COLUMN IF EXISTS "reply_to";
    `)
  }
}

export default Migration20240101000007