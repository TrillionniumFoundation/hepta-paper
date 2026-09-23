import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from './autonomous-research-state-backup-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from './autonomous-research-online-mutation-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RECEIPT_KEYS = Object.freeze([
  'version', 'kind', 'status', 'protocol', 'inventoryHash', 'databaseScopeHash',
  'writerManifestHash', 'authorityId', 'keyId', 'authorityGlobalSequence',
  'authorityGlobalHash', 'databaseActivations', 'activeRefreshReceiptHash',
  'authorityEvidenceCacheReceiptHash',
  'restoreDrillReceiptHash', 'schemaTransitionReceiptHash', 'activatedAt', 'coordinatorRuntimeReady',
  'remainingBlockers', 'activationReceiptHash',
]);
const DATABASE_KEYS = Object.freeze([
  'databaseRole', 'databaseInstanceId', 'schemaContractId', 'schemaHash',
  'startupReconciliationReceiptHash', 'finalizedHeadInspectionReceiptHash',
  'databaseSequence', 'databaseHash', 'stateHash',
]);

function fail() {
  throw new Error('autonomous_research_online_runtime_activation_receipt_invalid');
}

function activationPayload(receipt) {
  return Object.fromEntries(Object.entries(receipt).filter(([key]) => (
    key !== 'activationReceiptHash'
  )));
}

export function autonomousResearchOnlineRuntimeActivationReceiptHash(receipt) {
  return hashRecord(
    'AutonomousResearchOnlineRuntimeActivationReceipt',
    activationPayload(receipt),
  );
}

export function assertAutonomousResearchOnlineRuntimeActivationReceipt(receipt) {
  if (!hasExactObjectKeys(receipt, RECEIPT_KEYS)
    || receipt.version !== 1
    || receipt.kind !== 'AutonomousResearchOnlineRuntimeActivationReceipt'
    || receipt.status !== 'autonomous_research_online_mutation_runtime_activated'
    || receipt.protocol !== AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL
    || !SHA256.test(String(receipt.inventoryHash || ''))
    || !SHA256.test(String(receipt.databaseScopeHash || ''))
    || !SHA256.test(String(receipt.writerManifestHash || ''))
    || typeof receipt.authorityId !== 'string' || !receipt.authorityId
    || typeof receipt.keyId !== 'string' || !receipt.keyId
    || !Number.isSafeInteger(receipt.authorityGlobalSequence)
    || receipt.authorityGlobalSequence < 0
    || !SHA256.test(String(receipt.authorityGlobalHash || ''))
    || !SHA256.test(String(receipt.activeRefreshReceiptHash || ''))
    || !SHA256.test(String(receipt.authorityEvidenceCacheReceiptHash || ''))
    || !SHA256.test(String(receipt.restoreDrillReceiptHash || ''))
    || !SHA256.test(String(receipt.schemaTransitionReceiptHash || ''))
    || !Number.isFinite(Date.parse(String(receipt.activatedAt || '')))
    || receipt.coordinatorRuntimeReady !== true
  || !Array.isArray(receipt.remainingBlockers)
  || receipt.remainingBlockers.length !== 0
  || !Array.isArray(receipt.databaseActivations)
    || receipt.databaseActivations.length !== AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length) {
    fail();
  }
  const instanceIds = [];
  const roles = [];
  for (const entry of receipt.databaseActivations) {
    if (!hasExactObjectKeys(entry, DATABASE_KEYS)
      || typeof entry.databaseRole !== 'string' || !entry.databaseRole
      || typeof entry.databaseInstanceId !== 'string' || !entry.databaseInstanceId
      || typeof entry.schemaContractId !== 'string' || !entry.schemaContractId
      || !SHA256.test(String(entry.schemaHash || ''))
      || !SHA256.test(String(entry.startupReconciliationReceiptHash || ''))
      || !SHA256.test(String(entry.finalizedHeadInspectionReceiptHash || ''))
      || !Number.isSafeInteger(entry.databaseSequence)
      || entry.databaseSequence < 0
      || !SHA256.test(String(entry.databaseHash || ''))
      || !SHA256.test(String(entry.stateHash || ''))) {
      fail();
    }
    instanceIds.push(entry.databaseInstanceId);
    roles.push(entry.databaseRole);
  }
  if (new Set(instanceIds).size !== instanceIds.length
    || instanceIds.join('\0') !== [...instanceIds].sort().join('\0')
    || new Set(roles).size !== roles.length
    || [...new Set(roles)].sort().join('\0')
      !== [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort().join('\0')
    || receipt.activationReceiptHash
      !== autonomousResearchOnlineRuntimeActivationReceiptHash(receipt)) {
    fail();
  }
  return receipt;
}
