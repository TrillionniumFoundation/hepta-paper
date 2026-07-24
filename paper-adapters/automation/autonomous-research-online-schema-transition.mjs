import {
  autonomousResearchStateDatabaseInventoryHash,
  autonomousResearchStateDatabaseManifestHash,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  autonomousResearchOnlineSchemaTransitionReadyReceiptHash,
  autonomousResearchOnlineSchemaTransitionReceiptHash,
  AUTONOMOUS_RESEARCH_ONLINE_SCHEMA_TRANSITION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import {
  assertAutonomousResearchOnlineWriterOperationManifest,
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createAutonomousResearchOnlineSchemaTransitionAuthorityProcessClient,
} from './autonomous-research-online-schema-transition-authority.mjs';
import {
  acquireAutonomousResearchOnlineSchemaTransitionLocks,
  assertAutonomousResearchOnlineSchemaTransitionLease,
  installAutonomousResearchOnlineSchemaTransitionLocks,
} from './autonomous-research-online-schema-transition-installation.mjs';
import {
  buildAutonomousResearchOnlineSchemaTransitionPlan,
  resolveAutonomousResearchOnlineSchemaTransitionPostInventory,
  schemaTransitionNow,
  validateAutonomousResearchOnlineSchemaTransitionInventory,
} from './autonomous-research-online-schema-transition-schema.mjs';
import {
  autonomousResearchOnlineSchemaTransitionControlPaths,
  readAutonomousResearchOnlineSchemaTransitionJson,
  writeAutonomousResearchOnlineSchemaTransitionJson,
} from './autonomous-research-online-schema-transition-state-repository.mjs';
import {
  autonomousResearchOnlineSchemaTransitionPlanHashValid,
  buildAutonomousResearchOnlineSchemaTransitionAuditReceipt,
  buildAutonomousResearchOnlineSchemaTransitionFinalizeRequest,
  buildAutonomousResearchOnlineSchemaTransitionObserveRequest,
  buildAutonomousResearchOnlineSchemaTransitionReserveRequest,
} from './autonomous-research-online-schema-transition-state.mjs';
import {
  resolveAutonomousResearchStateDatabaseInventory,
} from './autonomous-research-state-database-inventory.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function fail(code) {
  throw new Error(code);
}

function currentPlanOrState({
  runtimeRoot,
  stateDatabaseManifest,
  writerManifest,
  authorityClient,
  clock,
  requestedLeaseMs,
  requiredExecutionWindowMs,
  activeStatePath,
}) {
  const stored = readAutonomousResearchOnlineSchemaTransitionJson(activeStatePath);
  if (!stored) return Object.freeze({
    plan: buildAutonomousResearchOnlineSchemaTransitionPlan({
      runtimeRoot,
      stateDatabaseManifest,
      writerManifest,
      trust: authorityClient.trust,
      clock,
      requestedLeaseMs,
      requiredExecutionWindowMs,
    }),
    installations: Object.freeze([]),
  });
  if (stored.version !== 1
    || stored.kind !== 'AutonomousResearchOnlineSchemaTransitionState'
    || !autonomousResearchOnlineSchemaTransitionPlanHashValid(stored.plan)
    || stored.plan.databaseScopeHash !== authorityClient.trust.databaseScopeHash
    || stored.plan.writerManifestHash
      !== autonomousResearchOnlineWriterOperationManifestHash(writerManifest)
    || stored.plan.stateDatabaseManifestHash
      !== autonomousResearchStateDatabaseManifestHash(stateDatabaseManifest)) {
    fail('autonomous_research_online_schema_transition_state_invalid');
  }
  const current = validateAutonomousResearchOnlineSchemaTransitionInventory({
    runtimeRoot,
    stateDatabaseManifest,
    inventory: resolveAutonomousResearchStateDatabaseInventory({
      runtimeRoot,
      manifest: stateDatabaseManifest,
    }),
  });
  const currentById = new Map(current.instances.map((entry) => [entry.instanceId, entry]));
  if (current.databaseScopeHash !== stored.plan.databaseScopeHash
    || current.instances.length !== stored.plan.instances.length
    || stored.plan.instances.some((entry) => {
      const observed = currentById.get(entry.databaseInstanceId);
      return !observed
        || observed.role !== entry.databaseRole
        || observed.sourceRelativePath !== entry.sourceRelativePath
        || ![entry.preSchemaHash, entry.expectedPostSchemaHash].includes(observed.schemaHash);
    })) fail('autonomous_research_online_schema_transition_resume_scope_changed');
  return Object.freeze({
    plan: Object.freeze(stored.plan),
    installations: Object.freeze(stored.installations || []),
    reserveRequest: stored.reserveRequest ? Object.freeze(stored.reserveRequest) : null,
    reservation: stored.reservation ? Object.freeze(stored.reservation) : null,
  });
}

