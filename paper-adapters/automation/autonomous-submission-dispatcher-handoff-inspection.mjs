import {
  openAutonomousSubmissionHandoffStore,
} from '../persistence/autonomous-submission-handoff-store.mjs';

function safeCount(row, key) {
  const value = Number(row?.[key] || 0);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('autonomous_submission_dispatcher_queue_count_invalid');
  }
  return value;
}

export function inspectAutonomousSubmissionDispatcherHandoffState({ runtimeRoot } = {}) {
  const store = openAutonomousSubmissionHandoffStore({ runtimeRoot, readOnly: true });
  try {
    const row = store.query(`SELECT count(*) AS inspected_count,
      sum(CASE WHEN status='responded' THEN 1 ELSE 0 END) AS completed_count,
      sum(CASE WHEN status='dead_letter' THEN 1 ELSE 0 END) AS failure_count,
      sum(CASE WHEN status NOT IN ('responded','dead_letter') THEN 1 ELSE 0 END)
        AS pending_count
      FROM submission_outbox WHERE delivery_kind='autonomous';`).rows[0] || {};
    const cutover = store.query(`SELECT cutover_id,native_cutover_identity_hash,status
      FROM handoff_cutover WHERE singleton=1 LIMIT 1;`).rows[0] || null;
    const instance = store.query(`SELECT instance_nonce FROM handoff_instance
      WHERE singleton=1 LIMIT 1;`).rows[0] || null;
    const quickCheck = store.query('PRAGMA quick_check;').rows[0]?.quick_check || null;
    if (cutover?.status !== 'active' || quickCheck !== 'ok') {
      throw new Error('autonomous_submission_dispatcher_handoff_not_ready');
    }
    return Object.freeze({
      cutoverId: cutover.cutover_id,
      handoffInstanceNonce: instance?.instance_nonce || null,
      handoffDatabaseIdentityHash: cutover.native_cutover_identity_hash,
      inspectedHandoffCount: safeCount(row, 'inspected_count'),
      completedHandoffCount: safeCount(row, 'completed_count'),
      pendingHandoffCount: safeCount(row, 'pending_count'),
      explicitFailureCount: safeCount(row, 'failure_count'),
    });
  } finally { store.close(); }
}
