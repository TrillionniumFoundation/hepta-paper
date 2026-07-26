import path from 'node:path';

import {
  appendFormalDomainQualificationRecoveryEntry,
  readFormalDomainQualificationRecoverySequence,
} from './formal-domain-qualification-recovery-append-only-repository.mjs';
import {
  assertFormalDomainQualificationRecoveryJournalSequence,
  buildFormalDomainQualificationRecoveryJournalEntry,
  FORMAL_DOMAIN_QUALIFICATION_RECOVERY_SHA256,
  isFormalDomainQualificationRecoveryEvent,
  isFormalDomainQualificationRecoveryStage,
  verifyFormalDomainQualificationRecoveryJournalEntry,
} from './formal-domain-qualification-recovery-journal-contract.mjs';
import {
  ensureFormalDomainQualificationJournalDirectory,
} from './formal-domain-qualification-recovery-filesystem-repository.mjs';
import {
  acquireFormalDomainQualificationRecoveryLock,
} from './formal-domain-qualification-recovery-lock-repository.mjs';

const MAXIMUM_JOURNAL_BYTES = 64 * 1024 * 1024;
const JOURNAL_INVALID =
  'formal_domain_qualification_recovery_journal_invalid';
const JOURNAL_DRIFTED =
  'formal_domain_qualification_recovery_journal_drifted';

function operationSegment(operationId) {
  if (!FORMAL_DOMAIN_QUALIFICATION_RECOVERY_SHA256.test(
    String(operationId || ''),
  )) {
    throw new Error('formal_domain_qualification_recovery_operation_invalid');
  }
  return operationId.slice('sha256:'.length);
}

function readJournal(journalPath, operationId) {
  return readFormalDomainQualificationRecoverySequence({
    containerPath: journalPath,
    identity: operationId,
    maximumBytes: MAXIMUM_JOURNAL_BYTES,
    invalidCode: JOURNAL_INVALID,
    driftCode: JOURNAL_DRIFTED,
    verifyEntry: (entry, context) => (
      verifyFormalDomainQualificationRecoveryJournalEntry(entry, {
        operationId: context.identity,
        previousEntryHash: context.previousEntryHash,
        sequence: context.sequence,
      })
    ),
    entryHash: (entry) => (
      entry.formalDomainQualificationRecoveryJournalEntryHash
    ),
    assertSequence: (entries) => (
      assertFormalDomainQualificationRecoveryJournalSequence(entries, {
        operationId,
      })
    ),
  });
}

function appendJournalEntry(journalPath, entry) {
  appendFormalDomainQualificationRecoveryEntry({
    containerPath: journalPath,
    entry,
    entryHash: (candidate) => (
      candidate.formalDomainQualificationRecoveryJournalEntryHash
    ),
    invalidCode: JOURNAL_INVALID,
  });
}

export function openFormalDomainQualificationRecoveryJournal({
  runtimeRoot,
  operationId,
  clock = { now: () => new Date() },
} = {}) {
  if (typeof clock?.now !== 'function') {
    throw new Error('formal_domain_qualification_recovery_clock_invalid');
  }
  const directory = ensureFormalDomainQualificationJournalDirectory(runtimeRoot);
  const segment = operationSegment(operationId);
  const journalPath = path.join(directory, `${segment}.journal`);
  const lock = acquireFormalDomainQualificationRecoveryLock(directory, segment);
  let entries;
  try { entries = [...readJournal(journalPath, operationId)]; }
  catch (error) {
    lock.release();
    throw error;
  }
  let closed = false;
  function assertOpen() {
    if (closed) {
      throw new Error('formal_domain_qualification_recovery_journal_closed');
    }
    lock.assertOwned();
  }
  function append({ stage, event, idempotencyKey, result = null }) {
    assertOpen();
    const now = clock.now();
    const recordedAt = (now instanceof Date ? now : new Date(now)).toISOString();
    if (!isFormalDomainQualificationRecoveryStage(stage)
      || !isFormalDomainQualificationRecoveryEvent(event)
      || !FORMAL_DOMAIN_QUALIFICATION_RECOVERY_SHA256.test(
        String(idempotencyKey || ''),
      )) {
      throw new Error(
        'formal_domain_qualification_recovery_journal_entry_invalid',
      );
    }
    const entry = buildFormalDomainQualificationRecoveryJournalEntry({
      version: 1,
      operationId,
      sequence: entries.length + 1,
      previousEntryHash: entries.at(-1)
        ?.formalDomainQualificationRecoveryJournalEntryHash || null,
      stage,
      event,
      idempotencyKey,
      result: result === null ? null : JSON.parse(JSON.stringify(result)),
      recordedAt,
    });
    verifyFormalDomainQualificationRecoveryJournalEntry(entry, {
      operationId,
      previousEntryHash: entry.previousEntryHash,
      sequence: entry.sequence,
    });
    assertFormalDomainQualificationRecoveryJournalSequence(
      [...entries, entry],
      { operationId },
    );
    appendJournalEntry(journalPath, entry);
    entries.push(entry);
    return entry;
  }
  return Object.freeze({
    version: 1,
    kind: 'FormalDomainQualificationRecoveryJournal',
    operationId,
    journalPath,
    entries() {
      assertOpen();
      return Object.freeze([...entries]);
    },
    latest(stage, event = null) {
      assertOpen();
      return [...entries].reverse().find((entry) => (
        entry.stage === stage && (event === null || entry.event === event)
      )) || null;
    },
    append,
    close() {
      if (closed) return;
      lock.release();
      closed = true;
    },
  });
}
