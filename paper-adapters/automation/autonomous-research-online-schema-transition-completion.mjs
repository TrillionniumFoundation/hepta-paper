import {
  buildAutonomousResearchOnlineSchemaTransitionAuditReceipt,
  buildAutonomousResearchOnlineSchemaTransitionObserveRequest,
} from './autonomous-research-online-schema-transition-state.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_SCHEMA_TRANSITION_PROTOCOL,
  AUTONOMOUS_RESEARCH_PRISTINE_SCHEMA_REBIND_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  writeAutonomousResearchOnlineSchemaTransitionJson,
} from './autonomous-research-online-schema-transition-state-repository.mjs';
import {
  schemaTransitionDatabasePath,
  schemaTransitionNow,
} from './autonomous-research-online-schema-transition-schema.mjs';
import {
  autonomousResearchPristineRuntimeStateHash,
  inspectAutonomousResearchPristineDatabaseState,
} from './autonomous-research-pristine-runtime-state.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function fail(code) {
  throw new Error(code);
}

export function validateAutonomousResearchOnlineSchemaTransitionAuditReceipt({
  receipt,
  inventory,
  writerManifest,
  authorityClient,
}) {
  const payload = Object.fromEntries(Object.entries(receipt || {}).filter(([key]) => (
    key !== 'schemaTransitionReceiptHash'
  )));
  if (![1, 2].includes(receipt?.version)
    || receipt.kind !== 'AutonomousResearchOnlineSchemaTransitionAuditReceipt'
    || receipt.status !== 'autonomous_research_online_schema_transition_ready'
    || receipt.protocol !== (receipt.version === 2
      ? AUTONOMOUS_RESEARCH_PRISTINE_SCHEMA_REBIND_PROTOCOL
      : AUTONOMOUS_RESEARCH_ONLINE_SCHEMA_TRANSITION_PROTOCOL)
    || receipt.databaseScopeHash !== inventory.databaseScopeHash
    || receipt.writerManifestHash
      !== autonomousResearchOnlineWriterOperationManifestHash(writerManifest)
    || receipt.postInventoryHash !== inventory.inventoryHash
    || !SHA256.test(String(receipt.postPristineRuntimeStateHash || ''))
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

export function completeAutonomousResearchOnlineSchemaTransitionExecution({
  authorityClient,
  clock,
  plan,
  paths,
  state,
  reserveRequest,
  reservation,
  finalizeRequest,
  finalization,
  inventory,
  installations,
  postPristineRuntimeStateHash,
  faultInjector = null,
}) {
  const requestedAt = state.observeRequest?.requestedAt
    || schemaTransitionNow(clock).toISOString();
  const observeRequest = buildAutonomousResearchOnlineSchemaTransitionObserveRequest({
    plan,
    finalization,
    postInventoryHash: inventory.inventoryHash,
    postPristineRuntimeStateHash,
    requestedAt,
    ...(state.observeRequest ? { nonce: state.observeRequest.nonce } : {}),
  });
  if (state.observeRequest
    && JSON.stringify(state.observeRequest) !== JSON.stringify(observeRequest)) {
    fail('autonomous_research_online_schema_transition_stored_observe_request_invalid');
  }
  const observationIntentState = Object.freeze({
    ...state,
    phase: 'observation-requested',
    installations,
    finalizeRequest,
    finalization,
    postPristineRuntimeStateHash,
    observeRequest,
  });
  if (!state.observeRequest) {
    writeAutonomousResearchOnlineSchemaTransitionJson(
      paths.activeStatePath,
      observationIntentState,
    );
  }
  const observation = state.observation || authorityClient.observeSchemaTransition({
    request: observeRequest,
    now: schemaTransitionNow(clock),
  });
  if (state.observation && !authorityClient.verifyHistoricalObservation({
    receipt: observation,
    request: observeRequest,
  })) {
    fail('autonomous_research_online_schema_transition_stored_observation_invalid');
  }
  faultInjector?.({ point: 'after_observation', completedCount: installations.length });
  const observedState = Object.freeze({
    ...observationIntentState,
    phase: 'observation-recorded',
    observation,
  });
  writeAutonomousResearchOnlineSchemaTransitionJson(paths.activeStatePath, observedState);
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
    ...observedState,
    phase: 'finalized',
    finalReceiptHash: receipt.schemaTransitionReceiptHash,
  }));
  return Object.freeze({
    version: plan.version,
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

export function autonomousResearchPristineSchemaRebindRestartRequiredReport(
  plan,
  finalization,
  installations,
) {
  return Object.freeze({
    version: 2,
    kind: 'AutonomousResearchOnlineSchemaTransitionExecutionReport',
    status:
      'autonomous_research_pristine_schema_rebind_target_configuration_restart_required',
    ready: false,
    transitionId: plan.transitionId,
    sourceWriterManifestHash: plan.sourceWriterManifestHash,
    targetWriterManifestHash: plan.writerManifestHash,
    targetAuthorityConfigurationHash: finalization.targetAuthorityConfigurationHash,
    installedDatabaseCount: installations.length,
    authorityDaemonRemainsAvailableForRecovery: true,
    reviewedProvisionerConfigurationActivationRequired: true,
    blockers: Object.freeze([
      'autonomous_research_pristine_schema_rebind_target_configuration_restart_required',
    ]),
  });
}

export function resolveAutonomousResearchOnlineSchemaTransitionPristineState({
  runtimeRoot,
  inventory,
  plan,
  installations,
}) {
  if (plan.version !== 2) {
    return Object.freeze({
      inspections: Object.freeze([]),
      pristineRuntimeStateHash: hashRecord(
        'AutonomousResearchInitialSchemaTransitionPristineStateNotApplicable',
        { transitionId: plan.transitionId },
      ),
    });
  }
  const installationById = new Map(installations.map((entry) => [
    entry.databaseInstanceId,
    entry,
  ]));
  const inspections = inventory.instances.map((instance) => {
    const installation = installationById.get(instance.instanceId);
    if (!installation || installation.postSchemaHash !== instance.schemaHash) {
      fail('autonomous_research_pristine_schema_rebind_installation_missing', {
        databaseInstanceId: instance.instanceId,
      });
    }
    const database = new DatabaseSync(
      schemaTransitionDatabasePath(runtimeRoot, instance),
      { readOnly: true },
    );
    try {
      const inspection = inspectAutonomousResearchPristineDatabaseState({
        database,
        databaseRole: instance.role,
        databaseInstanceId: instance.instanceId,
        schemaContractId: instance.schemaContractId,
        schemaHash: instance.schemaHash,
        stateDatabaseManifestHash: plan.stateDatabaseManifestHash,
        phase: 'post-rebind',
      });
      if (inspection.pristineStateHash !== installation.postPristineStateHash) {
        fail('autonomous_research_pristine_schema_rebind_post_state_changed', {
          databaseInstanceId: instance.instanceId,
        });
      }
      return inspection;
    } finally { database.close(); }
  });
  return Object.freeze({
    inspections: Object.freeze(inspections),
    pristineRuntimeStateHash: autonomousResearchPristineRuntimeStateHash(inspections),
  });
}
import { DatabaseSync } from 'node:sqlite';
