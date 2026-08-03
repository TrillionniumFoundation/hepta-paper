import fs from 'node:fs';
import path from 'node:path';

import {
  buildAutonomousResearchOneShotCampaignAttemptEvent,
  buildAutonomousResearchOneShotCampaignAttemptReservation,
  buildAutonomousResearchOneShotCampaignAttemptTerminalReceipt,
  canonicalAutonomousResearchOneShotCampaignAttemptJson,
  verifyAutonomousResearchOneShotCampaignAttemptReservation,
} from '../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs';
import {
  createOfflineSqliteStore,
  createReadOnlySqliteStore,
} from '../persistence/sqlite-store.mjs';
import { stableStringify } from '../../workflow-kernel/record-hash.mjs';
import {
  CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_CONTRACT_HASH,
  CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_CONTRACT_ID,
  CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_STATEMENTS,
  CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_VERSION,
} from './campaign-one-shot-attempt-journal-schema.mjs';
import {
  assertJournalPragmas,
  assertRecoverablePrivateSqliteSidecars,
  assertSchema,
  databaseIdentity,
  directoryIdentity,
  ensureNoSqliteSidecars,
  lstatIfPresent,
  mustExecute,
  mustRun,
  pathContains,
  sameIdentity,
  schemaRows,
  sqliteSchemaHash,
  syncDirectory,
} from './campaign-one-shot-attempt-journal-support.mjs';
import {
  inspectCampaignOneShotAttemptFromPort as inspectionFromPort,
} from './campaign-one-shot-attempt-journal-inspection.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_DATABASE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.sqlite$/;
export { CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_CONTRACT_HASH };

function invalid(code, cause = undefined) {
  return new Error(code, cause === undefined ? undefined : { cause });
}

function sameJson(left, right) {
  return stableStringify(left) === stableStringify(right);
}

export function campaignOneShotAttemptJournalPath({ controlRoot } = {}) {
  if (!controlRoot) throw invalid('campaign_one_shot_attempt_control_root_required');
  return path.join(path.resolve(controlRoot), 'campaign-one-shot-attempt.sqlite');
}

