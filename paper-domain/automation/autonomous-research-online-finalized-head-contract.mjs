import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from './autonomous-research-state-backup-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/;
const ROLE_SET = new Set(AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES);
const RECEIPT_KEYS = Object.freeze([
  'version', 'kind', 'status', 'inventoryHash', 'databaseScopeHash',
  'writerManifestHash', 'databaseRole', 'databaseInstanceId',
  'schemaContractId', 'schemaHash', 'currentHeadReceiptHash',
  'authorityGlobalSequence', 'authorityGlobalHash', 'localDatabaseSequence',
  'localDatabaseHash', 'localStateHash', 'markerCount', 'finalizationCount',
  'genesisZeroHeadVerified', 'markerChainHash', 'inspectedAt',
  'remainingBlockers', 'runtimeReady', 'inspectionReceiptHash',
]);

export const AUTONOMOUS_RESEARCH_ONLINE_FINALIZED_HEAD_REMAINING_BLOCKERS =
  Object.freeze([
    'autonomous_research_online_mutation_fresh_active_challenge_required',
    'autonomous_research_online_mutation_ten_database_activation_required',
  ]);

function fail(code) {
  throw new Error(code);
}

function timestamp(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function sameValues(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function autonomousResearchOnlineFinalizedHeadInspectionReceiptHash(receipt) {
  const payload = Object.fromEntries(
    Object.entries(receipt || {}).filter(([key]) => key !== 'inspectionReceiptHash'),
  );
  return hashRecord('AutonomousResearchOnlineFinalizedHeadInspectionReceipt', payload);
}

export function assertAutonomousResearchOnlineFinalizedHeadInspectionReceipt(receipt) {
  if (!hasExactObjectKeys(receipt, RECEIPT_KEYS)
    || receipt.version !== 1
    || receipt.kind !== 'AutonomousResearchOnlineFinalizedHeadInspectionReceipt'
    || receipt.status !== 'autonomous_research_online_finalized_head_reconciled'
    || !SHA256.test(String(receipt.inventoryHash || ''))
    || !SHA256.test(String(receipt.databaseScopeHash || ''))
    || !SHA256.test(String(receipt.writerManifestHash || ''))
    || !ROLE_SET.has(receipt.databaseRole)
    || !SAFE_ID.test(String(receipt.databaseInstanceId || ''))
    || !SAFE_ID.test(String(receipt.schemaContractId || ''))
    || !SHA256.test(String(receipt.schemaHash || ''))
    || !SHA256.test(String(receipt.currentHeadReceiptHash || ''))
    || !Number.isSafeInteger(receipt.authorityGlobalSequence)
    || receipt.authorityGlobalSequence < 0
    || !SHA256.test(String(receipt.authorityGlobalHash || ''))
    || !Number.isSafeInteger(receipt.localDatabaseSequence)
    || receipt.localDatabaseSequence < 0
    || !SHA256.test(String(receipt.localDatabaseHash || ''))
    || !SHA256.test(String(receipt.localStateHash || ''))
    || !Number.isSafeInteger(receipt.markerCount)
    || receipt.markerCount < 0
    || receipt.finalizationCount !== receipt.markerCount
    || receipt.genesisZeroHeadVerified !== true
    || !SHA256.test(String(receipt.markerChainHash || ''))
    || timestamp(receipt.inspectedAt) === null
    || !sameValues(
      receipt.remainingBlockers,
      AUTONOMOUS_RESEARCH_ONLINE_FINALIZED_HEAD_REMAINING_BLOCKERS,
    )
    || receipt.runtimeReady !== false
    || !SHA256.test(String(receipt.inspectionReceiptHash || ''))
    || receipt.inspectionReceiptHash
      !== autonomousResearchOnlineFinalizedHeadInspectionReceiptHash(receipt)) {
    fail('autonomous_research_online_finalized_head_inspection_receipt_invalid');
  }
  return receipt;
}
