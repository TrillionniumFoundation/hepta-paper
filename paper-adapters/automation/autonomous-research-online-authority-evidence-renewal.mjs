import {
  autonomousResearchStateDatabaseInventoryHash,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  assertAutonomousResearchOnlineRuntimeActivationReceipt,
} from '../../paper-domain/automation/autonomous-research-online-runtime-activation-contract.mjs';
import {
  assertAutonomousResearchOnlineWriterOperationManifest,
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {
  assertAutonomousResearchOnlineAuthorityEvidenceRenewalAdapterPort,
  assertExternallyFencedSqliteMutationCoordinatorPort,
} from '../../paper-ports/autonomous-research-online-mutation-port.mjs';
import {
  createAutonomousResearchOnlineAuthorityEvidenceCacheReader,
  createAutonomousResearchOnlineAuthorityEvidenceCacheWriter,
} from './autonomous-research-online-authority-evidence-cache.mjs';
import {
  refreshAutonomousResearchOnlineMutationAuthorityEvidence,
} from './autonomous-research-online-mutation-active-refresh.mjs';
import {
  inspectAutonomousResearchOnlineMutationActiveEvidence,
  inspectAutonomousResearchOnlineMutationPassiveEvidence,
} from './autonomous-research-online-mutation-passive-inspection.mjs';

const FATAL_RENEWAL_ERROR = /(?:authority_(?:configuration|process)_identity_(?:changed|mismatch)|authority_(?:public_key_)?identity_mismatch|authority_scope_mismatch|active_refresh_(?:authority_mismatch|configuration_invalid|static_coverage_required)|cache_(?:invalid|refresh_invalid|size_invalid|file_unsafe|parent_unsafe|json_invalid|target_changed|readback_mismatch|global_sequence_rollback|global_hash_conflict|recorded_at_rollback|expiry_rollback)|inventory_(?:invalid|scope_changed|identity_invalid)|database_identity_changed|(?:current_head|active_challenge|scope)_receipt_invalid|passive_evidence_binding_invalid|evidence_inspection_invalid|writer_(?:manifest|static_coverage))/;

function observedDate(clock, supplied = null) {
  const value = supplied ?? clock?.now?.();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    const error = new Error('autonomous_research_online_authority_evidence_renewal_clock_invalid');
    error.authorityEvidenceRenewalFatal = true;
    throw error;
  }
  return date;
}

function fail(code, { cause = null, fatal = false } = {}) {
  const error = new Error(code, cause ? { cause } : undefined);
  if (fatal) error.authorityEvidenceRenewalFatal = true;
  throw error;
}

function markClassified(error) {
  if (error?.authorityEvidenceRenewalFatal === true) return error;
  const message = String(error?.message || error || '');
  if (FATAL_RENEWAL_ERROR.test(message.replaceAll('\n', ''))) {
    error.authorityEvidenceRenewalFatal = true;
  }
  return error;
}

function validateInventory(inventory) {
  let computed;
  try { computed = autonomousResearchStateDatabaseInventoryHash(inventory); }
  catch (error) {
    fail('autonomous_research_online_authority_evidence_renewal_inventory_invalid', {
      cause: error,
      fatal: true,
    });
  }
  if (inventory?.status !== 'autonomous_research_state_database_inventory_ready'
    || inventory.inventoryHash !== computed
    || !Array.isArray(inventory.instances)
    || inventory.instances.length === 0
    || !Array.isArray(inventory.blockers)
    || inventory.blockers.length !== 0) {
    fail('autonomous_research_online_authority_evidence_renewal_inventory_invalid', {
      fatal: true,
    });
  }
  return inventory;
}

function scopeProjection(inventory) {
  return Object.freeze(inventory.instances.map((entry) => Object.freeze({
    role: entry.role,
    instanceId: entry.instanceId,
    sourceRelativePath: entry.sourceRelativePath,
    schemaContractId: entry.schemaContractId,
    schemaHash: entry.schemaHash,
  })).sort((left, right) => left.instanceId.localeCompare(right.instanceId)));
}

function assertStableScope(expected, inventory) {
  const current = validateInventory(inventory);
  if (current.manifestId !== expected.manifestId
    || current.manifestHash !== expected.manifestHash
    || current.databaseScopeHash !== expected.databaseScopeHash
    || JSON.stringify(scopeProjection(current)) !== JSON.stringify(expected.instances)) {
    fail('autonomous_research_online_authority_evidence_renewal_inventory_scope_changed', {
      fatal: true,
    });
  }
  return current;
}

