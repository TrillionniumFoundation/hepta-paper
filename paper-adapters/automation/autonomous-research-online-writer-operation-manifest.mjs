import path from 'node:path';

import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  assertAutonomousResearchOnlineWriterOperationManifest,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {
  AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_MUTATION_PLANS,
  AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_WRITER_ID,
  AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_WRITER_PLAN_HASH,
} from './autonomous-research-supervisor-instance-mutation-plan.mjs';
import {
  AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_MUTATION_PLANS,
  AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_WRITER_ID,
  AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_WRITER_PLAN_HASH,
} from './autonomous-research-runtime-refresh-mutation-plan.mjs';
import {
  AUTONOMOUS_RESEARCH_MACHINE_INTAKE_MUTATION_PLANS,
  AUTONOMOUS_RESEARCH_MACHINE_INTAKE_WRITER_ID,
  AUTONOMOUS_RESEARCH_MACHINE_INTAKE_WRITER_PLAN_HASH,
} from './autonomous-research-machine-intake-mutation-plan.mjs';
import {
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_MUTATION_PLANS,
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_WRITER_ID,
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_WRITER_PLAN_HASH,
} from './autonomous-research-topic-producer-mutation-plan.mjs';
import {
  AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_MUTATION_PLANS,
  AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_WRITER_ID,
  AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_WRITER_PLAN_HASH,
} from './autonomous-research-supervisor-state-mutation-plan.mjs';
import {
  RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_MUTATION_PLANS,
  RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_WRITER_ID,
  RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_WRITER_PLAN_HASH,
} from './runtime-image-reproducibility-publication-mutation-plan.mjs';
import {
  FULL_RESEARCH_QUALIFICATION_PUBLICATION_MUTATION_PLANS,
  FULL_RESEARCH_QUALIFICATION_PUBLICATION_WRITER_ID,
  FULL_RESEARCH_QUALIFICATION_PUBLICATION_WRITER_PLAN_HASH,
} from './full-research-qualification-publication-mutation-plan.mjs';
import {
  AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_MUTATION_PLANS,
  AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_WRITER_ID,
  AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_WRITER_PLAN_HASH,
} from './autonomous-research-qualification-state-mutation-plan.mjs';
import {
  AUTONOMOUS_RESEARCH_NATIVE_WRITER_PLAN_CATALOG,
} from './autonomous-research-native-writer-plan-catalog.mjs';
import {
  AUTONOMOUS_SUBMISSION_HANDOFF_MUTATION_PLANS,
  AUTONOMOUS_SUBMISSION_HANDOFF_WRITER_ID,
  AUTONOMOUS_SUBMISSION_HANDOFF_WRITER_PLAN_HASH,
} from '../persistence/autonomous-submission-handoff-mutation-plan.mjs';

const {
  campaign: {
    mutationPlans: NATIVE_STORE_CAMPAIGN_MUTATION_PLANS,
    writerId: NATIVE_STORE_CAMPAIGN_WRITER_ID,
    writerPlanHash: NATIVE_STORE_CAMPAIGN_WRITER_PLAN_HASH,
  },
  ledger: {
    mutationPlans: NATIVE_STORE_LEDGER_MUTATION_PLANS,
    writerId: NATIVE_STORE_LEDGER_WRITER_ID,
    writerPlanHash: NATIVE_STORE_LEDGER_WRITER_PLAN_HASH,
  },
  resourceWorkspace: {
    mutationPlans: NATIVE_STORE_RESOURCE_WORKSPACE_MUTATION_PLANS,
    writerId: NATIVE_STORE_RESOURCE_WORKSPACE_WRITER_ID,
    writerPlanHash: NATIVE_STORE_RESOURCE_WORKSPACE_WRITER_PLAN_HASH,
  },
  telemetry: {
    mutationPlans: NATIVE_STORE_CAMPAIGN_TELEMETRY_MUTATION_PLANS,
    writerId: NATIVE_STORE_CAMPAIGN_TELEMETRY_WRITER_ID,
    writerPlanHash: NATIVE_STORE_CAMPAIGN_TELEMETRY_WRITER_PLAN_HASH,
  },
  reconciliation: {
    mutationPlans: NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_MUTATION_PLANS,
    writerId: NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_WRITER_ID,
    writerPlanHash: NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_WRITER_PLAN_HASH,
  },
  qualityRelease: {
    mutationPlans: NATIVE_STORE_QUALITY_RELEASE_MUTATION_PLANS,
    writerId: NATIVE_STORE_QUALITY_RELEASE_WRITER_ID,
    writerPlanHash: NATIVE_STORE_QUALITY_RELEASE_WRITER_PLAN_HASH,
  },
  submissionDelivery: {
    mutationPlans: NATIVE_STORE_SUBMISSION_DELIVERY_MUTATION_PLANS,
    writerId: NATIVE_STORE_SUBMISSION_DELIVERY_WRITER_ID,
    writerPlanHash: NATIVE_STORE_SUBMISSION_DELIVERY_WRITER_PLAN_HASH,
  },
} = AUTONOMOUS_RESEARCH_NATIVE_WRITER_PLAN_CATALOG;