function createContext({
  runtimeRoot,
  stateDatabaseManifest,
  writerManifest,
  authorityProcessConfigurationPath,
  requestedLeaseMs,
  requiredExecutionWindowMs,
  clock,
  createAuthorityClient,
}) {
  const authorityClient = createAuthorityClient({
    processConfigurationPath: authorityProcessConfigurationPath,
  });
  const paths = autonomousResearchOnlineSchemaTransitionControlPaths(runtimeRoot, {
    create: false,
  });
  const active = currentPlanOrState({
    runtimeRoot,
    stateDatabaseManifest,
    writerManifest,
    authorityClient,
    clock,
    requestedLeaseMs,
    requiredExecutionWindowMs,
    activeStatePath: paths.activeStatePath,
  });
  return Object.freeze({ authorityClient, paths, active });
}

export function planAutonomousResearchOnlineSchemaTransition({
  runtimeRoot,
  stateDatabaseManifest,
  writerManifest,
  authorityProcessConfigurationPath,
  requestedLeaseMs = 120000,
  requiredExecutionWindowMs = 30000,
  clock = { now: () => new Date() },
  createAuthorityClient =
    createAutonomousResearchOnlineSchemaTransitionAuthorityProcessClient,
} = {}) {
  const { active } = createContext({
    runtimeRoot,
    stateDatabaseManifest,
    writerManifest,
    authorityProcessConfigurationPath,
    requestedLeaseMs,
    requiredExecutionWindowMs,
    clock,
    createAuthorityClient,
  });
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineSchemaTransitionPlanReport',
    status: active.installations.length
      ? 'autonomous_research_online_schema_transition_resume_ready'
      : 'autonomous_research_online_schema_transition_plan_ready',
    ready: true,
    plan: active.plan,
    completedInstanceIds: Object.freeze(active.installations.map((entry) => (
      entry.databaseInstanceId
    )).sort()),
    crossDatabaseAtomicityClaimed: false,
    networkUse: false,
    publicationPerformed: false,
    blockers: Object.freeze([]),
  });
}

