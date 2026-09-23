import fs from 'node:fs';
import path from 'node:path';

import {
  appendFormalDomainQualificationRecoveryEntry,
  readFormalDomainQualificationRecoverySequence,
} from './formal-domain-qualification-recovery-append-only-repository.mjs';
import {
  assertFormalDomainQualificationRecoveryGenerationSequence,
  buildFormalDomainQualificationRecoveryGenerationEntry,
  verifyFormalDomainQualificationRecoveryGenerationEntry,
} from './formal-domain-qualification-recovery-generation-contract.mjs';
import {
  ensureFormalDomainQualificationJournalDirectory,
  formalDomainQualificationPrivateDirectory,
  fsyncFormalDomainQualificationDirectory,
} from './formal-domain-qualification-recovery-filesystem-repository.mjs';
import {
  FORMAL_DOMAIN_QUALIFICATION_RECOVERY_SHA256,
  formalDomainQualificationRecoveryOperationId,
} from './formal-domain-qualification-recovery-journal-contract.mjs';
import {
  acquireFormalDomainQualificationRecoveryLock,
} from './formal-domain-qualification-recovery-lock-repository.mjs';

const MAXIMUM_LEDGER_BYTES = 16 * 1024 * 1024;
const GENERATION_INVALID =
  'formal_domain_qualification_recovery_generation_invalid';
const GENERATION_DRIFTED =
  'formal_domain_qualification_recovery_generation_drifted';

function ensureGenerationDirectory(runtimeRoot) {
  const journalRoot =
    ensureFormalDomainQualificationJournalDirectory(runtimeRoot);
  const directory = path.join(journalRoot, 'generations');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!formalDomainQualificationPrivateDirectory(directory)) {
    throw new Error(
      'formal_domain_qualification_recovery_generation_directory_invalid',
    );
  }
  fsyncFormalDomainQualificationDirectory(journalRoot);
  return directory;
}

function lineageSegment(lineageId) {
  if (!FORMAL_DOMAIN_QUALIFICATION_RECOVERY_SHA256.test(
    String(lineageId || ''),
  )) {
    throw new Error('formal_domain_qualification_recovery_lineage_invalid');
  }
  return lineageId.slice('sha256:'.length);
}

function readLedger(ledgerPath, lineageId) {
  return readFormalDomainQualificationRecoverySequence({
    containerPath: ledgerPath,
    identity: lineageId,
    maximumBytes: MAXIMUM_LEDGER_BYTES,
    invalidCode: GENERATION_INVALID,
    driftCode: GENERATION_DRIFTED,
    verifyEntry: (entry, context) => (
      verifyFormalDomainQualificationRecoveryGenerationEntry(entry, {
        lineageId: context.identity,
        previousEntryHash: context.previousEntryHash,
        sequence: context.sequence,
      })
    ),
    entryHash: (entry) => (
      entry.formalDomainQualificationRecoveryGenerationEntryHash
    ),
    assertSequence:
      assertFormalDomainQualificationRecoveryGenerationSequence,
  });
}

function appendEntry(ledgerPath, entry) {
  appendFormalDomainQualificationRecoveryEntry({
    containerPath: ledgerPath,
    entry,
    entryHash: (candidate) => (
      candidate.formalDomainQualificationRecoveryGenerationEntryHash
    ),
    invalidCode: GENERATION_INVALID,
  });
}

function canonicalInstant(clock) {
  const observed = clock.now();
  const date = observed instanceof Date ? observed : new Date(observed);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('formal_domain_qualification_recovery_clock_invalid');
  }
  return date.toISOString();
}