function group(
  databaseRole,
  sourceFile,
  entrypoints,
  mutationClass = null,
  operationComponent = null,
) {
  return Object.freeze({
    databaseRole,
    sourceFile,
    entrypoints,
    mutationClass,
    operationComponent,
  });
}

const GROUPS = Object.freeze([
  group('native-store', 'paper-adapters/persistence/sqlite-store.mjs', [
    'openDatabase',
  ], 'schema-or-genesis-ddl'),
  group('native-store', 'paper-adapters/persistence/store-provider.mjs', [
    'applyStoreMigrations', 'createDefaultPaperStore', 'openExistingWritablePaperStore',
  ], 'schema-or-genesis-ddl'),
  group('native-store', 'paper-adapters/automation/automation-runtime-reconciler.mjs', [
    'executeAutomationRuntimeReconciliation',
  ]),
  group('native-store', 'paper-adapters/automation/sqlite-resource-governor.mjs', [
    'createSqliteResourceGovernor', 'reapDeadOwners', 'acquire',
    'renewLeaseHeartbeat', 'release',
  ]),
  group('native-store', 'paper-adapters/automation/theorem-quality-revision-sink.mjs', [
    'moduleSchemaProvisioning', 'record',
  ]),
  group('native-store', 'paper-adapters/automation/workspace-registry.mjs', [
    'register', 'transition', 'recordSnapshot', 'qualifyForRetention',
  ]),
  group('native-store', 'paper-adapters/persistence/legacy-history-translator-repository.mjs', [
    'persistLegacyNativeTranslations',
  ], 'cross-database-maintenance'),
  group('native-store', 'paper-adapters/persistence/sqlite-campaign-lifecycle-operations.mjs', [
    'createCampaign', 'skipFutureRounds', 'pauseCampaign', 'resumeCampaign',
    'extendCampaign', 'cancelCampaign',
  ], null, 'campaign-lifecycle'),
  group('native-store', 'paper-adapters/persistence/sqlite-campaign-lifecycle-terminal-operations.mjs', [
    'cancelNode', 'retryNode', 'recordUsage', 'failCampaign', 'stopCampaign',
  ], null, 'campaign-lifecycle'),
  group('native-store', 'paper-adapters/persistence/sqlite-campaign-lease-operations.mjs', [
    'recoverExpiredLeases', 'renewNodeLease', 'claimReady',
  ], 'lease-or-budget-dml', 'campaign-lease'),
  group('native-store', 'paper-adapters/persistence/sqlite-campaign-node-attempt-operations.mjs', [
    'startNode', 'failNode',
  ], 'lease-or-budget-dml', 'campaign-lease'),
  group('native-store', 'paper-adapters/persistence/sqlite-campaign-node-infrastructure-operations.mjs', [
    'cancelNodeInfrastructureDeferred', 'reserveNodeInfrastructureUsage',
  ], 'lease-or-budget-dml', 'campaign-lease'),
  group('native-store', 'paper-adapters/persistence/sqlite-campaign-node-external-action-operations.mjs', [
    'markNodeExternalActionStarted', 'completeNodeExternalAction',
  ], 'lease-or-budget-dml', 'campaign-lease'),
  group('native-store', 'paper-adapters/persistence/sqlite-campaign-prepared-integration-operations.mjs', [
    'prepareNodeResult', 'beginNodeResultIntegration', 'markNodeResultIntegrated',
    'completeNode',
  ], null, 'campaign-prepared-integration'),
  group('native-store', 'paper-adapters/persistence/sqlite-campaign-telemetry-operations.mjs', [
    'recordTelemetry',
  ]),
  group('native-store', 'paper-adapters/persistence/sqlite-campaign-release-authority-repository.mjs', [
    'promoteCompletedRelease',
  ]),
  group('native-store', 'paper-adapters/persistence/sqlite-campaign-store.mjs', [
    'assertLiveNodeAttempt',
  ]),
  group('native-store', 'paper-adapters/persistence/sqlite-job-receipt-store.mjs', [
    'createJob', 'acquireLease', 'recordAttempt',
    'renewAttemptLease', 'completeJob', 'failJob',
  ]),
  group('native-store', 'paper-adapters/persistence/sqlite-receipt-ledger.mjs', [
    'record',
  ]),
  group('native-store', 'paper-adapters/persistence/sqlite-receipt-ledger-qualification.mjs', [
    'qualify',
  ]),
  group('native-store', 'paper-adapters/persistence/sqlite-workflow-state-store.mjs', [
    'put',
  ]),
  group('native-store', 'paper-adapters/submission/sqlite-delivery-outbox-operations.mjs', [
    'enqueueAuthorized', 'enqueue', 'registerProviderCapability', 'claimPending',
    'heartbeatClaim', 'acquireReleaseLock', 'recoverPending',
  ]),
  group('native-store', 'paper-adapters/automation/autonomous-submission-outbox-repository.mjs', [
    'prepareAutonomousSubmission', 'beginAutonomousSubmissionAttempt',
    'recordAutonomousSubmissionOutcome',
  ], null, 'delivery-outbox-operations'),
  group('submission-handoff', 'paper-adapters/automation/autonomous-submission-outbox-repository.mjs', [
    'prepareAutonomousSubmission', 'beginAutonomousSubmissionAttempt',
    'recordAutonomousSubmissionOutcome',
  ], null, 'delivery-outbox-operations'),
  group('native-store', 'paper-adapters/submission/sqlite-delivery-response-operations.mjs', [
    'recordResponse', 'quarantineInvalidIntake',
  ]),
  group('native-store', 'paper-adapters/submission/sqlite-delivery-redrive-operations.mjs', [
    'scheduleRedrive', 'reviewAmbiguousResult', 'enqueueRedrive', 'deadLetter',
  ]),
  group('native-store', 'paper-adapters/submission/sqlite-delivery-consumption-operations.mjs', [
    'release', 'advanceResponseCursor', 'claimNextResponse', 'completeResponseConsumption',
  ]),
  group('native-store', 'paper-core/bin/runtime-hygiene.mjs', [
    'moduleSchemaProvisioning',
  ]),
  group('native-store', 'paper-core/bin/hepta-store.mjs', [
    'moduleSchemaProvisioning',
  ], 'schema-or-genesis-ddl'),
  group('native-store', 'paper-core/bin/hepta-store.mjs', [
    'runSql', 'initialize', 'backup', 'restoreDrill',
  ], 'cross-database-maintenance'),
  group('machine-intake', 'paper-adapters/automation/autonomous-research-machine-intake-repository-open.mjs', [
    'openAutonomousResearchMachineIntakeRepository',
  ], 'schema-or-genesis-ddl'),
  group('machine-intake', 'paper-adapters/automation/autonomous-research-machine-intake-repository-support.mjs', [
    'createMachineIntakeSchema', 'migrateLegacyMachineIntakeSchema',
  ], 'schema-or-genesis-ddl'),
  group('machine-intake', 'paper-adapters/automation/autonomous-research-machine-intake-authority.mjs', [
    'bindMachineIntakeAuthorityGenesis', 'bindConfiguredSourceAuthorityHash',
    'bindAuthorizedMachineProducerProfileHash',
  ], 'schema-or-genesis-ddl'),
  group('machine-intake', 'paper-adapters/automation/autonomous-research-machine-intake-repository.mjs', [
    'appendIntake',
    'tryAcquireIntakeLease', 'renewIntakeLease', 'releaseIntakeLease', 'deferIntake',
    'markIntakeEnqueued', 'markEnqueuedIntakeInvalid', 'reconcileExpiredIntakeLeases',
  ]),
  group('machine-intake', 'paper-adapters/automation/autonomous-research-machine-intake-repository.mjs', [
    'createAutonomousResearchMachineIntakeRepository',
  ], 'schema-or-genesis-ddl'),
  group('machine-intake', 'paper-adapters/automation/autonomous-research-machine-intake-authority-rotation.mjs', [
    'applyRotation', 'applyAutonomousResearchMachineIntakeAuthorityRotation',
  ], 'cross-database-maintenance'),
  group('machine-intake', 'paper-adapters/automation/autonomous-research-machine-intake-authority-rotation-state.mjs', [
    'attachExisting',
  ], 'cross-database-maintenance'),
  group('topic-producer', 'paper-adapters/automation/autonomous-research-topic-producer-repository-support.mjs', [
    'markLegacyOutstandingProviderCanaries', 'createTopicProducerSchema',
  ], 'schema-or-genesis-ddl'),
  group('topic-producer', 'paper-adapters/automation/autonomous-research-topic-producer-repository.mjs', [
    'createAutonomousResearchTopicProducerRepository',
  ], 'schema-or-genesis-ddl'),
  group('topic-producer', 'paper-adapters/automation/autonomous-research-topic-producer-repository.mjs', [
    'completeGeneration', 'issueAppendAuthorization', 'prepareGeneration',
    'recoverCommittedGeneration',
  ]),
  group('topic-producer', 'paper-adapters/automation/autonomous-research-topic-producer-lease-operations.mjs', [
    'tryAcquireLease', 'renewLease', 'releaseLease',
  ], null, 'topic-producer-repository'),
  group('topic-producer', 'paper-adapters/automation/autonomous-research-topic-producer-canary-journal-operations.mjs', [
    'beginProviderCanaryAction', 'finishProviderCanaryAction', 'failGeneration',
  ], null, 'topic-producer-repository'),
  group('supervisor-state', 'paper-adapters/automation/autonomous-research-supervisor-state-repository.mjs', [
    'createAutonomousResearchSupervisorStateRepository',
  ], 'schema-or-genesis-ddl'),
  group('supervisor-state', 'paper-adapters/automation/autonomous-research-supervisor-state-repository.mjs', [
    'registerCampaign',
    'reconcileStaleLeases', 'tryAcquireCampaignLease', 'renewCampaignLease',
    'releaseCampaignLease', 'resolveExternalActionRecovery',
  ]),
  group('supervisor-state', 'paper-adapters/automation/autonomous-research-supervisor-dispatch-state-operations.mjs', [
    'beginDispatch', 'markDispatchStarted', 'cancelDispatchInfrastructureDeferred',
    'finishDispatch', 'finishDispatchFailureFallback',
  ], null, 'supervisor-state-repository'),
  group('supervisor-state', 'paper-adapters/automation/autonomous-research-supervisor-external-action-journal-storage.mjs', [
    'installAutonomousResearchSupervisorExternalActionJournalSchema',
  ], 'schema-or-genesis-ddl', 'supervisor-external-action-repository-support'),
  group('supervisor-state', 'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs', [
    'beginExternalActionAttempt', 'cancelInfrastructureDeferred',
    'finishExternalActionAttempt',
    'recordExternalActionProgress',
  ]),
  group('supervisor-state', 'paper-adapters/automation/autonomous-research-supervisor-provider-canary-state-operations.mjs', [
    'beginProviderCanary', 'cancelProviderCanaryInfrastructureDeferred',
    'finishProviderCanary',
  ]),
  group('resident-instance', 'paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs', [
    'createAutonomousResearchSupervisorInstanceRepository',
  ], 'schema-or-genesis-ddl'),
  group('resident-instance', 'paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs', [
    'acquireInstanceLease',
    'markStartupReconciled', 'markMachineIntakeReconciled',
    'markMachineIntakeReconciliationFailed', 'heartbeatInstanceLease',
    'releaseInstanceLease',
  ]),
  group('runtime-reproducibility-refresh', 'paper-adapters/automation/autonomous-research-runtime-refresh-state-repository.mjs', [
    'createAutonomousResearchRuntimeRefreshStateRepository',
  ], 'schema-or-genesis-ddl'),
  group('runtime-reproducibility-refresh', 'paper-adapters/automation/autonomous-research-runtime-refresh-state-repository.mjs', [
    'reconcileStaleRefreshLease', 'tryAcquireRefreshLease', 'renewRefreshLease',
    'releaseRefreshLease', 'reserveRefreshAttempt', 'completeRefreshAttempt',
    'failRefreshAttempt',
  ]),
  group('external-qualification', 'paper-adapters/automation/autonomous-research-qualification-state-repository.mjs', [
    'createAutonomousResearchQualificationStateRepository',
  ], 'schema-or-genesis-ddl'),
  group('external-qualification', 'paper-adapters/automation/autonomous-research-qualification-state-repository.mjs', [
    'compareAndSwapExternalQualificationState',
    'tryAcquireQualificationAttemptLease',
    'renewQualificationAttemptLease', 'releaseQualificationAttemptLease',
    'reconcileStaleQualificationAttemptLease',
  ]),
  group('external-qualification', 'paper-adapters/automation/autonomous-research-qualification-attempt-infrastructure-operations.mjs', [
    'markQualificationAttemptExternalActionStarted',
    'cancelQualificationAttemptInfrastructureDeferred',
    'reconcileStaleQualificationAttemptReservation',
  ], null, 'qualification-state-repository'),
  group('runtime-reproducibility-publication', 'paper-adapters/automation/runtime-image-reproducibility-receipt-repository.mjs', [
    'ensureSchema', 'openWritableDatabase', 'provisionDatabase',
  ], 'schema-or-genesis-ddl', 'receipt-repository'),
  group('runtime-reproducibility-publication', 'paper-adapters/automation/runtime-image-reproducibility-receipt-repository.mjs', [
    'publish',
  ], 'publication-dml', 'receipt-repository'),
  group('runtime-reproducibility-publication', 'paper-adapters/automation/runtime-image-reproducibility-receipt-repository.mjs', [
    'recoverPendingPublication',
  ], 'cross-database-maintenance', 'receipt-repository'),
  group('full-research-qualification-publication', 'paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs', [
    'writableDatabase', 'provisionDatabase',
  ], 'schema-or-genesis-ddl', 'receipt-pointer-repository'),
  group('full-research-qualification-publication', 'paper-adapters/automation/full-research-qualification-receipt-pointer-repository-support.mjs', [
    'ensureSchema',
  ], 'schema-or-genesis-ddl', 'receipt-pointer-repository'),
  group('full-research-qualification-publication', 'paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs', [
    'tryAcquirePublicationLease', 'renewPublicationLease', 'releasePublicationLease',
    'publish',
  ], 'publication-dml', 'receipt-pointer-repository'),
  group('full-research-qualification-publication', 'paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs', [
    'recoverPendingPublication',
  ], 'cross-database-maintenance', 'receipt-pointer-repository'),
  group('machine-intake', 'paper-composition/automation/autonomous-research-machine-intake-composition.mjs', [
    'composeAutonomousResearchMachineIntakePlane',
  ], 'schema-or-genesis-ddl'),
  group('supervisor-state', 'paper-composition/automation/autonomous-research-supervisor-composition.mjs', [
    'composeAutonomousResearchSupervisor',
  ], 'schema-or-genesis-ddl'),
  group('native-store', 'paper-core/bin/automation-reconcile.mjs', [
    'moduleSchemaProvisioning',
  ], 'cross-database-maintenance'),
  group('native-store', 'paper-core/bin/hepta-store.mjs', [
    'writableStore',
  ], 'cross-database-maintenance'),
  group('native-store', 'paper-core/bin/repair-receipt-ledger-integrity.mjs', [
    'moduleSchemaProvisioning',
  ], 'cross-database-maintenance'),
  group('native-store', 'paper-adapters/automation/autonomous-research-state-backup-journal-replay.mjs', [
    'drillDatabaseCopiesWithReplay',
    'insertReplayedAuthorityRecords',
  ], 'cross-database-maintenance', 'state-backup-repository'),
  ...Object.freeze([
    '001_initial', '002_runtime_ledger', '003_evidence_isolation',
    '004_automation_campaigns', '005_automation_operations',
    '006_multiprocess_automation', '007_campaign_lineage_backfill',
    '008_reviewer_identity_backfill', '009_resource_admission_queue',
    '010_resource_admission_metadata', '011_workspace_lineage',
    '012_schema_metadata_consistency', '013_campaign_telemetry',
    '014_legacy_native_lineage', '015_submission_boundary_hardening',
    '016_submission_delivery_leases', '017_trusted_evidence_and_response_consumption',
    '018_append_only_receipt_ledger', '019_effective_receipt_ledger',
    '020_monotonic_receipt_qualification', '021_job_lease_fencing',
    '022_campaign_attempt_fencing', '023_workspace_retention_qualification',
    '024_submission_outbox_delivery_kind',
    '025_external_autonomous_submission_handoff',
  ].map((migration) => group(
    'native-store',
    `store/migrations/${migration}.sql`,
    [`migration${migration}`],
    'schema-or-genesis-ddl',
  ))),
]);

