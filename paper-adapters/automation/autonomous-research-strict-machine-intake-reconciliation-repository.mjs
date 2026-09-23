import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const RECEIPT_KEYS = Object.freeze([
  'acceptancePlanHash', 'acceptanceStepIdempotencyKey',
  'autonomousResearchStrictMachineIntakeReconciliationReceiptHash',
  'automaticBudgetExpansionPerformed', 'cycleReceiptHash',
  'externalSubmissionPerformed', 'kind', 'machineIntakeConfigurationHash',
  'machineIntakeReconciliationReceipt', 'observedAt', 'ready', 'runtimeRoot',
  'status', 'topicProducerDatasetSnapshotHash', 'version',
]);

function receiptPath(runtimeRoot) {
  return path.join(
    path.resolve(String(runtimeRoot || '')),
    'strict-full-auto-acceptance',
    'machine-intake-reconciliation.json',
  );
}

function canonicalTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function atomicReceiptWrite(candidate, value) {
  const parent = path.dirname(candidate);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
    || fs.realpathSync(parent) !== parent || (parentStat.mode & 0o022) !== 0) {
    throw new Error('autonomous_research_strict_machine_intake_receipt_parent_invalid');
  }
  const temporary = path.join(
    parent,
    `.${path.basename(candidate)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  try {
    fs.renameSync(temporary, candidate);
    const parentDescriptor = fs.openSync(parent, fs.constants.O_RDONLY);
    try { fs.fsyncSync(parentDescriptor); } finally { fs.closeSync(parentDescriptor); }
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* published or absent */ }
  }
}

function reconciliationReceiptValid(receipt) {
  if (!receipt || receipt.version !== 1
    || receipt.kind !== 'AutonomousResearchSupervisorMachineIntakeReconciliationReceipt'
    || !SHA256.test(String(receipt.machineIntakeConfigurationHash || ''))
    || (receipt.topicProducerDatasetSnapshotHash !== null
      && !SHA256.test(String(receipt.topicProducerDatasetSnapshotHash || '')))
    || !SHA256.test(String(receipt.machineIntakeCycleResultHash || ''))
    || !canonicalTimestamp(receipt.reconciledAt)
    || receipt.externalSubmissionPerformed !== false
    || receipt.automaticBudgetExpansionPerformed !== false
    || !SHA256.test(String(
      receipt.autonomousResearchSupervisorMachineIntakeReconciliationReceiptHash || '',
    ))) return false;
  const {
    autonomousResearchSupervisorMachineIntakeReconciliationReceiptHash: claimedHash,
    ...payload
  } = receipt;
  return hashRecord('AutonomousResearchSupervisorMachineIntakeReconciliationReceipt', payload)
    === claimedHash;
}

function strictReceiptValid(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || Object.keys(receipt).sort().join('\0')
      !== [...RECEIPT_KEYS].sort().join('\0')
    || receipt.version !== 1
    || receipt.kind !== 'AutonomousResearchStrictMachineIntakeReconciliationReceipt'
    || receipt.status !== 'autonomous_research_strict_machine_intake_reconciled'
    || receipt.ready !== true
    || !path.isAbsolute(String(receipt.runtimeRoot || ''))
    || !SHA256.test(String(receipt.acceptancePlanHash || ''))
    || !SHA256.test(String(receipt.acceptanceStepIdempotencyKey || ''))
    || !SHA256.test(String(receipt.cycleReceiptHash || ''))
    || !reconciliationReceiptValid(receipt.machineIntakeReconciliationReceipt)
    || receipt.machineIntakeConfigurationHash
      !== receipt.machineIntakeReconciliationReceipt.machineIntakeConfigurationHash
    || receipt.topicProducerDatasetSnapshotHash
      !== receipt.machineIntakeReconciliationReceipt.topicProducerDatasetSnapshotHash
    || !canonicalTimestamp(receipt.observedAt)
    || receipt.externalSubmissionPerformed !== false
    || receipt.automaticBudgetExpansionPerformed !== false
    || !SHA256.test(String(
      receipt.autonomousResearchStrictMachineIntakeReconciliationReceiptHash || '',
    ))) return false;
  const {
    autonomousResearchStrictMachineIntakeReconciliationReceiptHash: claimedHash,
    ...payload
  } = receipt;
  return hashRecord('AutonomousResearchStrictMachineIntakeReconciliationReceipt', payload)
    === claimedHash;
}

export function publishAutonomousResearchStrictMachineIntakeReconciliation({
  runtimeRoot,
  acceptancePlanHash,
  acceptanceStepIdempotencyKey,
  cycleReceipt,
} = {}) {
  const selectedRuntimeRoot = path.resolve(String(runtimeRoot || ''));
  const reconciliation = cycleReceipt?.machineIntakeReconciliationReceipt || null;
  const {
    autonomousResearchSupervisorCycleReceiptHash: claimedCycleHash,
    ...cyclePayload
  } = cycleReceipt || {};
  if (!runtimeRoot || cycleReceipt?.kind !== 'AutonomousResearchSupervisorCycleReceipt'
    || cycleReceipt.status !== 'autonomous_research_supervisor_cycle_completed'
    || !SHA256.test(String(claimedCycleHash || ''))
    || hashRecord('AutonomousResearchSupervisorCycleReceipt', cyclePayload)
      !== claimedCycleHash
    || !SHA256.test(String(acceptancePlanHash || ''))
    || !SHA256.test(String(acceptanceStepIdempotencyKey || ''))
    || !reconciliationReceiptValid(reconciliation)) {
    throw new Error('autonomous_research_strict_machine_intake_reconciliation_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStrictMachineIntakeReconciliationReceipt',
    status: 'autonomous_research_strict_machine_intake_reconciled',
    ready: true,
    runtimeRoot: selectedRuntimeRoot,
    acceptancePlanHash,
    acceptanceStepIdempotencyKey,
    cycleReceiptHash: cycleReceipt.autonomousResearchSupervisorCycleReceiptHash,
    machineIntakeConfigurationHash: reconciliation.machineIntakeConfigurationHash,
    topicProducerDatasetSnapshotHash: reconciliation.topicProducerDatasetSnapshotHash,
    machineIntakeReconciliationReceipt: reconciliation,
    observedAt: reconciliation.reconciledAt,
    externalSubmissionPerformed: false,
    automaticBudgetExpansionPerformed: false,
  });
  const receipt = Object.freeze({
    ...payload,
    autonomousResearchStrictMachineIntakeReconciliationReceiptHash: hashRecord(
      'AutonomousResearchStrictMachineIntakeReconciliationReceipt', payload,
    ),
  });
  atomicReceiptWrite(receiptPath(selectedRuntimeRoot), receipt);
  return receipt;
}

export function inspectAutonomousResearchStrictMachineIntakeReconciliation({
  runtimeRoot,
  acceptancePlanHash,
  acceptanceStepIdempotencyKey,
  machineIntake,
  now = new Date(),
} = {}) {
  const selectedRuntimeRoot = path.resolve(String(runtimeRoot || ''));
  const blockers = [];
  let receipt = null;
  try {
    const candidate = receiptPath(selectedRuntimeRoot);
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(candidate) !== candidate
      || (stat.mode & 0o022) !== 0 || stat.size < 2 || stat.size > 2 * 1024 * 1024) {
      throw new Error('receipt_file_invalid');
    }
    receipt = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  } catch {
    blockers.push('autonomous_research_strict_machine_intake_receipt_missing_or_invalid');
  }
  if (receipt && !strictReceiptValid(receipt)) {
    blockers.push('autonomous_research_strict_machine_intake_receipt_invalid');
  }
  if (receipt && (receipt.runtimeRoot !== selectedRuntimeRoot
    || receipt.acceptancePlanHash !== acceptancePlanHash
    || receipt.acceptanceStepIdempotencyKey !== acceptanceStepIdempotencyKey)) {
    blockers.push('autonomous_research_strict_machine_intake_acceptance_binding_mismatch');
  }
  if (receipt && (machineIntake?.coldStartAutonomyReady !== true
    || machineIntake.configurationHash !== receipt.machineIntakeConfigurationHash
    || machineIntake.topicProducerDatasetSnapshotHash
      !== receipt.topicProducerDatasetSnapshotHash)) {
    blockers.push('autonomous_research_strict_machine_intake_current_identity_mismatch');
  }
  const inspectedAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(inspectedAt.getTime())) {
    blockers.push('autonomous_research_strict_machine_intake_inspection_time_invalid');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStrictMachineIntakeReconciliationStatus',
    status: uniqueBlockers.length
      ? 'autonomous_research_strict_machine_intake_reconciliation_blocked'
      : 'autonomous_research_strict_machine_intake_reconciliation_ready',
    ready: uniqueBlockers.length === 0,
    receipt: uniqueBlockers.length === 0 ? receipt : null,
    inspectedAt: Number.isFinite(inspectedAt.getTime()) ? inspectedAt.toISOString() : null,
    statusReadOnly: true,
    blockers: uniqueBlockers,
  });
}
