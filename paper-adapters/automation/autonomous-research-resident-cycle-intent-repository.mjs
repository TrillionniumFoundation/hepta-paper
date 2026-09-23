import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createAutonomousResearchSupervisorInstanceRepository,
} from './autonomous-research-supervisor-instance-repository.mjs';
import {
  publishAutonomousResearchStrictMachineIntakeReconciliation,
} from './autonomous-research-strict-machine-intake-reconciliation-repository.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const PURPOSES = new Set([
  'machine-intake',
  'production-campaign-qualification',
]);

function timestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed : null;
}

function assertBinding({ acceptancePlanHash, acceptanceStepIdempotencyKey, purpose }) {
  if (!SHA256.test(String(acceptancePlanHash || ''))
    || !SHA256.test(String(acceptanceStepIdempotencyKey || ''))
    || !PURPOSES.has(String(purpose || ''))) {
    throw new Error('autonomous_research_resident_cycle_intent_binding_invalid');
  }
}

function exchangeDirectory(runtimeRoot, kind, { create = false } = {}) {
  if (!['intents', 'receipts'].includes(kind)) {
    throw new Error('autonomous_research_resident_cycle_exchange_kind_invalid');
  }
  const root = path.join(
    path.resolve(String(runtimeRoot || '')),
    'strict-full-auto-acceptance',
    'resident-cycles',
  );
  const selected = path.join(root, kind);
  if (create) {
    fs.mkdirSync(selected, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
    fs.chmodSync(selected, 0o700);
  }
  if (!fs.existsSync(selected)) return selected;
  for (const candidate of [root, selected]) {
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || fs.realpathSync(candidate) !== candidate
      || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('autonomous_research_resident_cycle_exchange_root_unsafe');
    }
  }
  return selected;
}

function documentPath(runtimeRoot, kind, idempotencyKey) {
  return path.join(
    exchangeDirectory(runtimeRoot, kind),
    `${String(idempotencyKey).slice('sha256:'.length)}.json`,
  );
}