function defaultMutationClass(entrypoint) {
  if (/schema|open|migration|ensure/i.test(entrypoint)) return 'schema-or-genesis-ddl';
  if (/lease|budget|attempt|canary|heartbeat|reconcil|acquire|renew|release|recover|claim/i.test(entrypoint)) {
    return 'lease-or-budget-dml';
  }
  return 'business-dml';
}

function componentName(sourceFile) {
  return path.basename(sourceFile).replace(/\.(?:mjs|sql)$/, '')
    .replace(/^autonomous-research-/, '')
    .replace(/^sqlite-/, '');
}

const residentOperationIds = Object.freeze(
  Object.keys(AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_MUTATION_PLANS).sort(),
);
const runtimeRefreshOperationIds = Object.freeze(
  Object.keys(AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_MUTATION_PLANS).sort(),
);
const machineIntakeOperationIds = Object.freeze(
  Object.keys(AUTONOMOUS_RESEARCH_MACHINE_INTAKE_MUTATION_PLANS).sort(),
);
const topicProducerOperationIds = Object.freeze(
  Object.keys(AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_MUTATION_PLANS).sort(),
);
const supervisorStateOperationIds = Object.freeze(
  Object.keys(AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_MUTATION_PLANS).sort(),
);
const runtimePublicationOperationIds = Object.freeze(
  Object.keys(RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_MUTATION_PLANS).sort(),
);
const fullQualificationPublicationOperationIds = Object.freeze(
  Object.keys(FULL_RESEARCH_QUALIFICATION_PUBLICATION_MUTATION_PLANS).sort(),
);
const externalQualificationOperationIds = Object.freeze(
  Object.keys(AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_MUTATION_PLANS).sort(),
);
const nativeStoreCampaignOperationIds = Object.freeze(
  Object.keys(NATIVE_STORE_CAMPAIGN_MUTATION_PLANS).sort(),
);
const nativeStoreLedgerOperationIds = Object.freeze(
  Object.keys(NATIVE_STORE_LEDGER_MUTATION_PLANS).sort(),
);
const nativeStoreResourceWorkspaceOperationIds = Object.freeze(
  Object.keys(NATIVE_STORE_RESOURCE_WORKSPACE_MUTATION_PLANS).sort(),
);
const nativeStoreTelemetryOperationIds = Object.freeze(
  Object.keys(NATIVE_STORE_CAMPAIGN_TELEMETRY_MUTATION_PLANS).sort(),
);
const nativeStoreReconciliationOperationIds = Object.freeze(
  Object.keys(NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_MUTATION_PLANS).sort(),
);
const nativeStoreQualityReleaseOperationIds = Object.freeze(
  Object.keys(NATIVE_STORE_QUALITY_RELEASE_MUTATION_PLANS).sort(),
);
const nativeStoreSubmissionOperationIds = Object.freeze(
  Object.keys(NATIVE_STORE_SUBMISSION_DELIVERY_MUTATION_PLANS).sort(),
);
const submissionHandoffOperationIds = Object.freeze(
  Object.keys(AUTONOMOUS_SUBMISSION_HANDOFF_MUTATION_PLANS).sort(),
);
const integratedOperationIds = new Set([
  ...residentOperationIds,
  ...runtimeRefreshOperationIds,
  ...machineIntakeOperationIds,
  ...topicProducerOperationIds,
  ...supervisorStateOperationIds,
  ...runtimePublicationOperationIds,
  ...fullQualificationPublicationOperationIds,
  ...externalQualificationOperationIds,
  ...nativeStoreCampaignOperationIds,
  ...nativeStoreLedgerOperationIds,
  ...nativeStoreResourceWorkspaceOperationIds,
  ...nativeStoreTelemetryOperationIds,
  ...nativeStoreReconciliationOperationIds,
  ...nativeStoreQualityReleaseOperationIds,
  ...nativeStoreSubmissionOperationIds,
  ...submissionHandoffOperationIds,
]);

