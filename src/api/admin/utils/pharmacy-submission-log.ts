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
