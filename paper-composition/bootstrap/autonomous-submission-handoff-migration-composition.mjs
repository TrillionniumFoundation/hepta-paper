import fs from 'node:fs';

import {
  activateAutonomousSubmissionHandoffCutover,
  autonomousSubmissionHandoffDatabasePath,
  openAutonomousSubmissionHandoffStore,
  provisionAutonomousSubmissionHandoffStore,
} from '../../paper-adapters/persistence/autonomous-submission-handoff-store.mjs';

export const AUTONOMOUS_SUBMISSION_HANDOFF_CUTOVER_ID =
  'autonomous-submission-handoff-cutover-v1';

function nativeMigrationReady(nativeStore) {
  const row = nativeStore.query(`SELECT version,name FROM schema_migrations
    WHERE version=25 LIMIT 1;`).rows[0] || null;
  if (Number(row?.version) !== 25
    || row?.name !== '025_external_autonomous_submission_handoff') {
    throw new Error('autonomous_submission_handoff_native_migration_25_required');
  }
}

function nativeAutonomousCounts(nativeStore) {
  const row = nativeStore.query(`SELECT
    sum(CASE WHEN delivery_kind='autonomous' THEN 1 ELSE 0 END) AS autonomous_count,
    sum(CASE WHEN delivery_kind='quarantined_legacy' THEN 1 ELSE 0 END) AS quarantine_count,
    sum(CASE WHEN delivery_kind='autonomous'
      AND status NOT IN ('responded','dead_letter') THEN 1 ELSE 0 END) AS active_count
    FROM submission_outbox;`).rows[0] || {};
  return Object.freeze({
    autonomousCount: Number(row.autonomous_count || 0),
    quarantineCount: Number(row.quarantine_count || 0),
    activeCount: Number(row.active_count || 0),
  });
}

export function convergeAutonomousSubmissionHandoff({
  nativeStore,
  runtimeRoot,
  cutoverId = AUTONOMOUS_SUBMISSION_HANDOFF_CUTOVER_ID,
  now = new Date(),
} = {}) {
  if (!nativeStore?.query || !nativeStore?.execute || !runtimeRoot) {
    throw new Error('autonomous_submission_handoff_migration_input_invalid');
  }
  nativeMigrationReady(nativeStore);
  const counts = nativeAutonomousCounts(nativeStore);
  if (counts.activeCount !== 0) {
    throw new Error('autonomous_submission_handoff_cutover_drain_required');
  }
  const databasePath = autonomousSubmissionHandoffDatabasePath({ runtimeRoot });
  const provisioned = !fs.existsSync(databasePath);
  if (provisioned) provisionAutonomousSubmissionHandoffStore({ runtimeRoot, now });
  const handoffStore = openAutonomousSubmissionHandoffStore({ runtimeRoot });
  try {
    const receipt = activateAutonomousSubmissionHandoffCutover({
      nativeStore,
      handoffStore,
      cutoverId,
      now,
    });
    const native = nativeStore.query(`SELECT *
      FROM autonomous_submission_handoff_cutover WHERE singleton=1 LIMIT 1;`).rows[0];
    const handoff = handoffStore.query(`SELECT *
      FROM handoff_cutover WHERE singleton=1 LIMIT 1;`).rows[0];
    const quickCheck = handoffStore.query('PRAGMA quick_check;').rows[0]?.quick_check;
    if (native?.cutover_id !== cutoverId
      || handoff?.cutover_id !== cutoverId
      || native?.handoff_database_identity_hash !== receipt.handoffDatabaseIdentityHash
      || handoff?.native_cutover_identity_hash !== receipt.handoffDatabaseIdentityHash
      || handoff?.status !== 'active'
      || quickCheck !== 'ok') {
      throw new Error('autonomous_submission_handoff_cutover_verification_failed');
    }
    const checkpoint = handoffStore.checkpoint({ mode: 'TRUNCATE' });
    const journal = handoffStore.execute(
      'PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;',
    );
    if (checkpoint.ok !== true || journal.ok !== true) {
      throw new Error(
        checkpoint.error || journal.error || 'autonomous_submission_handoff_journal_failed',
      );
    }
    return Object.freeze({
      ...receipt,
      ready: true,
      databasePath,
      databaseProvisioned: provisioned,
      quickCheck,
      nativeAutonomousRowCount: counts.autonomousCount,
      nativeQuarantinedRowCount: counts.quarantineCount,
    });
  } finally {
    handoffStore.close();
  }
}

export function inspectAutonomousSubmissionHandoff({
  nativeStore,
  runtimeRoot,
  cutoverId = AUTONOMOUS_SUBMISSION_HANDOFF_CUTOVER_ID,
} = {}) {
  const databasePath = autonomousSubmissionHandoffDatabasePath({ runtimeRoot });
  if (!fs.existsSync(databasePath)) {
    return Object.freeze({ ready: false, databasePath, blockers: Object.freeze([
      'autonomous_submission_handoff_database_missing',
    ]) });
  }
  const handoffStore = openAutonomousSubmissionHandoffStore({ runtimeRoot, readOnly: true });
  try {
    const native = nativeStore.query(`SELECT *
      FROM autonomous_submission_handoff_cutover WHERE singleton=1 LIMIT 1;`).rows[0] || null;
    const handoff = handoffStore.query(`SELECT *
      FROM handoff_cutover WHERE singleton=1 LIMIT 1;`).rows[0] || null;
    const quickCheck = handoffStore.query('PRAGMA quick_check;').rows[0]?.quick_check || 'unknown';
    const ready = native?.cutover_id === cutoverId
      && handoff?.cutover_id === cutoverId
      && native?.handoff_database_identity_hash === handoff?.native_cutover_identity_hash
      && handoff?.status === 'active'
      && quickCheck === 'ok';
    return Object.freeze({
      ready,
      databasePath,
      quickCheck,
      cutoverId: handoff?.cutover_id || null,
      databaseIdentityHash: handoff?.native_cutover_identity_hash || null,
      blockers: Object.freeze(ready ? [] : ['autonomous_submission_handoff_cutover_not_active']),
    });
  } finally {
    handoffStore.close();
  }
}