const operations = Object.freeze(GROUPS.flatMap((source) => (
  source.entrypoints.map((entrypoint) => {
    const operationId =
      `${source.databaseRole}.${source.operationComponent
        || componentName(source.sourceFile)}.${entrypoint}.v1`;
    const coordinatorIntegrated = integratedOperationIds.has(operationId);
    return Object.freeze({
      operationId,
      databaseRole: source.databaseRole,
      sourceFile: source.sourceFile,
      entrypoint,
      mutationClass: source.mutationClass || defaultMutationClass(entrypoint),
      protocolStatus: coordinatorIntegrated
        ? AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS
        : AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS,
      coordinatorIntegrated,
    });
  })
)));

const writers = Object.freeze([
  Object.freeze({
    writerId: NATIVE_STORE_CAMPAIGN_WRITER_ID,
    databaseRoles: Object.freeze(['native-store']),
    operationIds: nativeStoreCampaignOperationIds,
    implementationHash: NATIVE_STORE_CAMPAIGN_WRITER_PLAN_HASH,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  }),
  Object.freeze({
    writerId: NATIVE_STORE_LEDGER_WRITER_ID,
    databaseRoles: Object.freeze(['native-store']),
    operationIds: nativeStoreLedgerOperationIds,
    implementationHash: NATIVE_STORE_LEDGER_WRITER_PLAN_HASH,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  }),
  Object.freeze({
    writerId: NATIVE_STORE_RESOURCE_WORKSPACE_WRITER_ID,
    databaseRoles: Object.freeze(['native-store']),
    operationIds: nativeStoreResourceWorkspaceOperationIds,
    implementationHash: NATIVE_STORE_RESOURCE_WORKSPACE_WRITER_PLAN_HASH,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  }),
  Object.freeze({
    writerId: NATIVE_STORE_CAMPAIGN_TELEMETRY_WRITER_ID,
    databaseRoles: Object.freeze(['native-store']),
    operationIds: nativeStoreTelemetryOperationIds,
    implementationHash: NATIVE_STORE_CAMPAIGN_TELEMETRY_WRITER_PLAN_HASH,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  }),
  Object.freeze({
    writerId: NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_WRITER_ID,
    databaseRoles: Object.freeze(['native-store']),
    operationIds: nativeStoreReconciliationOperationIds,
    implementationHash:
      NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_WRITER_PLAN_HASH,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  }),
  Object.freeze({
    writerId: NATIVE_STORE_QUALITY_RELEASE_WRITER_ID,
    databaseRoles: Object.freeze(['native-store']),
    operationIds: nativeStoreQualityReleaseOperationIds,
    implementationHash: NATIVE_STORE_QUALITY_RELEASE_WRITER_PLAN_HASH,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  }),
  Object.freeze({
    writerId: NATIVE_STORE_SUBMISSION_DELIVERY_WRITER_ID,
    databaseRoles: Object.freeze(['native-store']),
    operationIds: nativeStoreSubmissionOperationIds,
    implementationHash: NATIVE_STORE_SUBMISSION_DELIVERY_WRITER_PLAN_HASH,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  }),
  Object.freeze({
    writerId: AUTONOMOUS_SUBMISSION_HANDOFF_WRITER_ID,
    databaseRoles: Object.freeze(['submission-handoff']),
    operationIds: submissionHandoffOperationIds,
    implementationHash: AUTONOMOUS_SUBMISSION_HANDOFF_WRITER_PLAN_HASH,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  }),
  Object.freeze({
    writerId: AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_WRITER_ID,
    databaseRoles: Object.freeze(['resident-instance']),
    operationIds: residentOperationIds,
    implementationHash: AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_WRITER_PLAN_HASH,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  }),
  Object.freeze({
    writerId: AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_WRITER_ID,
    databaseRoles: Object.freeze(['runtime-reproducibility-refresh']),
    operationIds: runtimeRefreshOperationIds,
    implementationHash: AUTONOMOUS_RESEARCH_RUNTIME_REFRESH_WRITER_PLAN_HASH,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  }),
  Object.freeze({
    writerId: AUTONOMOUS_RESEARCH_MACHINE_INTAKE_WRITER_ID,
    databaseRoles: Object.freeze(['machine-intake']),
    operationIds: machineIntakeOperationIds,
    implementationHash: AUTONOMOUS_RESEARCH_MACHINE_INTAKE_WRITER_PLAN_HASH,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  }),
  Object.freeze({
    writerId: AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_WRITER_ID,
    databaseRoles: Object.freeze(['topic-producer']),
    operationIds: topicProducerOperationIds,
    implementationHash: AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_WRITER_PLAN_HASH,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  }),
  Object.freeze({
    writerId: AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_WRITER_ID,
    databaseRoles: Object.freeze(['supervisor-state']),
    operationIds: supervisorStateOperationIds,
    implementationHash: AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_WRITER_PLAN_HASH,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  }),
  Object.freeze({
    writerId: RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_WRITER_ID,
    databaseRoles: Object.freeze(['runtime-reproducibility-publication']),
    operationIds: runtimePublicationOperationIds,
    implementationHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_WRITER_PLAN_HASH,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  }),
  Object.freeze({
    writerId: FULL_RESEARCH_QUALIFICATION_PUBLICATION_WRITER_ID,
    databaseRoles: Object.freeze(['full-research-qualification-publication']),
    operationIds: fullQualificationPublicationOperationIds,
    implementationHash:
      FULL_RESEARCH_QUALIFICATION_PUBLICATION_WRITER_PLAN_HASH,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  }),
  Object.freeze({
    writerId: AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_WRITER_ID,
    databaseRoles: Object.freeze(['external-qualification']),
    operationIds: externalQualificationOperationIds,
    implementationHash: AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_WRITER_PLAN_HASH,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  }),
]);
const coveredDatabaseRoles = Object.freeze([
  ...new Set(writers.flatMap((writer) => writer.databaseRoles)),
].sort());
const coverage = Object.freeze({
  requiredRoleCount: AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length,
  coveredRoleCount: coveredDatabaseRoles.length,
  coveredDatabaseRoles,
  percent: Number((coveredDatabaseRoles.length * 100
    / AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length).toFixed(2)),
});

export const AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST = Object.freeze(
  assertAutonomousResearchOnlineWriterOperationManifest({
    version: 1,
    kind: AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND,
    manifestId: 'hepta-paper-autonomous-research-online-writer-operations-v1',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    requiredDatabaseRoles: Object.freeze([...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort()),
    writers,
    operations,
    coverage,
  }),
);