export function openFormalDomainQualificationRecoveryGenerationLedger({
  runtimeRoot,
  lineageId,
  clock = { now: () => new Date() },
} = {}) {
  if (typeof clock?.now !== 'function') {
    throw new Error('formal_domain_qualification_recovery_clock_invalid');
  }
  const directory = ensureGenerationDirectory(runtimeRoot);
  const segment = lineageSegment(lineageId);
  const ledgerPath = path.join(directory, `${segment}.generations`);
  const lock = acquireFormalDomainQualificationRecoveryLock(
    directory,
    `${segment}.generation`,
  );
  let entries;
  try { entries = [...readLedger(ledgerPath, lineageId)]; }
  catch (error) {
    lock.release();
    throw error;
  }
  let closed = false;
  function assertOpen() {
    if (closed) {
      throw new Error(
        'formal_domain_qualification_recovery_generation_closed',
      );
    }
    lock.assertOwned();
  }
  function append(payload) {
    const entry = buildFormalDomainQualificationRecoveryGenerationEntry({
      version: 1,
      kind: 'FormalDomainQualificationRecoveryGenerationEntry',
      lineageId,
      sequence: entries.length + 1,
      previousEntryHash: entries.at(-1)
        ?.formalDomainQualificationRecoveryGenerationEntryHash || null,
      recordedAt: canonicalInstant(clock),
      ...payload,
    });
    verifyFormalDomainQualificationRecoveryGenerationEntry(entry, {
      lineageId,
      previousEntryHash: entry.previousEntryHash,
      sequence: entry.sequence,
    });
    assertFormalDomainQualificationRecoveryGenerationSequence([
      ...entries,
      entry,
    ]);
    appendEntry(ledgerPath, entry);
    entries.push(entry);
    return entry;
  }
  return Object.freeze({
    version: 1,
    kind: 'FormalDomainQualificationRecoveryGenerationLedger',
    lineageId,
    ledgerPath,
    select({ supersededExternalEvidenceHash = null } = {}) {
      assertOpen();
      if (supersededExternalEvidenceHash !== null
        && !FORMAL_DOMAIN_QUALIFICATION_RECOVERY_SHA256.test(
          String(supersededExternalEvidenceHash || ''),
        )) {
        throw new Error(
          'formal_domain_qualification_recovery_superseded_evidence_invalid',
        );
      }
      const state =
        assertFormalDomainQualificationRecoveryGenerationSequence(entries);
      if (state.selected && !state.completed) {
        if (state.selected.supersededExternalEvidenceHash
          !== supersededExternalEvidenceHash) {
          throw new Error(
            'formal_domain_qualification_recovery_generation_conflict',
          );
        }
        return Object.freeze({
          generation: state.selected.generation,
          operationId: state.selected.operationId,
          completed: false,
          evidenceHash: null,
        });
      }
      const completedExpired = state.completed?.evidenceValidUntil
        ? Date.parse(state.completed.evidenceValidUntil)
          <= Date.parse(canonicalInstant(clock))
        : false;
      if (state.completed && !completedExpired
        && state.selected.supersededExternalEvidenceHash
          === supersededExternalEvidenceHash
        && state.completed.evidenceHash !== supersededExternalEvidenceHash) {
        return Object.freeze({
          generation: state.selected.generation,
          operationId: state.selected.operationId,
          completed: true,
          evidenceHash: state.completed.evidenceHash,
          evidenceValidUntil: state.completed.evidenceValidUntil,
        });
      }
      const generation = (state.selected?.generation || 0) + 1;
      const operationId =
        formalDomainQualificationRecoveryOperationId({
          lineageId,
          generation,
        });
      append({
        event: 'generation_selected',
        generation,
        operationId,
        supersedesOperationId: state.selected?.operationId || null,
        supersededExternalEvidenceHash,
        evidenceHash: null,
        evidenceValidUntil: null,
      });
      return Object.freeze({
        generation,
        operationId,
        completed: false,
        evidenceHash: null,
        evidenceValidUntil: null,
      });
    },
    complete({
      operationId,
      evidenceHash,
      evidenceValidUntil = null,
    } = {}) {
      assertOpen();
      const state =
        assertFormalDomainQualificationRecoveryGenerationSequence(entries);
      if (!state.selected || state.selected.operationId !== operationId
        || !FORMAL_DOMAIN_QUALIFICATION_RECOVERY_SHA256.test(
          String(evidenceHash || ''),
        )) {
        throw new Error(
          'formal_domain_qualification_recovery_generation_completion_invalid',
        );
      }
      if (state.completed) {
        if (state.completed.evidenceHash !== evidenceHash
          || state.completed.evidenceValidUntil !== evidenceValidUntil) {
          throw new Error(
            'formal_domain_qualification_recovery_generation_completion_invalid',
          );
        }
        return state.completed;
      }
      return append({
        event: 'generation_completed',
        generation: state.selected.generation,
        operationId,
        supersedesOperationId: state.selected.supersedesOperationId,
        supersededExternalEvidenceHash:
          state.selected.supersededExternalEvidenceHash,
        evidenceHash,
        evidenceValidUntil,
      });
    },
    entries() {
      assertOpen();
      return Object.freeze([...entries]);
    },
    close() {
      if (closed) return;
      lock.release();
      closed = true;
    },
  });
}