export function executeAutonomousResearchOnlineSchemaTransition({
  runtimeRoot,
  stateDatabaseManifest,
  writerManifest,
  authorityProcessConfigurationPath,
  requestedLeaseMs = 120000,
  requiredExecutionWindowMs = 30000,
  commitSafetyMarginMs = 1000,
  expectedTransitionId,
  clock = { now: () => new Date() },
  createAuthorityClient =
    createAutonomousResearchOnlineSchemaTransitionAuthorityProcessClient,
  faultInjector = null,
} = {}) {
  if (!SHA256.test(String(expectedTransitionId || ''))) {
    fail('autonomous_research_online_schema_transition_expected_transition_id_required');
  }
  if (!Number.isSafeInteger(commitSafetyMarginMs)
    || commitSafetyMarginMs < 1
    || commitSafetyMarginMs >= requiredExecutionWindowMs) {
    fail('autonomous_research_online_schema_transition_safety_margin_invalid');
  }
  const { authorityClient, active } = createContext({
    runtimeRoot,
    stateDatabaseManifest,
    writerManifest,
    authorityProcessConfigurationPath,
    requestedLeaseMs,
    requiredExecutionWindowMs,
    clock,
    createAuthorityClient,
  });
  const plan = active.plan;
  if (plan.transitionId !== expectedTransitionId) {
    fail('autonomous_research_online_schema_transition_expected_transition_id_mismatch');
  }
  const storedReservationComplete = Boolean(active.reserveRequest && active.reservation);
  if (Boolean(active.reserveRequest) !== Boolean(active.reservation)) {
    fail('autonomous_research_online_schema_transition_stored_reservation_incomplete');
  }
  const paths = autonomousResearchOnlineSchemaTransitionControlPaths(runtimeRoot, {
    create: true,
  });
  const reserveRequest = storedReservationComplete
    ? active.reserveRequest
    : buildAutonomousResearchOnlineSchemaTransitionReserveRequest(
      plan,
      schemaTransitionNow(clock).toISOString(),
    );
  const reservation = storedReservationComplete
    ? active.reservation
    : authorityClient.reserveSchemaTransition({
      request: reserveRequest,
      now: schemaTransitionNow(clock),
    });
  if (storedReservationComplete
    && (reserveRequest.transitionId !== plan.transitionId
      || typeof authorityClient.verifyStoredReservation !== 'function'
      || authorityClient.verifyStoredReservation({
        receipt: reservation,
        request: reserveRequest,
        now: schemaTransitionNow(clock),
      }) !== true)) {
    fail('autonomous_research_online_schema_transition_stored_reservation_invalid');
  }
  assertAutonomousResearchOnlineSchemaTransitionLease(
    reservation,
    clock,
    plan.requiredExecutionWindowMs,
    'autonomous_research_online_schema_transition_execution_window_insufficient',
  );
  const state = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineSchemaTransitionState',
    phase: 'reserved',
    plan,
    reserveRequest,
    reservation,
    installations: active.installations,
  });
  writeAutonomousResearchOnlineSchemaTransitionJson(paths.activeStatePath, state);
  faultInjector?.({ point: 'after_reservation', completedCount: active.installations.length });
  const currentInventory = validateAutonomousResearchOnlineSchemaTransitionInventory({
    runtimeRoot,
    stateDatabaseManifest,
    inventory: resolveAutonomousResearchStateDatabaseInventory({
      runtimeRoot,
      manifest: stateDatabaseManifest,
    }),
  });
  const locks = acquireAutonomousResearchOnlineSchemaTransitionLocks({
    runtimeRoot,
    currentInventory,
    plan,
  });
  faultInjector?.({ point: 'after_all_locks', completedCount: active.installations.length });
  assertAutonomousResearchOnlineSchemaTransitionLease(
    reservation,
    clock,
    plan.requiredExecutionWindowMs,
    'autonomous_research_online_schema_transition_execution_window_insufficient_after_lock',
  );
  const installations = installAutonomousResearchOnlineSchemaTransitionLocks({
    locks,
    plan,
    reservation,
    clock,
    commitSafetyMarginMs,
    state,
    statePath: paths.activeStatePath,
    faultInjector,
  });
  const inventory = resolveAutonomousResearchOnlineSchemaTransitionPostInventory({
    runtimeRoot,
    stateDatabaseManifest,
    plan,
  });
  assertAutonomousResearchOnlineSchemaTransitionLease(
    reservation,
    clock,
    commitSafetyMarginMs,
    'autonomous_research_online_schema_transition_lease_expired_before_finalize',
  );
  const finalizeRequest = buildAutonomousResearchOnlineSchemaTransitionFinalizeRequest({
    plan,
    reservation,
    inventory,
    installations,
    completedAt: schemaTransitionNow(clock).toISOString(),
  });
  const finalization = authorityClient.finalizeSchemaTransition({
    request: finalizeRequest,
    reservation,
    now: schemaTransitionNow(clock),
  });
  faultInjector?.({ point: 'after_finalization', completedCount: installations.length });
  const observeRequest = buildAutonomousResearchOnlineSchemaTransitionObserveRequest({
    plan,
    finalization,
    postInventoryHash: inventory.inventoryHash,
    requestedAt: schemaTransitionNow(clock).toISOString(),
  });
  const observation = authorityClient.observeSchemaTransition({
    request: observeRequest,
    now: schemaTransitionNow(clock),
  });
  const receipt = buildAutonomousResearchOnlineSchemaTransitionAuditReceipt({
    plan,
    reserveRequest,
    reservation,
    finalizeRequest,
    finalization,
    observeRequest,
    observation,
    inventory,
    installations,
  });
  writeAutonomousResearchOnlineSchemaTransitionJson(paths.finalReceiptPath, receipt);
  writeAutonomousResearchOnlineSchemaTransitionJson(paths.activeStatePath, Object.freeze({
    ...state,
    phase: 'finalized',
    installations,
    finalReceiptHash: receipt.schemaTransitionReceiptHash,
  }));
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineSchemaTransitionExecutionReport',
    status: 'autonomous_research_online_schema_transition_ready',
    ready: true,
    receipt,
    receiptPath: paths.finalReceiptPath,
    installedDatabaseCount: installations.length,
    crossDatabaseAtomicityClaimed: false,
    externalAuthorityVerified: true,
    publicationPerformed: false,
    networkUse: false,
    blockers: Object.freeze([]),
  });
}