export function createCampaignOneShotAttemptJournalRepository({
  controlRoot,
  runtimeRoot,
  journalPath = null,
  create = false,
  busyTimeoutMs = 10_000,
  clock = { now: () => new Date() },
  storeFactory = createOfflineSqliteStore,
  readOnlyStoreFactory = createReadOnlySqliteStore,
  faultInjection = Object.freeze({}),
} = {}) {
  if (!controlRoot || !runtimeRoot || typeof create !== 'boolean'
    || !Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000
    || typeof clock?.now !== 'function'
    || typeof storeFactory !== 'function' || typeof readOnlyStoreFactory !== 'function'
    || !faultInjection || typeof faultInjection !== 'object'
    || Array.isArray(faultInjection)
    || Object.keys(faultInjection).some((key) => !['beforeCommit', 'afterCommit'].includes(key))
    || (faultInjection.beforeCommit !== undefined
      && typeof faultInjection.beforeCommit !== 'function')
    || (faultInjection.afterCommit !== undefined
      && typeof faultInjection.afterCommit !== 'function')) {
    throw invalid('campaign_one_shot_attempt_journal_configuration_invalid');
  }
  const canonicalRuntimeRoot = path.resolve(runtimeRoot);
  const canonicalControlRoot = path.resolve(controlRoot);
  const databasePath = journalPath === null
    ? campaignOneShotAttemptJournalPath({ controlRoot: canonicalControlRoot })
    : path.resolve(journalPath);
  if (!SAFE_DATABASE_NAME.test(path.basename(databasePath))
    || path.dirname(databasePath) !== canonicalControlRoot
    || pathContains(canonicalRuntimeRoot, canonicalControlRoot)
    || pathContains(canonicalControlRoot, canonicalRuntimeRoot)) {
    throw invalid('campaign_one_shot_attempt_journal_path_invalid');
  }
  const runtimeRootStat = lstatIfPresent(canonicalRuntimeRoot);
  if (!runtimeRootStat || !runtimeRootStat.isDirectory()
    || runtimeRootStat.isSymbolicLink()
    || fs.realpathSync(canonicalRuntimeRoot) !== canonicalRuntimeRoot) {
    throw invalid('campaign_one_shot_attempt_runtime_root_invalid');
  }
  const physicalRuntimeRoot = fs.realpathSync(canonicalRuntimeRoot);
  const controlRootStat = lstatIfPresent(canonicalControlRoot);
  if (controlRootStat) {
    if (!controlRootStat.isDirectory() || controlRootStat.isSymbolicLink()) {
      throw invalid('campaign_one_shot_attempt_control_root_invalid');
    }
    const physicalControlRoot = fs.realpathSync(canonicalControlRoot);
    if (pathContains(physicalRuntimeRoot, physicalControlRoot)
      || pathContains(physicalControlRoot, physicalRuntimeRoot)) {
      throw invalid('campaign_one_shot_attempt_journal_path_invalid');
    }
  }
  let closed = false;
  let initialDirectoryIdentity = null;
  let initialDatabaseIdentity = null;
  const externalActionPermits = new WeakMap();

  function nowIso() {
    const value = clock.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw invalid('campaign_one_shot_attempt_journal_clock_invalid');
    }
    return value.toISOString();
  }

  function assertOpen() {
    if (closed) throw invalid('campaign_one_shot_attempt_journal_repository_closed');
  }

  function assertPhysicalRootSeparation() {
    const observedRuntimeRoot = lstatIfPresent(canonicalRuntimeRoot);
    const observedControlRoot = lstatIfPresent(canonicalControlRoot);
    if (!observedRuntimeRoot || !observedRuntimeRoot.isDirectory()
      || observedRuntimeRoot.isSymbolicLink()
      || fs.realpathSync(canonicalRuntimeRoot) !== canonicalRuntimeRoot) {
      throw invalid('campaign_one_shot_attempt_runtime_root_invalid');
    }
    if (!observedControlRoot) return;
    if (!observedControlRoot.isDirectory() || observedControlRoot.isSymbolicLink()) {
      throw invalid('campaign_one_shot_attempt_control_root_invalid');
    }
    const observedPhysicalRuntimeRoot = fs.realpathSync(canonicalRuntimeRoot);
    const observedPhysicalControlRoot = fs.realpathSync(canonicalControlRoot);
    if (pathContains(observedPhysicalRuntimeRoot, observedPhysicalControlRoot)
      || pathContains(observedPhysicalControlRoot, observedPhysicalRuntimeRoot)) {
      throw invalid('campaign_one_shot_attempt_journal_path_invalid');
    }
  }

  function assertPathIdentities({ allowPrivateSidecarRecovery = false } = {}) {
    assertPhysicalRootSeparation();
    const observedDirectory = directoryIdentity(canonicalControlRoot);
    const observedDatabase = databaseIdentity(databasePath);
    if ((initialDirectoryIdentity && !sameIdentity(initialDirectoryIdentity, observedDirectory))
      || (initialDatabaseIdentity && !sameIdentity(initialDatabaseIdentity, observedDatabase))) {
      throw invalid('campaign_one_shot_attempt_journal_path_identity_changed');
    }
    initialDirectoryIdentity ||= observedDirectory;
    initialDatabaseIdentity ||= observedDatabase;
    if (allowPrivateSidecarRecovery) assertRecoverablePrivateSqliteSidecars(databasePath);
    else ensureNoSqliteSidecars(databasePath);
  }

  function createDatabaseFile() {
    fs.mkdirSync(canonicalControlRoot, { recursive: true, mode: 0o700 });
    assertPhysicalRootSeparation();
    const controlIdentity = directoryIdentity(canonicalControlRoot);
    let created = false;
    try {
      const descriptor = fs.openSync(
        databasePath,
        fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
          | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      syncDirectory(canonicalControlRoot);
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    initialDirectoryIdentity ||= controlIdentity;
    const identity = databaseIdentity(databasePath);
    initialDatabaseIdentity ||= identity;
    if (!sameIdentity(initialDirectoryIdentity, controlIdentity)
      || !sameIdentity(initialDatabaseIdentity, identity)) {
      throw invalid('campaign_one_shot_attempt_journal_path_identity_changed');
    }
    return created;
  }

  function openWritablePort({ requireSchema = false } = {}) {
    assertOpen();
    if (!create) throw invalid('campaign_one_shot_attempt_journal_read_only');
    assertPathIdentities({ allowPrivateSidecarRecovery: true });
    const port = storeFactory({ dbPath: databasePath, busyTimeoutMs });
    try {
      mustExecute(port, 'PRAGMA journal_mode=DELETE;',
        'campaign_one_shot_attempt_journal_mode_configuration_failed');
      mustExecute(port, `PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        PRAGMA recursive_triggers=ON;`,
        'campaign_one_shot_attempt_journal_pragma_configuration_failed');
      assertJournalPragmas(port, { writable: true });
      ensureNoSqliteSidecars(databasePath);
      assertPathIdentities();
      if (requireSchema) assertSchema(port);
      return port;
    } catch (error) {
      try { port.close(); } catch { /* retain configuration failure */ }
      throw error;
    }
  }

  function withReadOnlyPort(callback) {
    assertOpen();
    const controlStat = lstatIfPresent(canonicalControlRoot);
    const databaseStat = lstatIfPresent(databasePath);
    if (databaseStat === null) {
      if (controlStat !== null) directoryIdentity(canonicalControlRoot);
      return null;
    }
    assertPathIdentities();
    const port = readOnlyStoreFactory({ dbPath: databasePath, busyTimeoutMs });
    try {
      assertPathIdentities();
      assertJournalPragmas(port);
      assertSchema(port);
      const result = callback(port);
      assertPathIdentities();
      return result;
    } finally { port.close(); }
  }

  function provision() {
    if (!create) return;
    createDatabaseFile();
    const port = openWritablePort();
    try {
      const objects = schemaRows(port);
      if (objects.length === 0) {
        port.transaction((transaction) => {
          for (const statement of CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_STATEMENTS) {
            mustExecute(transaction, statement,
              'campaign_one_shot_attempt_journal_schema_creation_failed');
          }
          const observedSchemaHash = sqliteSchemaHash(transaction);
          mustRun(transaction, `INSERT INTO campaign_one_shot_attempt_journal_metadata(
            singleton,schema_version,schema_contract_id,schema_contract_hash,
            sqlite_schema_hash,created_at) VALUES(1,?,?,?,?,?);`, [
            CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_VERSION,
            CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_CONTRACT_ID,
            CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_CONTRACT_HASH,
            observedSchemaHash,
            nowIso(),
          ], 'campaign_one_shot_attempt_journal_metadata_creation_failed');
        });
      }
      assertSchema(port);
    } finally { port.close(); }
    assertPathIdentities();
  }

  function verifyAfterUncertainCommit(verify, cause, operation) {
    try {
      const verified = withReadOnlyPort(verify);
      if (verified) return Object.freeze({
        value: verified,
        commitStatus: 'verified_after_uncertain_commit',
      });
    } catch { /* absence of independently verified state remains unknown */ }
    throw invalid(`campaign_one_shot_attempt_journal_${operation}_commit_outcome_unknown`, cause);
  }

  function mutate(operation, callback, verify) {
    const port = openWritablePort({ requireSchema: true });
    let commitMayHaveBeenAttempted = false;
    let result;
    try {
      result = port.transaction((transaction) => {
        assertPathIdentities();
        // The schema, trigger set, hash chain storage and physical integrity
        // are verified after BEGIN IMMEDIATE has excluded every SQLite writer.
        // The outer open-time verification is intentionally not the authority.
        assertSchema(transaction);
        const value = callback(transaction);
        faultInjection.beforeCommit?.({ operation, value });
        commitMayHaveBeenAttempted = true;
        return value;
      });
    } catch (error) {
      try { port.close(); } catch { /* verification decides the durable outcome */ }
      if (!commitMayHaveBeenAttempted) throw error;
      return verifyAfterUncertainCommit(verify, error, operation);
    }
    port.close();
    assertPathIdentities();
    faultInjection.afterCommit?.({ operation, value: result });
    let independentlyVerified;
    try { independentlyVerified = withReadOnlyPort(verify); }
    catch (error) {
      throw invalid(
        `campaign_one_shot_attempt_journal_${operation}_post_commit_verification_failed`,
        error,
      );
    }
    if (!independentlyVerified) {
      throw invalid(
        `campaign_one_shot_attempt_journal_${operation}_post_commit_verification_failed`,
      );
    }
    return Object.freeze({
      value: independentlyVerified,
      commitStatus: 'commit_acknowledged_and_independently_verified',
    });
  }

  provision();

  function inspectAttempt({ attemptId = null, idempotencyKey = null } = {}) {
    return withReadOnlyPort((port) => inspectionFromPort(port, {
      attemptId,
      idempotencyKey,
    }));
  }

  function reserveAttempt({
    reservation = null,
    attemptId = null,
    idempotencyKey = null,
    campaignId = null,
    protectedCampaignId = null,
    executionBinding = null,
    reservedAt = null,
  } = {}) {
    assertOpen();
    let expectedReservation = reservation;
    if (expectedReservation !== null
      && !verifyAutonomousResearchOneShotCampaignAttemptReservation(expectedReservation)) {
      throw invalid('campaign_one_shot_attempt_journal_reservation_invalid');
    }
    let expectedInspection = null;
    return mutate('reserve', (transaction) => {
      const existing = inspectionFromPort(transaction, {
        attemptId: expectedReservation?.attemptId || attemptId,
        idempotencyKey: expectedReservation?.idempotencyKey || idempotencyKey,
      });
      if (existing) {
        const requested = expectedReservation || {
          attemptId,
          idempotencyKey,
          campaignId,
          protectedCampaignId,
          executionBinding,
        };
        if ((requested.attemptId && requested.attemptId !== existing.reservation.attemptId)
          || requested.idempotencyKey !== existing.reservation.idempotencyKey
          || requested.campaignId !== existing.reservation.campaignId
          || requested.protectedCampaignId !== existing.reservation.protectedCampaignId
          || !sameJson(requested.executionBinding, existing.reservation.executionBinding)
          || (reservedAt && reservedAt !== existing.reservation.reservedAt)
          || (expectedReservation && !sameJson(expectedReservation, existing.reservation))) {
          throw invalid('campaign_one_shot_attempt_journal_reservation_conflict');
        }
        expectedReservation = existing.reservation;
        expectedInspection = existing;
        return existing;
      }
      expectedReservation ||= buildAutonomousResearchOneShotCampaignAttemptReservation({
        attemptId,
        idempotencyKey,
        campaignId,
        protectedCampaignId,
        executionBinding,
        reservedAt: reservedAt || nowIso(),
      });
      const initialEvent = buildAutonomousResearchOneShotCampaignAttemptEvent({
        reservation: expectedReservation,
        phase: 'attempt_reserved',
        evidence: {
          reservationHash:
            expectedReservation.autonomousResearchOneShotCampaignAttemptReservationHash,
        },
        recordedAt: expectedReservation.reservedAt,
      });
      mustRun(transaction, `INSERT INTO campaign_one_shot_attempts(
        attempt_id,idempotency_key,campaign_id,protected_campaign_id,
        execution_binding_hash,reservation_hash,reservation_json,reserved_at)
        VALUES(?,?,?,?,?,?,?,?);`, [
        expectedReservation.attemptId,
        expectedReservation.idempotencyKey,
        expectedReservation.campaignId,
        expectedReservation.protectedCampaignId,
        expectedReservation.executionBindingHash,
        expectedReservation.autonomousResearchOneShotCampaignAttemptReservationHash,
        canonicalAutonomousResearchOneShotCampaignAttemptJson(expectedReservation),
        expectedReservation.reservedAt,
      ], 'campaign_one_shot_attempt_journal_reservation_insert_failed');
      mustRun(transaction, `INSERT INTO campaign_one_shot_attempt_events(
        event_id,attempt_id,sequence,phase,previous_event_hash,event_hash,
        event_json,recorded_at) VALUES(?,?,?,?,?,?,?,?);`, [
        initialEvent.eventId,
        initialEvent.attemptId,
        initialEvent.sequence,
        initialEvent.phase,
        initialEvent.previousEventHash,
        initialEvent.autonomousResearchOneShotCampaignAttemptEventHash,
        canonicalAutonomousResearchOneShotCampaignAttemptJson(initialEvent),
        initialEvent.recordedAt,
      ], 'campaign_one_shot_attempt_journal_initial_event_insert_failed');
      expectedInspection = inspectionFromPort(transaction, {
        attemptId: expectedReservation.attemptId,
      });
      return expectedInspection;
    }, (port) => {
      const observed = inspectionFromPort(port, {
        attemptId: expectedReservation?.attemptId || attemptId,
        idempotencyKey: expectedReservation?.idempotencyKey || idempotencyKey,
      });
      return observed && expectedReservation
        && sameJson(observed.reservation, expectedReservation) ? observed : null;
    }).value;
  }

  function appendEvent({
    attemptId,
    phase,
    evidence = null,
    eventId = null,
    recordedAt = null,
    expectedPreviousHash = null,
    expectedPreviousEventHash = null,
    expectedSequence,
    expectedPhase,
  } = {}) {
    const effectivePreviousHash = expectedPreviousEventHash || expectedPreviousHash;
    if (!attemptId || !Number.isSafeInteger(expectedSequence) || expectedSequence < 2
      || !SHA256.test(String(effectivePreviousHash || '')) || !expectedPhase
      || (expectedPreviousEventHash && expectedPreviousHash
        && expectedPreviousEventHash !== expectedPreviousHash)
      || ['attempt_reserved', 'terminal'].includes(phase)) {
      throw invalid('campaign_one_shot_attempt_journal_append_invalid');
    }
    let expectedEvent = null;
    let newlyAppended = false;
    const mutation = mutate('append', (transaction) => {
      const current = inspectionFromPort(transaction, { attemptId });
      if (!current) throw invalid('campaign_one_shot_attempt_journal_attempt_missing');
      if (current.terminalReceipt) {
        throw invalid('campaign_one_shot_attempt_journal_attempt_terminal');
      }
      const existing = current.events.find((candidate) => (
        candidate.sequence === expectedSequence || (eventId && candidate.eventId === eventId)
      ));
      if (existing) {
        const previous = current.events[expectedSequence - 2];
        if (existing.sequence !== expectedSequence || existing.phase !== phase
          || existing.eventId !== (eventId || existing.eventId)
          || !previous || previous.phase !== expectedPhase
          || previous.autonomousResearchOneShotCampaignAttemptEventHash
            !== effectivePreviousHash
          || !sameJson(existing.evidence, evidence)
          || (recordedAt && recordedAt !== existing.recordedAt)) {
          throw invalid('campaign_one_shot_attempt_journal_event_conflict');
        }
        expectedEvent = existing;
        return current;
      }
      const head = current.events.at(-1);
      if (head.sequence + 1 !== expectedSequence || head.phase !== expectedPhase
        || head.autonomousResearchOneShotCampaignAttemptEventHash
          !== effectivePreviousHash) {
        throw invalid('campaign_one_shot_attempt_journal_event_compare_and_append_failed');
      }
      expectedEvent = buildAutonomousResearchOneShotCampaignAttemptEvent({
        reservation: current.reservation,
        previousEvent: head,
        phase,
        evidence,
        eventId,
        recordedAt: recordedAt || nowIso(),
      });
      mustRun(transaction, `INSERT INTO campaign_one_shot_attempt_events(
        event_id,attempt_id,sequence,phase,previous_event_hash,event_hash,
        event_json,recorded_at) VALUES(?,?,?,?,?,?,?,?);`, [
        expectedEvent.eventId,
        expectedEvent.attemptId,
        expectedEvent.sequence,
        expectedEvent.phase,
        expectedEvent.previousEventHash,
        expectedEvent.autonomousResearchOneShotCampaignAttemptEventHash,
        canonicalAutonomousResearchOneShotCampaignAttemptJson(expectedEvent),
        expectedEvent.recordedAt,
      ], 'campaign_one_shot_attempt_journal_event_insert_failed');
      newlyAppended = true;
      return inspectionFromPort(transaction, { attemptId });
    }, (port) => {
      const observed = inspectionFromPort(port, { attemptId });
      const event = observed?.events.find((candidate) => (
        candidate.sequence === expectedSequence
      ));
      const exactEventObserved = observed && expectedEvent && event
        && sameJson(event, expectedEvent);
      const sensitiveMarkerStillCurrent = !['provider_started', 'launch_started'].includes(phase)
        || (observed?.headPhase === phase
          && observed.headEventHash
            === expectedEvent?.autonomousResearchOneShotCampaignAttemptEventHash
          && observed.terminalReceipt === null);
      return exactEventObserved && sensitiveMarkerStillCurrent ? observed : null;
    });
    const externalActionMarker = ['provider_started', 'launch_started'].includes(phase);
    const markerRemainsCurrent = mutation.value.headPhase === phase
      && mutation.value.headEventHash
        === expectedEvent?.autonomousResearchOneShotCampaignAttemptEventHash
      && mutation.value.terminalReceipt === null;
    const newlyCommittedCurrentMarker = newlyAppended && markerRemainsCurrent
      && mutation.commitStatus === 'commit_acknowledged_and_independently_verified';
    const transition = Object.freeze({
      ...mutation.value,
      mutationDisposition: Object.freeze({
        status: newlyCommittedCurrentMarker
          ? 'appended_by_this_call'
          : (newlyAppended ? 'appended_but_not_current_or_commit_uncertain'
            : 'exact_replay'),
        phase,
        eventId: expectedEvent?.eventId || null,
        eventHash: expectedEvent
          ?.autonomousResearchOneShotCampaignAttemptEventHash || null,
        commitAcknowledged:
          mutation.commitStatus === 'commit_acknowledged_and_independently_verified',
        markerRemainsCurrent,
        externalActionPermitAvailable: Boolean(externalActionMarker
          && newlyCommittedCurrentMarker),
      }),
    });
    if (externalActionMarker && newlyCommittedCurrentMarker) {
      externalActionPermits.set(transition, Object.freeze({
        attemptId,
        phase,
        eventHash: expectedEvent.autonomousResearchOneShotCampaignAttemptEventHash,
      }));
    }
    return transition;
  }

  function assertExternalActionSideEffectPermit({ transition } = {}) {
    assertOpen();
    const permit = externalActionPermits.get(transition);
    externalActionPermits.delete(transition);
    if (!permit || !['provider_started', 'launch_started'].includes(permit.phase)
      || transition?.mutationDisposition?.externalActionPermitAvailable !== true
      || transition.mutationDisposition.phase !== permit.phase
      || transition.mutationDisposition.eventHash !== permit.eventHash) {
      throw invalid('campaign_one_shot_attempt_external_action_permit_invalid');
    }
    const current = inspectAttempt({ attemptId: permit.attemptId });
    if (current?.headPhase !== permit.phase || current.headEventHash !== permit.eventHash
      || current.terminalReceipt !== null) {
      throw invalid('campaign_one_shot_attempt_external_action_permit_stale');
    }
    return true;
  }

  function finalizeAttempt({
    attemptId,
    terminalStatus,
    outcome = null,
    completedAt = null,
    eventId = null,
    expectedPreviousHash = null,
    expectedPreviousEventHash = null,
    expectedSequence,
    expectedPhase,
  } = {}) {
    const effectivePreviousHash = expectedPreviousEventHash || expectedPreviousHash;
    if (!attemptId || !Number.isSafeInteger(expectedSequence) || expectedSequence < 2
      || !SHA256.test(String(effectivePreviousHash || '')) || !expectedPhase
      || (expectedPreviousEventHash && expectedPreviousHash
        && expectedPreviousEventHash !== expectedPreviousHash)) {
      throw invalid('campaign_one_shot_attempt_journal_finalize_invalid');
    }
    let expectedReceipt = null;
    return mutate('finalize', (transaction) => {
      const current = inspectionFromPort(transaction, { attemptId });
      if (!current) throw invalid('campaign_one_shot_attempt_journal_attempt_missing');
      if (current.terminalReceipt) {
        const preterminal = current.events.at(-2);
        if (current.events.at(-1).sequence !== expectedSequence
          || preterminal?.phase !== expectedPhase
          || preterminal?.autonomousResearchOneShotCampaignAttemptEventHash
            !== effectivePreviousHash
          || current.terminalReceipt.terminalStatus !== terminalStatus
          || !sameJson(current.terminalReceipt.outcome, outcome)
          || (completedAt && current.terminalReceipt.completedAt !== completedAt)
          || (eventId && current.events.at(-1).eventId !== eventId)) {
          throw invalid('campaign_one_shot_attempt_journal_terminal_conflict');
        }
        expectedReceipt = current.terminalReceipt;
        return current;
      }
      const head = current.events.at(-1);
      if (head.sequence + 1 !== expectedSequence || head.phase !== expectedPhase
        || head.autonomousResearchOneShotCampaignAttemptEventHash
          !== effectivePreviousHash) {
        throw invalid('campaign_one_shot_attempt_journal_terminal_compare_and_append_failed');
      }
      expectedReceipt = buildAutonomousResearchOneShotCampaignAttemptTerminalReceipt({
        reservation: current.reservation,
        lastEvent: head,
        terminalStatus,
        outcome,
        completedAt: completedAt || nowIso(),
      });
      const terminalEvent = buildAutonomousResearchOneShotCampaignAttemptEvent({
        reservation: current.reservation,
        previousEvent: head,
        phase: 'terminal',
        evidence: {
          terminalReceiptHash:
            expectedReceipt.autonomousResearchOneShotCampaignAttemptTerminalReceiptHash,
        },
        eventId,
        recordedAt: expectedReceipt.completedAt,
      });
      mustRun(transaction, `INSERT INTO campaign_one_shot_attempt_events(
        event_id,attempt_id,sequence,phase,previous_event_hash,event_hash,
        event_json,recorded_at) VALUES(?,?,?,?,?,?,?,?);`, [
        terminalEvent.eventId,
        terminalEvent.attemptId,
        terminalEvent.sequence,
        terminalEvent.phase,
        terminalEvent.previousEventHash,
        terminalEvent.autonomousResearchOneShotCampaignAttemptEventHash,
        canonicalAutonomousResearchOneShotCampaignAttemptJson(terminalEvent),
        terminalEvent.recordedAt,
      ], 'campaign_one_shot_attempt_journal_terminal_event_insert_failed');
      mustRun(transaction, `INSERT INTO campaign_one_shot_attempt_terminal_receipts(
        attempt_id,receipt_hash,receipt_json,terminal_event_hash,completed_at)
        VALUES(?,?,?,?,?);`, [
        current.reservation.attemptId,
        expectedReceipt.autonomousResearchOneShotCampaignAttemptTerminalReceiptHash,
        canonicalAutonomousResearchOneShotCampaignAttemptJson(expectedReceipt),
        terminalEvent.autonomousResearchOneShotCampaignAttemptEventHash,
        expectedReceipt.completedAt,
      ], 'campaign_one_shot_attempt_journal_terminal_receipt_insert_failed');
      return inspectionFromPort(transaction, { attemptId });
    }, (port) => {
      const observed = inspectionFromPort(port, { attemptId });
      return observed?.terminalReceipt && expectedReceipt
        && sameJson(observed.terminalReceipt, expectedReceipt) ? observed : null;
    }).value;
  }

  return Object.freeze({
    version: 1,
    kind: 'CampaignOneShotAttemptJournalRepository',
    durable: true,
    appendOnly: true,
    readOnly: !create,
    controlRoot: canonicalControlRoot,
    databasePath,
    schemaContractId: CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_CONTRACT_ID,
    schemaContractHash: CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_CONTRACT_HASH,
    reserveAttempt,
    appendEvent,
    assertExternalActionSideEffectPermit,
    finalizeAttempt,
    inspectAttempt,
    close() { closed = true; },
  });
}
