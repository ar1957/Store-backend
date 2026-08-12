/**
 * Persists the pharmacy submission payload + raw response on order_workflow
 * so a submission can be inspected in the DB rather than only in server
 * stdout logs. Provider-agnostic — used by RxVortex, RMM, and DigitalRX.
 * Best-effort: a logging failure must never break the actual submission.
 */
export async function savePharmacySubmissionLog(
  pg: any,
  workflowId: string,
  payload: any,
  response: any
): Promise<void> {
  try {
    await pg.raw(
      `UPDATE order_workflow
       SET pharmacy_submission_payload = ?::jsonb,
           pharmacy_submission_response = ?::jsonb,
           updated_at = NOW()
       WHERE id = ?`,
      [JSON.stringify(payload ?? null), JSON.stringify(response ?? null), workflowId]
    )
  } catch (err: any) {
    console.error(`[PharmacySubmissionLog] Failed to persist submission log for workflow ${workflowId}:`, err.message)
  }
}

/**
 * Upserts a pharmacy_sub_order row — one row per pharmacy order actually
 * placed (1 row for a normal/non-split submission, N rows for a split
 * product). Shared by RxVortex and RMM so both providers' admin sub-orders
 * list / submission viewer work identically. ON CONFLICT so a retry that
 * re-touches an already-recorded row (shouldn't normally happen, but safe
 * under races) updates rather than errors.
 */
export async function saveSubOrder(pg: any, row: {
  id: string
  workflowId: string
  splitIndex: number
  splitCount: number
  treatmentId: number | null
  productId: string | null
  dosage: string | null
  dosageKey: string | null
  catalogId: string | null
  queueId: string
  payload: any
  response: any
}) {
  await pg.raw(`
    INSERT INTO pharmacy_sub_order
      (id, order_workflow_id, split_index, split_count, treatment_id, product_id, dosage, dosage_key,
       rxvortex_preset_catalog_id, pharmacy_queue_id, pharmacy_status, pharmacy_submitted_at,
       pharmacy_submission_payload, pharmacy_submission_response, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', NOW(), ?::jsonb, ?::jsonb, NOW(), NOW())
    ON CONFLICT (order_workflow_id, split_index) DO UPDATE SET
      pharmacy_queue_id = EXCLUDED.pharmacy_queue_id,
      pharmacy_status = EXCLUDED.pharmacy_status,
      pharmacy_submitted_at = EXCLUDED.pharmacy_submitted_at,
      pharmacy_submission_payload = EXCLUDED.pharmacy_submission_payload,
      pharmacy_submission_response = EXCLUDED.pharmacy_submission_response,
      updated_at = NOW()
  `, [
    row.id, row.workflowId, row.splitIndex, row.splitCount, row.treatmentId, row.productId,
    row.dosage, row.dosageKey, row.catalogId, row.queueId,
    JSON.stringify(row.payload ?? null), JSON.stringify(row.response ?? null),
  ])
}

/** Fetches existing pharmacy_sub_order queue IDs for a workflow, keyed by
 * split_index, so a retry can skip prescriptions that already succeeded. */
export async function getExistingSubOrderQueueIds(pg: any, workflowId: string): Promise<Map<number, string>> {
  const result = await pg.raw(
    `SELECT split_index, pharmacy_queue_id FROM pharmacy_sub_order WHERE order_workflow_id = ?`,
    [workflowId]
  )
  const map = new Map<number, string>()
  for (const row of result.rows) {
    if (row.pharmacy_queue_id) map.set(Number(row.split_index), row.pharmacy_queue_id)
  }
  return map
}
