/**
 * Migration: Add dosage column to order_workflow
 * File: src/modules/provider-integration/migrations/Migration20240101000004.ts
 */

import { Migration } from "@mikro-orm/migrations"

export class Migration20240101000004 extends Migration {
  async up(): Promise<void> {
    // Add dosage as JSONB array to store per-treatment dosage info
    // e.g. [{ treatmentId: 281, treatmentName: "Semaglutide", dosage: "0.25mg" }]
    this.addSql(`
      ALTER TABLE "order_workflow"
      ADD COLUMN IF NOT EXISTS "treatment_dosages" JSONB DEFAULT '[]';
    `)
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "order_workflow"
      DROP COLUMN IF EXISTS "treatment_dosages";
    `)
  }
}