function evidenceExpiry(evidence) {
  const values = [
    evidence?.currentHead?.receipt?.expiresAt,
    evidence?.activeChallenge?.receipt?.expiresAt,
    evidence?.brokerScope?.receipt?.expiresAt,
  ].map((value) => Date.parse(String(value || '')));
  const expiry = Math.min(...values);
  if (!values.every(Number.isFinite)) {
    fail('autonomous_research_online_authority_evidence_renewal_expiry_invalid', {
      fatal: true,
    });
  }
  return expiry;
}

function minimumValidity(value) {
  const milliseconds = Number(value || 0);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    fail('autonomous_research_online_authority_evidence_renewal_validity_invalid', {
      fatal: true,
    });
  }
  return milliseconds;
}

export function createAutonomousResearchOnlineAuthorityEvidenceRenewalAdapter({
  workspaceRoot,
  runtimeRoot,
  activationReceipt,
  activationInventory,
  coordinator,
  authorityProcessConfigurationPath,
  authorityConfigurationPath,
  authorityClient,
  manifest,
  resolveInventory,
  clock = { now: () => new Date() },
  refreshAuthorityEvidence = refreshAutonomousResearchOnlineMutationAuthorityEvidence,
  inspectActiveEvidence = inspectAutonomousResearchOnlineMutationActiveEvidence,
  inspectPassiveEvidence = inspectAutonomousResearchOnlineMutationPassiveEvidence,
  createCacheReader = createAutonomousResearchOnlineAuthorityEvidenceCacheReader,
  createCacheWriter = createAutonomousResearchOnlineAuthorityEvidenceCacheWriter,
} = {}) {
  const receipt = assertAutonomousResearchOnlineRuntimeActivationReceipt(activationReceipt);
  const checkedManifest = assertAutonomousResearchOnlineWriterOperationManifest(manifest);
  const checkedCoordinator = assertExternallyFencedSqliteMutationCoordinatorPort(coordinator);
  const initialInventory = validateInventory(activationInventory);
  const manifestHash = autonomousResearchOnlineWriterOperationManifestHash(checkedManifest);
  const expectedScope = Object.freeze({
    manifestId: initialInventory.manifestId,
    manifestHash: initialInventory.manifestHash,
    databaseScopeHash: initialInventory.databaseScopeHash,
    instances: scopeProjection(initialInventory),
  });
  if (!workspaceRoot || !runtimeRoot || !authorityProcessConfigurationPath
    || !authorityConfigurationPath || typeof resolveInventory !== 'function'
    || receipt.databaseScopeHash !== expectedScope.databaseScopeHash
    || receipt.writerManifestHash !== manifestHash
    || authorityClient?.trust?.databaseScopeHash !== expectedScope.databaseScopeHash
    || authorityClient?.trust?.writerManifestHash !== manifestHash
    || checkedCoordinator.inspectStatus()?.status
      !== 'externally_fenced_sqlite_mutation_coordinator_ready'
    || checkedCoordinator.inspectStatus()?.activationReceiptHash
      !== receipt.activationReceiptHash) {
    fail('autonomous_research_online_authority_evidence_renewal_configuration_invalid', {
      fatal: true,
    });
  }
  const cacheReader = createCacheReader({ runtimeRoot });
  const cacheWriter = createCacheWriter({ runtimeRoot });

  function currentInventory() {
    return assertStableScope(expectedScope, resolveInventory());
  }

  function inspectCurrent({ now = null, minimumRemainingValidityMs = 0 } = {}) {
    const observed = observedDate(clock, now);
    const required = minimumValidity(minimumRemainingValidityMs);
    const inventory = currentInventory();
    let evidence;
    try {
      evidence = cacheReader.readPassiveAuthorityEvidence({
        databaseScopeHash: expectedScope.databaseScopeHash,
        writerManifestHash: manifestHash,
        now: null,
      });
    } catch (error) {
      const classified = markClassified(error);
      if (classified?.authorityEvidenceRenewalFatal === true) throw classified;
      return Object.freeze({
        ready: false,
        status: 'autonomous_research_online_authority_evidence_renewal_required',
        reason: String(error?.message || error),
        expiresAt: null,
        remainingValidityMs: 0,
        externalActionPerformed: false,
      });
    }
    const expiresAtMs = evidenceExpiry(evidence);
    const remainingValidityMs = expiresAtMs - observed.getTime();
    if (remainingValidityMs <= required) {
      return Object.freeze({
        ready: false,
        status: 'autonomous_research_online_authority_evidence_renewal_required',
        reason: 'autonomous_research_online_authority_evidence_validity_insufficient',
        expiresAt: new Date(expiresAtMs).toISOString(),
        remainingValidityMs: Math.max(0, remainingValidityMs),
        externalActionPerformed: false,
      });
    }
    try {
      const inspection = inspectPassiveEvidence({
        workspaceRoot,
        runtimeRoot,
        inventory,
        authorityConfigurationPath,
        now: observed,
        coordinatorStatus: checkedCoordinator.inspectStatus(),
        manifest: checkedManifest,
      });
      if (inspection?.status !== 'autonomous_research_online_anti_rollback_ready'
        || inspection.blockers?.length !== 0) {
        fail('autonomous_research_online_authority_evidence_passive_inspection_blocked');
      }
      return Object.freeze({
        ready: true,
        status: 'autonomous_research_online_authority_evidence_current',
        reason: null,
        expiresAt: new Date(expiresAtMs).toISOString(),
        remainingValidityMs,
        cacheHash: evidence.cacheHash,
        inspection,
        externalActionPerformed: false,
      });
    } catch (error) { throw markClassified(error); }
  }

  function renew({
    now = null,
    minimumRemainingValidityMs = 0,
    assertResidentFence = null,
  } = {}) {
    observedDate(clock, now);
    const required = minimumValidity(minimumRemainingValidityMs);
    if (assertResidentFence !== null && typeof assertResidentFence !== 'function') {
      fail('autonomous_research_online_authority_evidence_resident_fence_invalid', {
        fatal: true,
      });
    }
    try {
      const before = currentInventory();
      const activeRefresh = refreshAuthorityEvidence({
        workspaceRoot,
        runtimeRoot,
        inventory: before,
        authorityProcessConfigurationPath,
        manifest: checkedManifest,
        clock,
        maximumLinearizationAttempts: 1,
        createAuthorityClient: () => authorityClient,
        recordJournalEvidence: false,
      });
      const activeInspection = inspectActiveEvidence({
        workspaceRoot,
        inventory: before,
        authorityConfigurationPath,
        now: observedDate(clock),
        coordinatorStatus: checkedCoordinator.inspectStatus(),
        activeRefreshReceipt: activeRefresh,
        manifest: checkedManifest,
      });
      if (activeInspection?.status !== 'autonomous_research_online_anti_rollback_ready'
        || activeInspection.blockers?.length !== 0) {
        fail('autonomous_research_online_authority_evidence_active_inspection_blocked');
      }
      const expiresAtMs = Math.min(...[
        activeInspection.currentHeadReceipt?.expiresAt,
        activeInspection.activeChallengeReceipt?.expiresAt,
        activeInspection.writerCoverage?.brokerScopeReceipt?.expiresAt,
      ].map((value) => Date.parse(String(value || ''))));
      const verifiedAt = observedDate(clock);
      if (!Number.isFinite(expiresAtMs)
        || expiresAtMs - verifiedAt.getTime() <= required) {
        fail('autonomous_research_online_authority_evidence_renewal_validity_insufficient');
      }
      currentInventory();
      assertResidentFence?.({ now: verifiedAt });
      const cacheReceipt = cacheWriter.recordActiveAuthorityEvidence({
        activeRefreshReceipt: activeRefresh,
        databaseScopeHash: expectedScope.databaseScopeHash,
        writerManifestHash: manifestHash,
        expiresAt: new Date(expiresAtMs).toISOString(),
      });
      const readback = inspectCurrent({
        now: observedDate(clock),
        minimumRemainingValidityMs: required,
      });
      if (!readback.ready || readback.cacheHash !== cacheReceipt.cacheHash) {
        fail('autonomous_research_online_authority_evidence_renewal_readback_failed');
      }
      return Object.freeze({
        ready: true,
        status: 'autonomous_research_online_authority_evidence_renewed',
        reason: null,
        activationReceiptHash: receipt.activationReceiptHash,
        cacheHash: cacheReceipt.cacheHash,
        expiresAt: cacheReceipt.expiresAt,
        remainingValidityMs: readback.remainingValidityMs,
        authorityGlobalSequence: activeRefresh.globalSequence,
        authorityGlobalHash: activeRefresh.globalHash,
        externalActionPerformed: true,
      });
    } catch (error) { throw markClassified(error); }
  }

  return assertAutonomousResearchOnlineAuthorityEvidenceRenewalAdapterPort(Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineAuthorityEvidenceRenewalAdapter',
    activationReceiptHash: receipt.activationReceiptHash,
    databaseScopeHash: expectedScope.databaseScopeHash,
    writerManifestHash: manifestHash,
    authorityOperationTimeoutMs: Number(authorityClient.operationTimeoutMs || 1_000),
    authorityTrust: authorityClient.trust,
    inspectCurrent,
    renew,
  }));
}