function readDocument(candidate) {
  let descriptor;
  try {
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | NO_FOLLOW);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2
      || before.size > 2 * 1024 * 1024 || (before.mode & 0o077) !== 0) return null;
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || bytes.length !== before.size) return null;
    const parsed = JSON.parse(bytes.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | NO_FOLLOW);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function publishNoClobber({ runtimeRoot, kind, idempotencyKey, document }) {
  const directory = exchangeDirectory(runtimeRoot, kind, { create: true });
  const target = path.join(
    directory,
    `${String(idempotencyKey).slice('sha256:'.length)}.json`,
  );
  const temporary = path.join(
    directory,
    `.publish-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(document)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temporary, target);
      fsyncDirectory(directory);
      return Object.freeze({ document, published: true });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return Object.freeze({ document: readDocument(target), published: false });
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
      fsyncDirectory(directory);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function buildIntent({
  acceptancePlanHash,
  acceptanceStepIdempotencyKey,
  purpose,
  requestedAt,
}) {
  assertBinding({ acceptancePlanHash, acceptanceStepIdempotencyKey, purpose });
  if (timestamp(requestedAt) === null) {
    throw new Error('autonomous_research_resident_cycle_intent_time_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchResidentCycleIntent',
    status: 'autonomous_research_resident_cycle_pending',
    acceptancePlanHash,
    acceptanceStepIdempotencyKey,
    purpose,
    requestedAt,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchResidentCycleIntentHash:
      hashRecord('AutonomousResearchResidentCycleIntent', payload),
  });
}

function validIntent(intent, expected = {}) {
  try {
    const {
      autonomousResearchResidentCycleIntentHash: claimedHash,
      ...payload
    } = intent || {};
    const rebuilt = buildIntent(payload);
    return rebuilt.autonomousResearchResidentCycleIntentHash === claimedHash
      && (!expected.acceptancePlanHash
        || rebuilt.acceptancePlanHash === expected.acceptancePlanHash)
      && (!expected.acceptanceStepIdempotencyKey
        || rebuilt.acceptanceStepIdempotencyKey
          === expected.acceptanceStepIdempotencyKey)
      && (!expected.purpose || rebuilt.purpose === expected.purpose);
  } catch {
    return false;
  }
}

function validCycleReceipt(cycleReceipt) {
  const {
    autonomousResearchSupervisorCycleReceiptHash: claimedHash,
    ...payload
  } = cycleReceipt || {};
  return cycleReceipt?.version === 1
    && cycleReceipt.kind === 'AutonomousResearchSupervisorCycleReceipt'
    && cycleReceipt.status === 'autonomous_research_supervisor_cycle_completed'
    && SHA256.test(String(claimedHash || ''))
    && timestamp(cycleReceipt.observedAt) !== null
    && hashRecord('AutonomousResearchSupervisorCycleReceipt', payload) === claimedHash;
}

function buildReceipt({
  intent,
  cycleReceipt,
  residentOwnerId,
  residentLeaseGeneration,
  observedAt,
}) {
  if (!validIntent(intent) || !validCycleReceipt(cycleReceipt)
    || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(String(residentOwnerId || ''))
    || !Number.isSafeInteger(residentLeaseGeneration)
    || residentLeaseGeneration < 1
    || typeof cycleReceipt.externalSubmissionPerformed !== 'boolean'
    || cycleReceipt.automaticBudgetExpansionPerformed !== false
    || timestamp(observedAt) === null
    || timestamp(observedAt) < timestamp(intent.requestedAt)) {
    throw new Error('autonomous_research_resident_cycle_receipt_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchResidentCycleReceipt',
    status: 'autonomous_research_resident_cycle_completed',
    ready: true,
    acceptancePlanHash: intent.acceptancePlanHash,
    acceptanceStepIdempotencyKey: intent.acceptanceStepIdempotencyKey,
    purpose: intent.purpose,
    intentHash: intent.autonomousResearchResidentCycleIntentHash,
    cycleReceiptHash: cycleReceipt.autonomousResearchSupervisorCycleReceiptHash,
    cycleStatus: cycleReceipt.status,
    residentOwnerId,
    residentLeaseGeneration,
    residentFullyAutonomousRequired: true,
    observedAt,
    externalSubmissionPerformed: cycleReceipt.externalSubmissionPerformed === true,
    automaticBudgetExpansionPerformed:
      cycleReceipt.automaticBudgetExpansionPerformed === true,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchResidentCycleReceiptHash:
      hashRecord('AutonomousResearchResidentCycleReceipt', payload),
  });
}

function validReceipt(receipt, expected = {}) {
  try {
    const {
      autonomousResearchResidentCycleReceiptHash: claimedHash,
      ...payload
    } = receipt || {};
    if (receipt?.version !== 1
      || receipt.kind !== 'AutonomousResearchResidentCycleReceipt'
      || receipt.status !== 'autonomous_research_resident_cycle_completed'
      || receipt.ready !== true
      || receipt.residentFullyAutonomousRequired !== true
      || !SHA256.test(String(receipt.intentHash || ''))
      || !SHA256.test(String(receipt.cycleReceiptHash || ''))
      || !Number.isSafeInteger(receipt.residentLeaseGeneration)
      || receipt.residentLeaseGeneration < 1
      || timestamp(receipt.observedAt) === null
      || receipt.cycleStatus !== 'autonomous_research_supervisor_cycle_completed'
      || typeof receipt.externalSubmissionPerformed !== 'boolean'
      || receipt.automaticBudgetExpansionPerformed !== false
      || hashRecord('AutonomousResearchResidentCycleReceipt', payload) !== claimedHash) {
      return false;
    }
    assertBinding(receipt);
    return (!expected.acceptancePlanHash
        || receipt.acceptancePlanHash === expected.acceptancePlanHash)
      && (!expected.acceptanceStepIdempotencyKey
        || receipt.acceptanceStepIdempotencyKey
          === expected.acceptanceStepIdempotencyKey)
      && (!expected.purpose || receipt.purpose === expected.purpose);
  } catch {
    return false;
  }
}

export function publishAutonomousResearchResidentCycleIntent({
  runtimeRoot,
  acceptancePlanHash,
  acceptanceStepIdempotencyKey,
  purpose = 'production-campaign-qualification',
  now = new Date(),
} = {}) {
  const requestedAt = new Date(now).toISOString();
  const candidate = buildIntent({
    acceptancePlanHash,
    acceptanceStepIdempotencyKey,
    purpose,
    requestedAt,
  });
  const publication = publishNoClobber({
    runtimeRoot,
    kind: 'intents',
    idempotencyKey: acceptanceStepIdempotencyKey,
    document: candidate,
  });
  if (!validIntent(publication.document, {
    acceptancePlanHash,
    acceptanceStepIdempotencyKey,
    purpose,
  })) {
    throw new Error('autonomous_research_resident_cycle_intent_no_clobber_conflict');
  }
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchResidentCycleIntentPublication',
    status: 'autonomous_research_resident_cycle_intent_published',
    ready: true,
    intent: Object.freeze(publication.document),
    published: publication.published,
  });
}

export function listPendingAutonomousResearchResidentCycleIntents({
  runtimeRoot,
  limit = 100,
} = {}) {
  const directory = exchangeDirectory(runtimeRoot, 'intents');
  if (!fs.existsSync(directory)) return Object.freeze([]);
  const names = fs.readdirSync(directory)
    .filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
  if (names.length > 10_000) {
    throw new Error('autonomous_research_resident_cycle_intent_inventory_exceeded');
  }
  const bounded = Math.max(1, Math.min(1000, Number(limit) || 100));
  const pending = [];
  for (const name of names.sort()) {
    const intent = readDocument(path.join(directory, name));
    if (!validIntent(intent)
      || name !== `${
        intent.acceptanceStepIdempotencyKey.slice('sha256:'.length)
      }.json`) continue;
    let receipt = null;
    const receiptDirectory = exchangeDirectory(runtimeRoot, 'receipts');
    if (fs.existsSync(receiptDirectory)) {
      receipt = readDocument(path.join(receiptDirectory, name));
    }
    if (!validReceipt(receipt, intent)) pending.push(Object.freeze(intent));
    if (pending.length >= bounded) break;
  }
  return Object.freeze(pending);
}

export function completeAutonomousResearchResidentCycleIntent({
  runtimeRoot,
  intent,
  cycleReceipt,
  residentLeaseContext,
  now = new Date(),
} = {}) {
  if (!validIntent(intent) || !validCycleReceipt(cycleReceipt)
    || residentLeaseContext?.kind !== 'AutonomousResearchResidentLeaseContext'
    || !residentLeaseContext.lease) {
    throw new Error('autonomous_research_resident_cycle_completion_invalid');
  }
  const persistedIntent = readDocument(documentPath(
    runtimeRoot,
    'intents',
    intent.acceptanceStepIdempotencyKey,
  ));
  if (!validIntent(persistedIntent, intent)
    || persistedIntent.autonomousResearchResidentCycleIntentHash
      !== intent.autonomousResearchResidentCycleIntentHash) {
    throw new Error('autonomous_research_resident_cycle_completion_intent_missing');
  }
  const observedAt = new Date(now).toISOString();
  const instanceRepository = createAutonomousResearchSupervisorInstanceRepository({
    runtimeRoot,
    create: false,
  });
  let current;
  try {
    current = instanceRepository.assertInstanceLease({
      lease: residentLeaseContext.lease,
      now: new Date(observedAt),
    });
  } finally {
    instanceRepository.close();
  }
  if (current?.ownerId !== residentLeaseContext.ownerId
    || current?.leaseGeneration !== residentLeaseContext.leaseGeneration
    || current?.fullyAutonomousRequired !== true
    || current?.lastCycleReceiptHash
      !== cycleReceipt.autonomousResearchSupervisorCycleReceiptHash) {
    throw new Error('autonomous_research_resident_cycle_completion_fence_invalid');
  }
  const candidate = buildReceipt({
    intent: persistedIntent,
    cycleReceipt,
    residentOwnerId: current.ownerId,
    residentLeaseGeneration: current.leaseGeneration,
    observedAt: cycleReceipt.observedAt,
  });
  if (persistedIntent.purpose === 'machine-intake') {
    publishAutonomousResearchStrictMachineIntakeReconciliation({
      runtimeRoot,
      acceptancePlanHash: persistedIntent.acceptancePlanHash,
      acceptanceStepIdempotencyKey:
        persistedIntent.acceptanceStepIdempotencyKey,
      cycleReceipt,
    });
  }
  const publication = publishNoClobber({
    runtimeRoot,
    kind: 'receipts',
    idempotencyKey: intent.acceptanceStepIdempotencyKey,
    document: candidate,
  });
  if (!validReceipt(publication.document, persistedIntent)) {
    throw new Error('autonomous_research_resident_cycle_receipt_no_clobber_conflict');
  }
  return Object.freeze(publication.document);
}

export function inspectAutonomousResearchResidentCycleReceipt({
  runtimeRoot,
  acceptancePlanHash,
  acceptanceStepIdempotencyKey,
  purpose = 'production-campaign-qualification',
  now = new Date(),
} = {}) {
  assertBinding({ acceptancePlanHash, acceptanceStepIdempotencyKey, purpose });
  const inspectedAt = new Date(now);
  if (!Number.isFinite(inspectedAt.getTime())) {
    throw new Error('autonomous_research_resident_cycle_inspection_time_invalid');
  }
  const candidate = documentPath(runtimeRoot, 'receipts', acceptanceStepIdempotencyKey);
  const receipt = readDocument(candidate);
  const ready = validReceipt(receipt, {
    acceptancePlanHash,
    acceptanceStepIdempotencyKey,
    purpose,
  });
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchResidentCycleStatus',
    status: ready
      ? 'autonomous_research_resident_cycle_completed'
      : 'autonomous_research_resident_cycle_pending',
    ready,
    receipt: ready ? Object.freeze(receipt) : null,
    inspectedAt: inspectedAt.toISOString(),
    statusReadOnly: true,
    blockers: Object.freeze(ready
      ? [] : ['autonomous_research_resident_cycle_receipt_missing_or_invalid']),
  });
}

export function createAutonomousResearchResidentCycleIntentRepository({
  runtimeRoot,
} = {}) {
  if (!runtimeRoot) {
    throw new Error('autonomous_research_resident_cycle_runtime_root_required');
  }
  const selectedRuntimeRoot = path.resolve(runtimeRoot);
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchResidentCycleIntentRepository',
    publishIntent: (input = {}) => publishAutonomousResearchResidentCycleIntent({
      ...input,
      runtimeRoot: selectedRuntimeRoot,
    }),
    listPending: (input = {}) => listPendingAutonomousResearchResidentCycleIntents({
      ...input,
      runtimeRoot: selectedRuntimeRoot,
    }),
    complete: (input = {}) => completeAutonomousResearchResidentCycleIntent({
      ...input,
      runtimeRoot: selectedRuntimeRoot,
    }),
    inspect: (input = {}) => inspectAutonomousResearchResidentCycleReceipt({
      ...input,
      runtimeRoot: selectedRuntimeRoot,
    }),
  });
}