function validateAuditReceipt({ receipt, inventory, writerManifest, authorityClient }) {
  const payload = Object.fromEntries(Object.entries(receipt || {}).filter(([key]) => (
    key !== 'schemaTransitionReceiptHash'
  )));
  if (receipt?.version !== 1
    || receipt.kind !== 'AutonomousResearchOnlineSchemaTransitionAuditReceipt'
    || receipt.status !== 'autonomous_research_online_schema_transition_ready'
    || receipt.protocol !== AUTONOMOUS_RESEARCH_ONLINE_SCHEMA_TRANSITION_PROTOCOL
    || receipt.databaseScopeHash !== inventory.databaseScopeHash
    || receipt.writerManifestHash
      !== autonomousResearchOnlineWriterOperationManifestHash(writerManifest)
    || receipt.postInventoryHash !== inventory.inventoryHash
    || receipt.schemaTransitionReceiptHash !== hashRecord(
      'AutonomousResearchOnlineSchemaTransitionAuditReceipt', payload,
    )
    || receipt.externalAuthorityVerified !== true
    || receipt.crossDatabaseAtomicityClaimed !== false
    || !authorityClient.verifyHistoricalReservation({
      receipt: receipt.reservation,
      request: receipt.reserveRequest,
    })
    || !authorityClient.verifyHistoricalFinalization({
      receipt: receipt.finalization,
      request: receipt.finalizeRequest,
      reservation: receipt.reservation,
    })
    || !authorityClient.verifyHistoricalObservation({
      receipt: receipt.observation,
      request: receipt.observeRequest,
    })) fail('autonomous_research_online_schema_transition_audit_receipt_invalid');
  return receipt;
}

export function inspectAutonomousResearchOnlineSchemaTransitionReadiness({
  runtimeRoot,
  stateDatabaseManifest,
  writerManifest,
  authorityProcessConfigurationPath,
  clock = { now: () => new Date() },
  createAuthorityClient =
    createAutonomousResearchOnlineSchemaTransitionAuthorityProcessClient,
} = {}) {
  const checkedWriterManifest = assertAutonomousResearchOnlineWriterOperationManifest(
    writerManifest,
  );
  const authorityClient = createAuthorityClient({
    processConfigurationPath: authorityProcessConfigurationPath,
  });
  const inventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  if (inventory.status !== 'autonomous_research_state_database_inventory_ready'
    || inventory.inventoryHash !== autonomousResearchStateDatabaseInventoryHash(inventory)
    || inventory.databaseScopeHash !== authorityClient.trust.databaseScopeHash) {
    fail('autonomous_research_online_schema_transition_readiness_inventory_invalid');
  }
  const paths = autonomousResearchOnlineSchemaTransitionControlPaths(runtimeRoot, {
    create: false,
  });
  const receipt = validateAuditReceipt({
    receipt: readAutonomousResearchOnlineSchemaTransitionJson(paths.finalReceiptPath),
    inventory,
    writerManifest: checkedWriterManifest,
    authorityClient,
  });
  const request = buildAutonomousResearchOnlineSchemaTransitionObserveRequest({
    plan: receipt.reserveRequest,
    finalization: receipt.finalization,
    postInventoryHash: inventory.inventoryHash,
    requestedAt: schemaTransitionNow(clock).toISOString(),
  });
  const observation = authorityClient.observeSchemaTransition({
    request,
    now: schemaTransitionNow(clock),
  });
  const base = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineSchemaTransitionReadyReceipt',
    status: 'autonomous_research_online_schema_transition_ready',
    protocol: receipt.protocol,
    transitionId: receipt.transitionId,
    databaseScopeHash: receipt.databaseScopeHash,
    writerManifestHash: receipt.writerManifestHash,
    inventoryHash: inventory.inventoryHash,
    schemaTransitionReceiptHash: receipt.schemaTransitionReceiptHash,
    liveObservationReceiptHash:
      autonomousResearchOnlineSchemaTransitionReceiptHash(observation),
    observedAt: observation.observedAt,
    expiresAt: observation.expiresAt,
    externalAuthorityVerified: true,
    blockers: Object.freeze([]),
  });
  return Object.freeze({
    ...base,
    readinessReceiptHash: autonomousResearchOnlineSchemaTransitionReadyReceiptHash(base),
  });
}

export { autonomousResearchOnlineSchemaTransitionControlPaths };
