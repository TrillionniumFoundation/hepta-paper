import { autonomousResearchStateDatabaseInventoryHash,
  autonomousResearchStateDatabaseManifestHash }
  from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  autonomousResearchOnlineSchemaTransitionReadyReceiptHash,
  autonomousResearchOnlineSchemaTransitionReceiptHash,
} from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import {
  assertAutonomousResearchOnlineWriterOperationManifest,
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {
  createAutonomousResearchOnlineSchemaTransitionAuthorityProcessClient,
} from './autonomous-research-online-schema-transition-authority.mjs';
import {
  acquireAutonomousResearchOnlineSchemaTransitionLocks,
  assertAutonomousResearchOnlineSchemaTransitionLease,
  installAutonomousResearchOnlineSchemaTransitionLocks,
} from './autonomous-research-online-schema-transition-installation.mjs';
import {
  executeAutonomousResearchOnlineSchemaTransitionJournalNormalization,
} from './autonomous-research-online-schema-transition-journal-normalization.mjs';
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
  buildAutonomousResearchOnlineSchemaTransitionFinalizeRequest,
  buildAutonomousResearchOnlineSchemaTransitionObserveRequest,
  buildAutonomousResearchOnlineSchemaTransitionReserveRequest,
} from './autonomous-research-online-schema-transition-state.mjs';
import {
  autonomousResearchPristineSchemaRebindRestartRequiredReport,
  completeAutonomousResearchOnlineSchemaTransitionExecution,
  resolveAutonomousResearchOnlineSchemaTransitionPristineState,
  validateAutonomousResearchOnlineSchemaTransitionAuditReceipt,
} from './autonomous-research-online-schema-transition-completion.mjs';
import {
  resolveAutonomousResearchStateDatabaseInventory,
} from './autonomous-research-state-database-inventory.mjs';
const SHA256 = /^sha256:[0-9a-f]{64}$/;
function fail(code) { throw new Error(code); }
function currentPlanOrState({
  runtimeRoot,
  stateDatabaseManifest,
  writerManifest,
  authorityClient,
  clock,
  requestedLeaseMs,
  requiredExecutionWindowMs,
  expectedPreRebindPristineRuntimeStateHash,
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
      expectedPreRebindPristineRuntimeStateHash,
    }),
    installations: Object.freeze([]),
  });
  const candidateWriterManifestHash = autonomousResearchOnlineWriterOperationManifestHash(
    writerManifest,
  );
  if (stored.version !== 1
    || stored.kind !== 'AutonomousResearchOnlineSchemaTransitionState'
    || !autonomousResearchOnlineSchemaTransitionPlanHashValid(stored.plan)
    || stored.plan.databaseScopeHash !== authorityClient.trust.databaseScopeHash
    || (stored.plan.writerManifestHash !== candidateWriterManifestHash
      && !(stored.phase === 'finalized'
        && SHA256.test(String(stored.finalReceiptHash || ''))
        && stored.plan.writerManifestHash === authorityClient.trust.writerManifestHash))
    || (stored.plan.version === 2
      && ![stored.plan.sourceWriterManifestHash, stored.plan.writerManifestHash]
        .includes(authorityClient.trust.writerManifestHash))
    || stored.plan.stateDatabaseManifestHash
      !== autonomousResearchStateDatabaseManifestHash(stateDatabaseManifest)) {
    fail('autonomous_research_online_schema_transition_state_invalid');
  }
  if (stored.phase === 'finalized'
    && stored.plan.writerManifestHash !== candidateWriterManifestHash) {
    return Object.freeze({
      plan: buildAutonomousResearchOnlineSchemaTransitionPlan({
        runtimeRoot,
        stateDatabaseManifest,
        writerManifest,
        trust: authorityClient.trust,
        clock,
        requestedLeaseMs,
        requiredExecutionWindowMs,
        expectedPreRebindPristineRuntimeStateHash,
      }),
      installations: Object.freeze([]),
    });
  }
  if ((stored.reservation && !stored.reserveRequest)
    || (stored.finalizeRequest && !stored.reservation)
    || (stored.finalization && !stored.finalizeRequest)
    || (stored.observeRequest && !stored.finalization)
    || (stored.observation && !stored.observeRequest)) {
    fail('autonomous_research_online_schema_transition_state_phase_incomplete');
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
    finalizeRequest: stored.finalizeRequest ? Object.freeze(stored.finalizeRequest) : null,
    finalization: stored.finalization ? Object.freeze(stored.finalization) : null,
    observeRequest: stored.observeRequest ? Object.freeze(stored.observeRequest) : null,
    observation: stored.observation ? Object.freeze(stored.observation) : null,
    postPristineRuntimeStateHash: stored.postPristineRuntimeStateHash || null,
  });
}

function createContext({
  runtimeRoot,
  stateDatabaseManifest,
  writerManifest,
  authorityProcessConfigurationPath,
  requestedLeaseMs,
  requiredExecutionWindowMs,
  expectedPreRebindPristineRuntimeStateHash,
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
    expectedPreRebindPristineRuntimeStateHash,
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
  expectedPreRebindPristineRuntimeStateHash = null,
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
    expectedPreRebindPristineRuntimeStateHash,
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
  expectedPreRebindPristineRuntimeStateHash = null,
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
    expectedPreRebindPristineRuntimeStateHash,
    clock,
    createAuthorityClient,
  });
  const plan = active.plan;
  if (plan.transitionId !== expectedTransitionId) {
    fail('autonomous_research_online_schema_transition_expected_transition_id_mismatch');
  }
  const paths = autonomousResearchOnlineSchemaTransitionControlPaths(runtimeRoot, {
    create: true,
  });
  if (active.finalization) {
    if (!active.finalizeRequest
      || !active.reserveRequest
      || !active.reservation
      || !authorityClient.verifyHistoricalReservation({
        receipt: active.reservation,
        request: active.reserveRequest,
      })
      || !authorityClient.verifyHistoricalFinalization({
        receipt: active.finalization,
        request: active.finalizeRequest,
        reservation: active.reservation,
      })) {
      fail('autonomous_research_pristine_schema_rebind_stored_finalization_invalid');
    }
    const inventory = resolveAutonomousResearchOnlineSchemaTransitionPostInventory({
      runtimeRoot,
      stateDatabaseManifest,
      plan,
    });
    const pristineReadBeforeObserve =
      resolveAutonomousResearchOnlineSchemaTransitionPristineState({
        runtimeRoot,
        inventory,
        plan,
        installations: active.installations,
      });
    const pristineReadForObserve =
      resolveAutonomousResearchOnlineSchemaTransitionPristineState({
        runtimeRoot,
        inventory,
        plan,
        installations: active.installations,
      });
    if (pristineReadBeforeObserve.pristineRuntimeStateHash
        !== pristineReadForObserve.pristineRuntimeStateHash
      || (active.postPristineRuntimeStateHash
        && active.postPristineRuntimeStateHash
          !== pristineReadForObserve.pristineRuntimeStateHash)) {
      fail('autonomous_research_pristine_schema_rebind_observation_state_changed');
    }
    return completeAutonomousResearchOnlineSchemaTransitionExecution({
      authorityClient,
      clock,
      plan,
      paths,
      state: Object.freeze({
        version: 1,
        kind: 'AutonomousResearchOnlineSchemaTransitionState',
        plan,
        reserveRequest: active.reserveRequest,
        reservation: active.reservation,
        finalizeRequest: active.finalizeRequest,
        finalization: active.finalization,
        postPristineRuntimeStateHash:
          pristineReadForObserve.pristineRuntimeStateHash,
        ...(active.observeRequest ? { observeRequest: active.observeRequest } : {}),
        ...(active.observation ? { observation: active.observation } : {}),
      }),
      reserveRequest: active.reserveRequest,
      reservation: active.reservation,
      finalizeRequest: active.finalizeRequest,
      finalization: active.finalization,
      inventory,
      installations: active.installations,
      postPristineRuntimeStateHash: pristineReadForObserve.pristineRuntimeStateHash,
      faultInjector,
    });
  }
  if (active.finalizeRequest) {
    if (!active.reserveRequest || !active.reservation
      || active.installations.length !== plan.instances.length
      || !authorityClient.verifyHistoricalReservation({
        receipt: active.reservation,
        request: active.reserveRequest,
      })) {
      fail('autonomous_research_online_schema_transition_finalize_recovery_state_invalid');
    }
    const inventory = resolveAutonomousResearchOnlineSchemaTransitionPostInventory({
      runtimeRoot,
      stateDatabaseManifest,
      plan,
    });
    const pristineBeforeFinalize =
      resolveAutonomousResearchOnlineSchemaTransitionPristineState({
        runtimeRoot,
        inventory,
        plan,
        installations: active.installations,
      });
    const expectedFinalizeRequest =
      buildAutonomousResearchOnlineSchemaTransitionFinalizeRequest({
        plan,
        reservation: active.reservation,
        inventory,
        installations: active.installations,
        postPristineRuntimeStateHash: pristineBeforeFinalize.pristineRuntimeStateHash,
        completedAt: active.finalizeRequest.completedAt,
      });
    if (JSON.stringify(expectedFinalizeRequest) !== JSON.stringify(active.finalizeRequest)
      || (active.postPristineRuntimeStateHash
        && active.postPristineRuntimeStateHash
          !== pristineBeforeFinalize.pristineRuntimeStateHash)) {
      fail('autonomous_research_online_schema_transition_stored_finalize_request_invalid');
    }
    const finalization = authorityClient.finalizeSchemaTransition({
      request: active.finalizeRequest,
      reservation: active.reservation,
      now: schemaTransitionNow(clock),
    });
    faultInjector?.({
      point: 'after_finalization',
      completedCount: active.installations.length,
    });
    const pristineAfterFinalize =
      resolveAutonomousResearchOnlineSchemaTransitionPristineState({
        runtimeRoot,
        inventory,
        plan,
        installations: active.installations,
      });
    if (pristineBeforeFinalize.pristineRuntimeStateHash
      !== pristineAfterFinalize.pristineRuntimeStateHash) {
      fail('autonomous_research_pristine_schema_rebind_state_changed_during_finalize');
    }
    const finalizationRecordedState = Object.freeze({
      version: 1,
      kind: 'AutonomousResearchOnlineSchemaTransitionState',
      phase: plan.version === 2
        ? 'authority-target-configuration-restart-required'
        : 'finalization-recorded',
      plan,
      reserveRequest: active.reserveRequest,
      reservation: active.reservation,
      installations: active.installations,
      finalizeRequest: active.finalizeRequest,
      finalization,
      postPristineRuntimeStateHash: pristineAfterFinalize.pristineRuntimeStateHash,
    });
    writeAutonomousResearchOnlineSchemaTransitionJson(
      paths.activeStatePath,
      finalizationRecordedState,
    );
    if (plan.version === 2) {
      return autonomousResearchPristineSchemaRebindRestartRequiredReport(
        plan,
        finalization,
        active.installations,
      );
    }
    return completeAutonomousResearchOnlineSchemaTransitionExecution({
      authorityClient,
      clock,
      plan,
      paths,
      state: finalizationRecordedState,
      reserveRequest: active.reserveRequest,
      reservation: active.reservation,
      finalizeRequest: active.finalizeRequest,
      finalization,
      inventory,
      installations: active.installations,
      postPristineRuntimeStateHash: pristineAfterFinalize.pristineRuntimeStateHash,
      faultInjector,
    });
  }
  const reserveRequest = active.reserveRequest
    || buildAutonomousResearchOnlineSchemaTransitionReserveRequest(
      plan,
      schemaTransitionNow(clock).toISOString(),
    );
  if (active.reserveRequest && JSON.stringify(active.reserveRequest)
    !== JSON.stringify(buildAutonomousResearchOnlineSchemaTransitionReserveRequest(
      plan,
      active.reserveRequest.requestedAt,
    ))) {
    fail('autonomous_research_online_schema_transition_stored_reserve_request_invalid');
  }
  if (!active.reserveRequest) {
    writeAutonomousResearchOnlineSchemaTransitionJson(paths.activeStatePath, Object.freeze({
      version: 1,
      kind: 'AutonomousResearchOnlineSchemaTransitionState',
      phase: 'reserve-requested',
      plan,
      reserveRequest,
      installations: Object.freeze([]),
    }));
  }
  if (active.reservation && !authorityClient.verifyHistoricalReservation({
    receipt: active.reservation,
    request: reserveRequest,
  })) {
    fail('autonomous_research_online_schema_transition_stored_reservation_invalid');
  }
  const storedReservationCurrent = active.reservation
    ? authorityClient.verifyStoredReservation({
      receipt: active.reservation,
      request: reserveRequest,
      now: schemaTransitionNow(clock),
    }) === true
    : false;
  const reservation = storedReservationCurrent
    ? active.reservation
    : authorityClient.reserveSchemaTransition({
      request: reserveRequest,
      now: schemaTransitionNow(clock),
    });
  if (reserveRequest.transitionId !== plan.transitionId
    || typeof authorityClient.verifyStoredReservation !== 'function'
    || authorityClient.verifyStoredReservation({
      receipt: reservation,
      request: reserveRequest,
      now: schemaTransitionNow(clock),
    }) !== true) {
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
    ...(active.finalizeRequest ? { finalizeRequest: active.finalizeRequest } : {}),
    ...(active.postPristineRuntimeStateHash ? {
      postPristineRuntimeStateHash: active.postPristineRuntimeStateHash,
    } : {}),
  });
  writeAutonomousResearchOnlineSchemaTransitionJson(paths.activeStatePath, state);
  faultInjector?.({ point: 'after_reservation', completedCount: active.installations.length });
  const preNormalizationInventory = validateAutonomousResearchOnlineSchemaTransitionInventory({
    runtimeRoot,
    stateDatabaseManifest,
    inventory: resolveAutonomousResearchStateDatabaseInventory({
      runtimeRoot,
      manifest: stateDatabaseManifest,
    }),
  });
  const journalNormalizations = executeAutonomousResearchOnlineSchemaTransitionJournalNormalization({
    runtimeRoot,
    currentInventory: preNormalizationInventory,
    plan,
    reserveRequest,
    reservation,
    authorityClient,
    clock, faultInjector,
  });
  const normalizedState = Object.freeze({
    ...state,
    phase: 'journals-normalized',
    journalNormalizations,
  });
  writeAutonomousResearchOnlineSchemaTransitionJson(paths.activeStatePath, normalizedState);
  faultInjector?.({
    point: 'after_journal_normalization',
    completedCount: active.installations.length,
  });
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
    completedInstallations: active.installations,
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
    state: normalizedState,
    statePath: paths.activeStatePath,
    faultInjector,
  });
  const inventory = resolveAutonomousResearchOnlineSchemaTransitionPostInventory({
    runtimeRoot,
    stateDatabaseManifest,
    plan,
  });
  const pristineBeforeFinalize =
    resolveAutonomousResearchOnlineSchemaTransitionPristineState({
      runtimeRoot,
      inventory,
      plan,
      installations,
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
    postPristineRuntimeStateHash: pristineBeforeFinalize.pristineRuntimeStateHash,
    completedAt: active.finalizeRequest?.completedAt
      || schemaTransitionNow(clock).toISOString(),
  });
  if (active.finalizeRequest
    && JSON.stringify(active.finalizeRequest) !== JSON.stringify(finalizeRequest)) {
    fail('autonomous_research_online_schema_transition_stored_finalize_request_invalid');
  }
  const finalizeIntentState = Object.freeze({
    ...normalizedState,
    phase: 'finalization-requested',
    installations,
    finalizeRequest,
    postPristineRuntimeStateHash: pristineBeforeFinalize.pristineRuntimeStateHash,
  });
  if (!active.finalizeRequest) {
    writeAutonomousResearchOnlineSchemaTransitionJson(
      paths.activeStatePath,
      finalizeIntentState,
    );
  }
  const finalization = authorityClient.finalizeSchemaTransition({
    request: finalizeRequest,
    reservation,
    now: schemaTransitionNow(clock),
  });
  const pristineAfterFinalize =
    resolveAutonomousResearchOnlineSchemaTransitionPristineState({
      runtimeRoot,
      inventory,
      plan,
      installations,
    });
  if (pristineBeforeFinalize.pristineRuntimeStateHash
    !== pristineAfterFinalize.pristineRuntimeStateHash) {
    fail('autonomous_research_pristine_schema_rebind_state_changed_during_finalize');
  }
  faultInjector?.({ point: 'after_finalization', completedCount: installations.length });
  const finalizationRecordedState = Object.freeze({
    ...finalizeIntentState,
    phase: plan.version === 2
      ? 'authority-target-configuration-restart-required'
      : 'finalization-recorded',
    finalization,
    postPristineRuntimeStateHash: pristineAfterFinalize.pristineRuntimeStateHash,
  });
  writeAutonomousResearchOnlineSchemaTransitionJson(
    paths.activeStatePath,
    finalizationRecordedState,
  );
  if (plan.version === 2) {
    return autonomousResearchPristineSchemaRebindRestartRequiredReport(
      plan,
      finalization,
      installations,
    );
  }
  return completeAutonomousResearchOnlineSchemaTransitionExecution({
    authorityClient,
    clock,
    plan,
    paths,
    state: finalizationRecordedState,
    reserveRequest,
    reservation,
    finalizeRequest,
    finalization,
    inventory,
    installations,
    postPristineRuntimeStateHash: pristineAfterFinalize.pristineRuntimeStateHash,
    faultInjector,
  });
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
  const receipt = validateAutonomousResearchOnlineSchemaTransitionAuditReceipt({
    receipt: readAutonomousResearchOnlineSchemaTransitionJson(paths.finalReceiptPath),
    inventory,
    writerManifest: checkedWriterManifest,
    authorityClient,
  });
  const request = buildAutonomousResearchOnlineSchemaTransitionObserveRequest({
    plan: receipt.reserveRequest,
    finalization: receipt.finalization,
    postInventoryHash: inventory.inventoryHash,
    postPristineRuntimeStateHash: receipt.postPristineRuntimeStateHash,
    requestedAt: schemaTransitionNow(clock).toISOString(),
  });
  const observation = authorityClient.observeSchemaTransition({
    request,
    now: schemaTransitionNow(clock),
  });
  const base = Object.freeze({
    version: receipt.version,
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
