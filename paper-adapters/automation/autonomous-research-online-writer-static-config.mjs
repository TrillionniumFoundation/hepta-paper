// Static allowlists and scan configuration for the online writer coverage gate.
const APPLICATION_ROOT = 'paper-application';

export const MUTATION_SQL = /(?:\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE\s+(?:TABLE|TRIGGER|INDEX|VIEW)|ALTER\s+TABLE|DROP\s+(?:TABLE|TRIGGER|INDEX|VIEW)|VACUUM\s+INTO)\b|\bPRAGMA\s+(?:journal_mode|user_version|application_id)\s*=)/i;
export const SQL_CALLS = new Set(['exec', 'execute', 'prepare', 'query', 'queryRows', 'run']);
export const MUTATION_CAPABILITY_METHODS = new Set([
  ...SQL_CALLS,
  'transaction',
]);
export const SCAN_ROOTS = Object.freeze([
  'paper-adapters',
  'paper-application',
  'paper-composition',
  'paper-core/bin',
]);
export const PROVENANCE_ONLY_SOURCES = new Set([
  'paper-adapters/automation/agent-research-agenda-producer.mjs',
  'paper-adapters/automation/agent-research-content-producer.mjs',
  'paper-adapters/automation/autonomous-research-online-authority-evidence-cache.mjs',
  'paper-adapters/automation/autonomous-research-online-authority-evidence-cache-repository.mjs',
  'paper-adapters/automation/autonomous-research-online-authority-evidence-renewal.mjs',
  'paper-adapters/automation/autonomous-research-online-mutation-startup-reconciliation.mjs',
  'paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs',
  'paper-adapters/automation/autonomous-research-online-writer-static-callback-boundary.mjs',
  'paper-adapters/automation/autonomous-research-online-writer-static-config.mjs',
  'paper-adapters/automation/autonomous-research-online-writer-static-discovery.mjs',
  'paper-adapters/automation/autonomous-research-online-writer-static-inspection.mjs',
  'paper-adapters/automation/autonomous-research-public-deployment-identity-readers.mjs',
  'paper-adapters/automation/autonomous-research-qualification-attempt-infrastructure-operations.mjs',
  'paper-adapters/automation/autonomous-research-state-backup-authority.mjs',
  'paper-adapters/automation/autonomous-research-state-backup-journal-replay.mjs',
  'paper-adapters/automation/autonomous-research-state-backup-repository.mjs',
  'paper-adapters/automation/autonomous-research-state-backup-source-inspection.mjs',
  'paper-adapters/automation/autonomous-research-state-backup-source-operations.mjs',
  'paper-adapters/automation/autonomous-research-state-database-inventory.mjs',
  'paper-adapters/automation/autonomous-research-state-reconciliation-database.mjs',
  'paper-adapters/automation/autonomous-research-state-restore-receipt-validation.mjs',
  'paper-adapters/automation/campaign-external-research-replay.mjs',
  'paper-adapters/automation/campaign-release-primitives-adapter.mjs',
  'paper-adapters/automation/campaign-research-verifier.mjs',
  'paper-adapters/automation/external-research-qualification-process-adapter.mjs',
  'paper-adapters/automation/external-research-qualification-process-identity.mjs',
  'paper-adapters/automation/externally-fenced-sqlite-mutation-coordinator-validation.mjs',
  'paper-adapters/automation/isolated-agent-executor.mjs',
  'paper-adapters/automation/reviewer-principal-executor-pool.mjs',
  'paper-adapters/automation/reviewer-principal-pool-configuration-reader.mjs',
  'paper-adapters/automation/runtime-image-reproducibility-process-identity.mjs',
  'paper-adapters/build-package/research-execution-release-attestor-configuration.mjs',
  'paper-adapters/build-package/research-execution-release-attestor.mjs',
  'paper-adapters/build-package/research-evidence-capsule-attestation.mjs',
  'paper-adapters/build-package/research-evidence-capsule.mjs',
  'paper-adapters/persistence/native-store-campaign-parameter-projection.mjs',
  `${APPLICATION_ROOT}/automation/autonomous-research-campaign-submission.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-research-campaign.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-research-machine-intake-supervision.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-research-online-authority-evidence-renewal-controller.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-research-qualification-renewal.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-research-readiness.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-research-readiness-generation.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-research-resident-lifecycle.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-research-resident-reactivation-required.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-research-state-backup-renewal.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-research-state-reconcile-and-renew.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-research-state-recoverability-controller.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-research-submission-recovery.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-research-supervisor-autonomy-fence.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-research-supervisor-campaign-processor.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-research-supervisor-provider-canary-dispatch.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-research-supervisor-submission-recovery.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-research-supervisor.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-research-topic-producer-live-authority.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-research-topic-producer.mjs`,
  `${APPLICATION_ROOT}/automation/autonomous-submission-delivery.mjs`,
  `${APPLICATION_ROOT}/automation/campaign-empirical-cell-budget.mjs`,
  `${APPLICATION_ROOT}/automation/campaign-engine.mjs`,
  `${APPLICATION_ROOT}/automation/campaign-nested-agent-runner.mjs`,
  `${APPLICATION_ROOT}/automation/campaign-node-infrastructure-control.mjs`,
  `${APPLICATION_ROOT}/automation/external-qualification-recovery.mjs`,
  `${APPLICATION_ROOT}/automation/external-qualification-recovery-support.mjs`,
  'paper-composition/automation/autonomous-research-campaign-external-side-effect-composition.mjs',
  'paper-composition/automation/autonomous-research-provider-canary.mjs',
  'paper-composition/automation/autonomous-research-qualification-context.mjs',
  'paper-composition/automation/autonomous-research-readiness-composition.mjs',
  'paper-composition/automation/autonomous-research-resident-deployment-identity.mjs',
  'paper-composition/automation/autonomous-research-state-safety-inspection.mjs',
  'paper-composition/automation/autonomous-research-submission-composition.mjs',
  'paper-composition/automation/autonomous-research-supervisor-composition.mjs',
  'paper-composition/automation/autonomous-research-supervisor-external-action-composition.mjs',
  'paper-composition/automation/autonomous-research-supervisor-prerequisites.mjs',
  'paper-composition/automation/campaign-worker-composition.mjs',
  'paper-composition/automation/reviewer-principal-pool-composition.mjs',
  'paper-composition/bootstrap/autonomous-research-online-mutation-composition.mjs',
  'paper-composition/bootstrap/autonomous-research-state-backup-composition.mjs',
  'paper-composition/bootstrap/autonomous-research-state-business-schema-provisioning-composition.mjs',
  'paper-core/bin/autonomous-research-supervisor.mjs',
  'paper-core/config/autonomous-research-state-databases.v1.json',
  'paper-domain/automation/automation-readiness-side-effect-inspection.mjs',
  'paper-domain/automation/autonomous-research-online-authority-evidence-cache-contract.mjs',
  'paper-domain/automation/autonomous-research-online-writer-manifest.mjs',
  'paper-domain/automation/autonomous-research-provider-canary-side-effect-inspection.mjs',
  'paper-domain/automation/autonomous-research-state-backup-contract.mjs',
  'paper-domain/automation/autonomous-research-state-safety-contract.mjs',
  'paper-domain/automation/autonomous-research-supervisor-external-action-journal.mjs',
  'paper-domain/automation/autonomous-submission-delivery-contract.mjs',
  'paper-ports/autonomous-research-online-mutation-port.mjs',
  'paper-ports/autonomous-submission-portal-port.mjs',
  'paper-ports/external-research-replay-port.mjs',
  'paper-ports/prior-art-retrieval-port.mjs',
  'paper-ports/research-agenda-producer-port.mjs',
  'paper-ports/research-content-producer-port.mjs',
  'paper-ports/reviewer-receipt-signer-port.mjs',
]);
export const SQL_MIGRATION_ROOT = 'store/migrations';
export const NON_WRITER_EXCLUSIONS = Object.freeze({
  'paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs':
    'append-only one-shot control-state journal in a dedicated root outside every registered research runtime database',
  'paper-adapters/automation/externally-fenced-sqlite-mutation-plan.mjs':
    'coordinator-internal pinned statement executor; never reachable as an unfenced repository writer',
  'paper-adapters/automation/externally-fenced-sqlite-mutation-recovery.mjs':
    'coordinator-internal committed-marker recovery; never reachable as an unfenced repository writer',
  'paper-adapters/automation/local-autonomous-research-state-authority-backup.mjs':
    'dedicated authority-principal state outside the research runtime; it cannot open or mutate any registered research database',
  'paper-adapters/automation/local-autonomous-research-state-authority-mutation.mjs':
    'dedicated authority-principal state outside the research runtime; it cannot open or mutate any registered research database',
  'paper-adapters/automation/local-autonomous-research-state-authority-runtime.mjs':
    'dedicated authority-principal state outside the research runtime; it cannot open or mutate any registered research database',
});
export const NON_WRITER_ENTRYPOINT_EXCLUSIONS = Object.freeze({
  'paper-adapters/automation/autonomous-research-online-authority-journal.mjs:expectedAuthorityJournalSqliteSchemaIdentity':
    'in-memory exact-schema projection only; it cannot open a persistent database',
  'paper-adapters/automation/autonomous-research-online-authority-journal.mjs:moduleSchemaProvisioning':
    'declarative authority journal DDL and in-memory schema identity projection; no persistent state mutation occurs at module evaluation',
  'paper-adapters/automation/autonomous-research-workspace-repository.mjs:createAutonomousResearchWorkspaceRepository':
    'filesystem-only workspace repository; no SQLite state database mutation surface',
  'paper-adapters/automation/automation-runtime-reconciler.mjs:applyStrictReconciliation':
    'transaction-scoped fixed-statement callback of executeAutomationRuntimeReconciliation',
  'paper-adapters/automation/automation-runtime-reconciler.mjs:executeOfflineReconciliation':
    'offline compatibility transaction unavailable through the strict native StorePort',
  'paper-adapters/automation/automation-runtime-reconciler.mjs:offlineExactEventSql':
    'offline compatibility SQL builder used only by executeOfflineReconciliation',
  'paper-adapters/automation/automation-runtime-reconciler.mjs:offlineExactMutationSql':
    'offline compatibility SQL builder used only by executeOfflineReconciliation',
  'paper-adapters/automation/automation-runtime-reconciler.mjs:offlineExactlyOneGuardSql':
    'offline compatibility guard SQL used only by executeOfflineReconciliation',
  'paper-adapters/automation/automation-runtime-reconciler.mjs:insertStrictEvent':
    'transaction-scoped fixed-statement helper of executeAutomationRuntimeReconciliation',
  'paper-adapters/automation/legacy-terminal-active-residue-settlement.mjs:applyStrictSettlement':
    'transaction-scoped fixed-statement callback of the registered legacy settlement operation',
  'paper-adapters/automation/legacy-terminal-active-residue-settlement.mjs:executeOfflineSettlement':
    'offline compatibility transaction unavailable through the strict native StorePort',
  'paper-adapters/automation/legacy-terminal-active-residue-settlement.mjs:offlineExact':
    'offline compatibility SQL builder used only by executeOfflineSettlement',
  'paper-adapters/automation/legacy-terminal-active-residue-settlement.mjs:offlineExactlyOneGuardSql':
    'offline compatibility guard SQL used only by executeOfflineSettlement',
  'paper-adapters/automation/legacy-terminal-active-residue-settlement.mjs:offlineScopeGuardSql':
    'offline compatibility scope-guard SQL used only by executeOfflineSettlement',
  'paper-adapters/automation/legacy-terminal-active-residue-settlement.mjs:offlineSettlementSql':
    'offline compatibility settlement SQL used only by executeOfflineSettlement',
  'paper-adapters/automation/legacy-terminal-active-residue-settlement.mjs:runExactlyOne':
    'transaction-scoped fixed-statement helper of the registered legacy settlement operation',
  'paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs:createFullResearchQualificationReceiptPointerRepository':
    'pure repository factory; its publication and lease mutation methods remain separately discovered',
  'paper-adapters/automation/runtime-image-reproducibility-receipt-repository.mjs:createRuntimeImageReproducibilityReceiptRepository':
    'pure repository factory; its publication mutation methods remain separately discovered',
  'paper-adapters/inventory/inventory-repository.mjs:createInventoryRepository':
    'pure StorePort-backed inventory factory with no mutation invocation',
  'paper-adapters/persistence/sqlite-campaign-release-authority-repository.mjs:createSqliteCampaignReleaseAuthorityRepository':
    'pure repository factory; promoteCompletedRelease remains separately discovered',
  'paper-adapters/persistence/sqlite-campaign-store.mjs:createSqliteCampaignStore':
    'pure repository factory; nested campaign mutation methods remain separately discovered',
  'paper-adapters/persistence/sqlite-job-receipt-store.mjs:createSqliteJobReceiptStore':
    'pure repository factory; nested job mutation methods remain separately discovered',
  'paper-adapters/persistence/sqlite-receipt-ledger-qualification.mjs:createSqliteReceiptLedgerQualificationStore':
    'pure repository factory; qualify remains separately discovered',
  'paper-adapters/persistence/sqlite-workflow-state-store.mjs:createSqliteWorkflowStateStore':
    'pure repository factory; put remains separately discovered',
  'paper-adapters/submission/sqlite-delivery-store.mjs:createSqliteSubmissionDeliveryStore':
    'pure operation composition factory; delivery mutations remain in the bounded operation modules',
  'paper-composition/automation/automation-machine-intake-readiness.mjs:inspectAutonomousResearchMachineIntakeStatus':
    'read-only status inspection opens the intake repository with create=false',
  'paper-composition/automation/automation-readiness-query.mjs:queryAutomationReadiness':
    'read-only readiness query uses read-only stores and repository read methods',
  'paper-composition/automation/automation-readiness-query.mjs:readCanonicalQualificationReceipt':
    'read-only canonical qualification pointer lookup',
  'paper-composition/automation/autonomous-research-resident-prerequisite-inspection.mjs:inspectAutonomousResearchResidentPrerequisites':
    'read-only prerequisite inspection opens qualification state with create=false',
  'paper-composition/automation/runtime-image-reproducibility-composition.mjs:composeRuntimeImageReproducibilityStatus':
    'read-only reproducibility status lookup; verify and publish entrypoints remain discovered',
  'paper-composition/automation/runtime-image-reproducibility-composition.mjs:composeRuntimeImageReproducibilityReport':
    'composition-only delegation to the runtime publication repository; the repository publish binding is inspected directly',
  'paper-composition/automation/runtime-image-reproducibility-composition.mjs:composeRuntimeImageReproducibilityVerification':
    'composition-only delegation to the runtime publication repository; the repository publish binding is inspected directly',
  'paper-composition/bootstrap/capability-scoped-bootstrap.mjs:composeBatchServices':
    'service graph composition only; returned repository mutation methods remain separately discovered',
  'paper-composition/bootstrap/receipt-ledger-composition.mjs:composeLedgerAdministratorServices':
    'service graph composition only; returned ledger mutation methods remain separately discovered',
  'paper-composition/bootstrap/autonomous-research-state-business-schema-provisioning-composition.mjs:provisionBusinessSchemas':
    'fresh-only staging callback for explicit offline provisioning; it cannot target the resident online state root',
  'paper-composition/bootstrap/autonomous-research-state-business-schema-provisioning-composition.mjs:provisionCanonicalBusinessSchemas':
    'fresh-only offline schema composition over a private staging root; no resident online mutation surface',
  'paper-composition/bootstrap/autonomous-research-state-business-schema-provisioning-composition.mjs:convergeNativeStoreForAtomicInstallation':
    'fresh-only native-store convergence inside the private atomic-installation staging root',
  'paper-composition/bootstrap/autonomous-research-state-partial-root-maintenance-composition.mjs:provisionMissingBusinessSchemas':
    'writer-quiesced partial-root repair provisions only private staging databases before atomic no-clobber publication',
  'paper-adapters/automation/autonomous-research-supervisor-instance-mutation-plan.mjs:moduleSchemaProvisioning':
    'offline compatibility transaction shell contains no business SQL; strict resident writes remain covered at six literal repository bindings',
  'paper-adapters/automation/autonomous-research-runtime-refresh-mutation-plan.mjs:moduleSchemaProvisioning':
    'offline compatibility transaction shell contains no business SQL; strict runtime-refresh writes remain covered at literal repository bindings',
  'paper-adapters/automation/autonomous-research-supervisor-state-mutation-plan.mjs:moduleSchemaProvisioning':
    'offline compatibility transaction shell contains no business SQL; strict supervisor-state writes remain covered at literal repository bindings',
  'paper-adapters/automation/runtime-image-reproducibility-publication-mutation-plan.mjs:moduleSchemaProvisioning':
    'offline compatibility transaction shell contains no business SQL; strict runtime-publication writes remain covered at the literal repository binding',
  'paper-adapters/automation/full-research-qualification-publication-mutation-plan.mjs:moduleSchemaProvisioning':
    'offline compatibility transaction shell contains no business SQL; strict qualification-publication writes remain covered at literal repository bindings',
  'paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs:mutate':
    'coordinator callback body; its four enclosing repository operations remain covered at literal bindings',
  'paper-adapters/automation/autonomous-research-qualification-state-mutation-plan.mjs:moduleSchemaProvisioning':
    'offline compatibility transaction shell contains no business SQL; strict external-qualification writes remain covered at literal repository bindings',
  'paper-adapters/automation/autonomous-research-qualification-state-repository.mjs:mutate':
    'coordinator callback body; its five enclosing qualification-state operations remain covered at literal bindings',
  'paper-adapters/automation/autonomous-research-qualification-attempt-infrastructure-operations.mjs:mutate':
    'coordinator callback body; its two enclosing attempt-infrastructure operations remain covered at literal bindings',
  'paper-composition/automation/autonomous-research-qualification-composition.mjs:composeAutonomousResearchQualificationRenewal':
    'composition-only delegation to qualification state and publication repositories; repository bindings are inspected directly',
  'paper-composition/automation/autonomous-research-supervisor-runtime-composition.mjs:composeAutonomousResearchSupervisorRuntime':
    'composition-only factory; its returned reconciliation and refresh closures delegate to separately inspected fenced repositories',
  'paper-composition/automation/autonomous-submission-request-verifier-composition.mjs:verifyQualificationAuthority':
    'read-only verifier callback; it opens existing qualification authorities with provisioning disabled and invokes only read methods',
  'paper-adapters/automation/autonomous-research-online-schema-transition-installation.mjs:ensureMarkerMetadata':
    'externally reserved offline schema-transition subroutine; unavailable to the resident online writer graph',
  'paper-adapters/automation/autonomous-research-online-schema-transition-installation.mjs:ensureJournalMetadata':
    'externally reserved offline schema-transition subroutine; unavailable to the resident online writer graph',
  'paper-adapters/automation/autonomous-research-online-schema-transition-installation.mjs:acquireAutonomousResearchOnlineSchemaTransitionLocks':
    'externally authorized offline maintenance lock acquisition; unavailable to the resident online writer graph',
  'paper-adapters/automation/autonomous-research-online-schema-transition-installation.mjs:installAutonomousResearchOnlineSchemaTransitionLocks':
    'externally authorized one-shot schema installation; unavailable to the resident online writer graph',
  'paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs:moduleSchemaProvisioning':
    'in-memory target-schema projection used only by the externally authorized offline transition planner',
  'paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs:schemaObjectsForStatements':
    'in-memory target-schema projection used only by the externally authorized offline transition planner',
  'paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs:applySchemaTransitionStatements':
    'externally authorized one-shot schema installation helper; unavailable to the resident online writer graph',
  'paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs:expectedPostSchemaHash':
    'temporary-copy schema projection used only to construct a signed offline transition plan',
  'paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs:projectInstance':
    'pure transition-plan projection over a temporary database copy; no production online writer surface',
  'paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs:buildAutonomousResearchOnlineSchemaTransitionPlan':
    'offline signed-transition plan builder; any production mutation is performed later by the dedicated externally authorized installer',
  'paper-adapters/automation/externally-fenced-sqlite-mutation-coordinator.mjs:executeMutation':
    'coordinator-owned transaction boundary; business mutations remain covered at literal caller bindings with factory-pinned plans',
  'paper-adapters/automation/externally-fenced-sqlite-mutation-coordinator.mjs:insertMarker':
    'coordinator-owned system-marker insert; not a business repository mutation entrypoint',
  'paper-adapters/automation/autonomous-research-online-runtime-activation.mjs:executeMutation':
    'activated coordinator forwarding method; repository operations remain covered at their literal caller bindings',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs:insertInTransaction':
    'transaction-scoped subroutine of beginExternalActionAttempt; it cannot open or commit a database independently',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs:finishInTransaction':
    'transaction-scoped subroutine of finishExternalActionAttempt; it cannot open or commit a database independently',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs:recoverAttemptInTransaction':
    'transaction-scoped recovery subroutine of the registered supervisor-state operations',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs:markProviderAttemptInterrupted':
    'transaction-scoped recovery subroutine of the registered supervisor-state operations',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs:recoverStaleAttemptsInTransaction':
    'transaction-scoped subroutine invoked by reconcileStaleLeases under its registered coordinator binding',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs:recoverActiveAttemptInTransaction':
    'transaction-scoped subroutine invoked by supervisor-state recovery under a registered coordinator binding',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs:cancelAttemptBeforeStartInTransaction':
    'transaction-scoped recovery subroutine invoked by resolveExternalActionRecovery under its registered coordinator binding',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs:completeRecoveryInTransaction':
    'transaction-scoped recovery subroutine invoked by resolveExternalActionRecovery under its registered coordinator binding',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs:storeRecoveryResultInTransaction':
    'transaction-scoped recovery result helper invoked by completeRecoveryInTransaction under the registered coordinator binding',
  'paper-adapters/automation/autonomous-research-supervisor-state-provisioning.mjs:provisionAutonomousResearchSupervisorStateDatabase':
    'explicit offline schema provisioning; strict online construction disables this path before filesystem or SQLite I/O',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-journal-storage.mjs:installAutonomousResearchSupervisorExternalActionJournalCoreSchema':
    'transaction-scoped minimal schema helper invoked only by writer-quiesced partial-root repair and full offline provisioning',
  'paper-adapters/automation/autonomous-research-machine-intake-mutation-plan.mjs:moduleSchemaProvisioning':
    'offline compatibility transaction shell contains no business SQL; strict machine-intake writes remain covered at eight literal repository bindings',
  'paper-adapters/automation/autonomous-research-machine-intake-repository.mjs:supersedePriorRecurringEpochs':
    'coordinator callback helper used only by appendIntake; it cannot open or commit the database independently',
  'paper-adapters/automation/autonomous-research-machine-intake-repository.mjs:appendMachineIntake':
    'compatibility delegation to the separately covered appendIntake operation',
  'paper-composition/automation/autonomous-research-machine-intake-composition.mjs:createLegacyAutonomousResearchMachineIntakeRepository':
    'compatibility delegation to the repository factory; offline schema and repository DML are covered separately',
  'paper-adapters/automation/autonomous-research-topic-producer-repository.mjs:mutate':
    'coordinator callback helper; the enclosing topic-producer repository operations remain covered at literal bindings',
  'paper-adapters/automation/autonomous-submission-outbox-repository.mjs:applyMutation':
    'transaction-scoped callback helper; the six role-specific literal outbox bindings remain independently covered',
  'paper-adapters/automation/autonomous-research-topic-producer-repository.mjs:reserveCanary':
    'transaction-scoped helper used only by a registered topic-producer operation',
  'paper-adapters/automation/autonomous-research-topic-producer-lease-operations.mjs:mutate':
    'coordinator callback helper; the enclosing lease operations remain covered at literal bindings',
  'paper-adapters/automation/autonomous-research-topic-producer-canary-journal-operations.mjs:mutate':
    'coordinator callback helper; the enclosing canary operations remain covered at literal bindings',
  'paper-adapters/automation/autonomous-research-topic-producer-canary-journal-operations.mjs:recoverInterruptedProviderCanary':
    'transaction-scoped recovery helper used only by a registered canary operation',
  'paper-adapters/automation/autonomous-research-topic-producer-mutation-plan.mjs:clockStatements':
    'declarative mutation-plan helper; it cannot open or commit the database independently',
  'paper-adapters/automation/autonomous-research-topic-producer-mutation-plan.mjs:moduleSchemaProvisioning':
    'offline compatibility transaction shell contains no business SQL; strict topic-producer writes remain covered at ten literal bindings',
  'paper-adapters/persistence/autonomous-submission-handoff-mutation-plan.mjs:moduleSchemaProvisioning':
    'declarative fixed submission-handoff mutation plans; they cannot open or commit the database independently',
  'paper-adapters/persistence/autonomous-submission-handoff-store.mjs:moduleSchemaProvisioning':
    'declarative offline handoff schema; persistent creation is restricted to explicit offline provisioning',
  'paper-adapters/persistence/autonomous-submission-handoff-store.mjs:provisionAutonomousSubmissionHandoffStore':
    'explicit fresh-only offline handoff provisioning; resident online composition never invokes this path',
  'paper-adapters/persistence/autonomous-submission-handoff-store.mjs:activateAutonomousSubmissionHandoffCutover':
    'explicit offline drained cutover transaction; resident online composition opens only an already active handoff store',
  'paper-adapters/persistence/autonomous-submission-handoff-store.mjs:openAutonomousSubmissionHandoffStore':
    'store lifecycle factory; strict online callers require the externally fenced mutation boundary',
  'paper-adapters/persistence/native-store-online-mutation-plan.mjs:moduleSchemaProvisioning':
    'declarative fixed native-store mutation plan; it cannot open or commit the database independently',
  'paper-adapters/persistence/native-store-resource-workspace-mutation-plan.mjs:moduleSchemaProvisioning':
    'declarative fixed resource and workspace mutation plans; they cannot open or commit the database independently',
  'paper-adapters/persistence/native-store-campaign-mutation-plan.mjs:moduleSchemaProvisioning':
    'declarative fixed campaign mutation plans; they cannot open or commit the database independently',
  'paper-adapters/persistence/native-store-campaign-mutation-plan.mjs:insertNativeStoreCampaignEvent':
    'transaction-scoped fixed-statement helper used only by registered campaign operations',
  'paper-adapters/persistence/native-store-campaign-mutation-plan.mjs:projectNativeStoreCampaign':
    'transaction-scoped fixed-statement helper used only by registered campaign operations',
  'paper-adapters/persistence/native-store-campaign-mutation-plan.mjs:runNativeStoreCampaignUsage':
    'transaction-scoped fixed-statement helper used only by registered campaign operations',
  'paper-adapters/persistence/native-store-campaign-mutation-plan.mjs:runRequiredNativeStoreCampaignStatement':
    'transaction-scoped fixed-statement helper used only by registered campaign operations',
  'paper-adapters/persistence/native-store-campaign-mutation-execution.mjs:applyCancelNode':
    'coordinator callback helper; the enclosing literal campaign operation is the independent boundary',
  'paper-adapters/persistence/native-store-campaign-mutation-execution.mjs:applyExtendCampaign':
    'coordinator callback helper; the enclosing literal campaign operation is the independent boundary',
  'paper-adapters/persistence/native-store-campaign-mutation-execution.mjs:applyLifecycleMutation':
    'coordinator callback helper; the enclosing literal campaign operation is the independent boundary',
  'paper-adapters/persistence/native-store-campaign-mutation-execution.mjs:applyNativeStoreCampaignMutation':
    'coordinator callback dispatcher; public literal campaign operation bindings are inspected directly',
  'paper-adapters/persistence/sqlite-campaign-lifecycle-terminal-operations.mjs:terminalCampaign':
    'pure terminal-campaign payload builder invoked only by failCampaign and stopCampaign literal bindings',
  'paper-adapters/persistence/sqlite-campaign-mutation-boundary.mjs:guarded':
    'legacy SQL descriptor helper; strict campaign writes use registered fixed statements',
  'paper-adapters/persistence/sqlite-campaign-mutation-boundary.mjs:legacyTransaction':
    'offline compatibility transaction path unavailable through the strict native StorePort',
  'paper-adapters/persistence/sqlite-campaign-mutation-boundary.mjs:mutation':
    'strict StorePort coordinator adapter; public literal campaign bindings are inspected directly',
  'paper-adapters/persistence/sqlite-campaign-projection.mjs:buildSqliteCampaignProjectionStatement':
    'legacy SQL descriptor helper; strict campaign operations use the pinned projection statement',
  'paper-adapters/persistence/sqlite-campaign-store.mjs:eventStatement':
    'legacy SQL descriptor helper; strict campaign operations use the pinned event statement',
  'paper-adapters/persistence/sqlite-campaign-telemetry-operations.mjs:mutate':
    'strict StorePort callback helper; recordTelemetry is the independent bounded operation',
  'paper-adapters/persistence/sqlite-store.mjs:mutate':
    'strict StorePort coordinator adapter; literal native operation bindings are inspected at repository call sites',
  'paper-adapters/persistence/sqlite-store.mjs:createExternallyFencedNativeSqliteStore':
    'strict StorePort factory; its bounded mutate call sites remain separately discovered',
  'paper-adapters/persistence/sqlite-store.mjs:createExternallyFencedSqliteStore':
    'role-scoped strict StorePort factory; its bounded mutate call sites remain separately discovered',
  'paper-adapters/persistence/sqlite-store.mjs:createOfflineSqliteStore':
    'explicit offline provisioning and maintenance factory; never allowed by strict online composition',
  'paper-adapters/persistence/sqlite-store.mjs:createPort':
    'internal StorePort constructor; strict online callers receive only the bounded mutation adapter',
  'paper-adapters/persistence/sqlite-store.mjs:createSqliteStore':
    'unfenced compatibility factory; fully autonomous composition uses the externally fenced factory',
  'paper-adapters/persistence/sqlite-store.mjs:query':
    'internal StorePort method; strict mode permits reads and rejects mutation SQL before SQLite execution',
  'paper-adapters/persistence/sqlite-store.mjs:run':
    'internal StorePort method; strict mode rejects this generic write surface',
  'paper-adapters/persistence/sqlite-store.mjs:execute':
    'internal StorePort method; strict mode rejects this generic write surface',
  'paper-adapters/persistence/sqlite-store.mjs:transaction':
    'internal StorePort method; strict mode permits read-only units and rejects generic writes',
  'paper-adapters/persistence/sqlite-campaign-store.mjs:mutation':
    'strict StorePort coordinator wrapper; literal campaign operation bindings are inspected at repository call sites',
  'paper-adapters/persistence/sqlite-campaign-store.mjs:apply':
    'nested strict StorePort callback; its enclosing campaign operation remains the independent boundary',
  'paper-adapters/persistence/native-store-ledger-mutation-plan.mjs:moduleSchemaProvisioning':
    'declarative fixed ledger, job, and workflow mutation plans',
  'paper-adapters/persistence/native-store-quality-release-mutation-plan.mjs:moduleSchemaProvisioning':
    'declarative fixed theorem-quality and completed-release mutation plans',
  'paper-adapters/persistence/native-store-ledger-mutation-plan.mjs:insertReceipt':
    'declarative fixed statement-plan helper; it cannot open or commit the database',
  'paper-adapters/persistence/native-store-ledger-mutation-plan.mjs:insertReceiptOrIgnore':
    'declarative fixed statement-plan helper; it cannot open or commit the database',
  'paper-adapters/persistence/native-store-ledger-mutation-plan.mjs:settleJob':
    'declarative fixed statement-plan helper; it cannot open or commit the database',
  'paper-adapters/persistence/native-store-ledger-mutation-plan.mjs:settleJobAttempt':
    'declarative fixed statement-plan helper; it cannot open or commit the database',
  'paper-adapters/persistence/native-store-ledger-mutation-plan.mjs:settlementStatements':
    'declarative fixed statement-plan helper; it cannot open or commit the database',
  'paper-adapters/persistence/sqlite-job-receipt-store.mjs:persistReceipt':
    'offline compatibility helper; strict public job operations embed the receipt insert in their fixed plans',
  'paper-adapters/persistence/sqlite-job-receipt-store.mjs:settleJobInMutation':
    'transaction-scoped helper invoked only by the two registered public settlement operations',
  'paper-adapters/persistence/sqlite-job-receipt-store.mjs:settleJobOffline':
    'offline compatibility helper unavailable through the strict StorePort path',
  'paper-adapters/persistence/sqlite-receipt-ledger.mjs:prepare':
    'pure receipt mutation descriptor used inside separately registered fixed operations',
  'paper-adapters/submission/sqlite-delivery-persistence.mjs:execute':
    'offline compatibility dynamic SQL adapter; strict submission writes use the seventeen fixed public operations',
  'paper-adapters/persistence/native-store-submission-delivery-mutation-plan.mjs:moduleSchemaProvisioning':
    'declarative fixed submission delivery mutation plans',
  'paper-adapters/automation/sqlite-resource-governor.mjs:snapshot':
    'read-side snapshot delegation; any stale-owner cleanup is separately fenced by reapDeadOwners',
  'paper-adapters/automation/workspace-registry.mjs:reconcileMissingEligible':
    'filesystem inspection followed only by separately fenced transition operations',
  'paper-composition/automation/autonomous-research-campaign-composition.mjs:composeAutonomousResearchCampaignAction':
    'composition-only delegation; native repository mutations are inspected at their literal boundaries',
  'paper-composition/automation/autonomous-research-machine-intake-enqueue-composition.mjs:composeAutonomousResearchMachineIntakeEnqueue':
    'composition-only delegation; native repository mutations are inspected at their literal boundaries',
  'paper-composition/bootstrap/automation-context-bootstrap.mjs:bootstrapAutomationContext':
    'service graph composition only; native repository mutations are inspected at their literal boundaries',
  'paper-composition/bootstrap/automation-campaign-state-composition.mjs:composeAutomationCampaignState':
    'service graph composition only; campaign and workspace repository mutations are inspected at their literal boundaries',
  'paper-composition/bootstrap/autonomous-submission-handoff-context-bootstrap.mjs:executeMutation':
    'role-scoping coordinator proxy; the six literal outbox repository bindings are inspected directly',
  'paper-composition/bootstrap/batch-inventory-context-bootstrap.mjs:bootstrapBatchInventoryContext':
    'service graph composition only; native repository mutations are inspected at their literal boundaries',
  'paper-composition/bootstrap/capability-scoped-bootstrap.mjs:bootstrapBatchContext':
    'service graph composition only; native repository mutations are inspected at their literal boundaries',
  'paper-composition/bootstrap/capability-scoped-bootstrap.mjs:bootstrapSubmissionContext':
    'service graph composition only; native repository mutations are inspected at their literal boundaries',
  'paper-composition/bootstrap/context-foundation-composition.mjs:composeFoundationServices':
    'service graph composition only; strict store construction is inspected at its bounded factory',
  'paper-composition/bootstrap/context-foundation-composition.mjs:composeScopedFoundationServices':
    'service graph composition only; strict store construction is inspected at its bounded factory',
  'paper-composition/bootstrap/context-foundation-composition.mjs:openScopedPaperStore':
    'store lifecycle composition only; repository mutations are inspected at their literal boundaries',
  'paper-composition/bootstrap/context-foundation-composition.mjs:resolveStore':
    'store lifecycle composition only; repository mutations are inspected at their literal boundaries',
  'paper-composition/compat/legacy-context-bootstrap.mjs:bootstrapLegacyPaperExecutionContext':
    'legacy service graph composition only; it is unavailable in the fully autonomous strict profile',
  'paper-composition/automation/autonomous-research-supervisor-state-composition.mjs:composeAutonomousResearchSupervisorState':
    'composition-only delegation to the three fenced supervisor repositories; their literal bindings are inspected directly',
  'paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs:inspectAutonomousResearchSupervisorInstanceStatus':
    'explicit read-only status transaction',
  'paper-adapters/persistence/sqlite-campaign-store.mjs:readCampaignDefinitionSnapshot':
    'explicit read-only campaign snapshot transaction',
  'paper-adapters/persistence/sqlite-store.mjs:createReadOnlySqliteStore':
    'factory forces readOnly=true and rejects every mutation surface',
  'paper-core/bin/hepta-store.mjs:assertTrustedStoreReceipt': 'pure receipt assertion',
  'paper-core/bin/hepta-store.mjs:ledgerIdentity': 'pure receipt identity projection',
  'paper-core/bin/hepta-store.mjs:receiptLedger': 'factory only; no mutation is invoked',
  'paper-core/bin/hepta-store.mjs:resolveBackupReceipt': 'read-only receipt lookup',
  'paper-core/bin/hepta-store.mjs:status': 'read-only status query',
  'paper-core/bin/automation-campaign-smoke.mjs:moduleSchemaProvisioning':
    'isolated smoke harness schema setup outside production state databases',
  'paper-core/bin/automation-openclaw-multipaper-smoke.mjs:moduleSchemaProvisioning':
    'isolated multi-paper smoke harness schema setup outside production state databases',
  'paper-core/bin/automation-strict-rereview-smoke.mjs:moduleSchemaProvisioning':
    'isolated rereview smoke harness schema setup outside production state databases',
  'paper-core/bin/run-real-paper-provider-sandbox.mjs:moduleSchemaProvisioning':
    'provider sandbox schema setup outside production state databases',
  'paper-core/bin/isolated-runtime-store.mjs:prepareIsolatedRuntimeStore':
    'isolated runtime fixture store setup outside production state databases',
  'paper-core/bin/run-isolated-verification.mjs:initialize':
    'verification-only wrapper outside the production and maintenance writer surfaces',
});
export const DIRECT_SQL_ALLOWED_ENTRYPOINT_EXCLUSIONS = new Set([
  'paper-adapters/automation/autonomous-research-online-authority-journal.mjs:expectedAuthorityJournalSqliteSchemaIdentity',
  'paper-adapters/automation/autonomous-research-online-authority-journal.mjs:moduleSchemaProvisioning',
  'paper-adapters/automation/autonomous-research-online-schema-transition-installation.mjs:ensureMarkerMetadata',
  'paper-adapters/automation/autonomous-research-online-schema-transition-installation.mjs:ensureJournalMetadata',
  'paper-adapters/automation/autonomous-research-online-schema-transition-installation.mjs:acquireAutonomousResearchOnlineSchemaTransitionLocks',
  'paper-adapters/automation/autonomous-research-online-schema-transition-installation.mjs:installAutonomousResearchOnlineSchemaTransitionLocks',
  'paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs:moduleSchemaProvisioning',
  'paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs:schemaObjectsForStatements',
  'paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs:applySchemaTransitionStatements',
  'paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs:expectedPostSchemaHash',
  'paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs:projectInstance',
  'paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs:buildAutonomousResearchOnlineSchemaTransitionPlan',
  'paper-composition/bootstrap/autonomous-research-state-business-schema-provisioning-composition.mjs:convergeNativeStoreForAtomicInstallation',
  'paper-adapters/automation/automation-runtime-reconciler.mjs:offlineExactEventSql',
  'paper-adapters/automation/automation-runtime-reconciler.mjs:offlineExactlyOneGuardSql',
  'paper-adapters/automation/legacy-terminal-active-residue-settlement.mjs:executeOfflineSettlement',
  'paper-adapters/automation/legacy-terminal-active-residue-settlement.mjs:offlineExactlyOneGuardSql',
  'paper-adapters/automation/legacy-terminal-active-residue-settlement.mjs:offlineScopeGuardSql',
  'paper-adapters/automation/legacy-terminal-active-residue-settlement.mjs:offlineSettlementSql',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-journal-storage.mjs:installAutonomousResearchSupervisorExternalActionJournalCoreSchema',
  'paper-adapters/automation/autonomous-research-supervisor-instance-mutation-plan.mjs:moduleSchemaProvisioning',
  'paper-adapters/automation/autonomous-research-runtime-refresh-mutation-plan.mjs:moduleSchemaProvisioning',
  'paper-adapters/automation/autonomous-research-supervisor-state-mutation-plan.mjs:moduleSchemaProvisioning',
  'paper-adapters/automation/runtime-image-reproducibility-publication-mutation-plan.mjs:moduleSchemaProvisioning',
  'paper-adapters/automation/full-research-qualification-publication-mutation-plan.mjs:moduleSchemaProvisioning',
  'paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs:mutate',
  'paper-adapters/automation/autonomous-research-qualification-state-mutation-plan.mjs:moduleSchemaProvisioning',
  'paper-adapters/automation/autonomous-research-qualification-state-repository.mjs:mutate',
  'paper-adapters/automation/autonomous-research-qualification-attempt-infrastructure-operations.mjs:mutate',
  'paper-adapters/automation/autonomous-research-machine-intake-mutation-plan.mjs:moduleSchemaProvisioning',
  'paper-adapters/automation/autonomous-research-machine-intake-repository.mjs:supersedePriorRecurringEpochs',
  'paper-adapters/automation/autonomous-research-topic-producer-repository.mjs:mutate',
  'paper-adapters/automation/autonomous-research-topic-producer-repository.mjs:reserveCanary',
  'paper-adapters/automation/autonomous-research-topic-producer-lease-operations.mjs:mutate',
  'paper-adapters/automation/autonomous-research-topic-producer-canary-journal-operations.mjs:mutate',
  'paper-adapters/automation/autonomous-research-topic-producer-canary-journal-operations.mjs:recoverInterruptedProviderCanary',
  'paper-adapters/automation/autonomous-research-topic-producer-mutation-plan.mjs:clockStatements',
  'paper-adapters/automation/autonomous-research-topic-producer-mutation-plan.mjs:moduleSchemaProvisioning',
  'paper-adapters/persistence/autonomous-submission-handoff-mutation-plan.mjs:moduleSchemaProvisioning',
  'paper-adapters/persistence/autonomous-submission-handoff-store.mjs:moduleSchemaProvisioning',
  'paper-adapters/persistence/autonomous-submission-handoff-store.mjs:provisionAutonomousSubmissionHandoffStore',
  'paper-adapters/persistence/autonomous-submission-handoff-store.mjs:activateAutonomousSubmissionHandoffCutover',
  'paper-adapters/persistence/native-store-online-mutation-plan.mjs:moduleSchemaProvisioning',
  'paper-adapters/persistence/native-store-resource-workspace-mutation-plan.mjs:moduleSchemaProvisioning',
  'paper-adapters/persistence/native-store-campaign-mutation-plan.mjs:moduleSchemaProvisioning',
  'paper-adapters/persistence/native-store-campaign-mutation-plan.mjs:insertNativeStoreCampaignEvent',
  'paper-adapters/persistence/native-store-campaign-mutation-plan.mjs:projectNativeStoreCampaign',
  'paper-adapters/persistence/native-store-campaign-mutation-plan.mjs:runNativeStoreCampaignUsage',
  'paper-adapters/persistence/native-store-campaign-mutation-plan.mjs:runRequiredNativeStoreCampaignStatement',
  'paper-adapters/persistence/native-store-campaign-mutation-execution.mjs:applyCancelNode',
  'paper-adapters/persistence/native-store-campaign-mutation-execution.mjs:applyExtendCampaign',
  'paper-adapters/persistence/native-store-campaign-mutation-execution.mjs:applyLifecycleMutation',
  'paper-adapters/persistence/native-store-campaign-mutation-execution.mjs:applyNativeStoreCampaignMutation',
  'paper-adapters/persistence/sqlite-campaign-lifecycle-terminal-operations.mjs:terminalCampaign',
  'paper-adapters/persistence/sqlite-campaign-mutation-boundary.mjs:guarded',
  'paper-adapters/persistence/sqlite-campaign-mutation-boundary.mjs:legacyTransaction',
  'paper-adapters/persistence/sqlite-campaign-mutation-boundary.mjs:mutation',
  'paper-adapters/persistence/sqlite-campaign-projection.mjs:buildSqliteCampaignProjectionStatement',
  'paper-adapters/persistence/sqlite-campaign-store.mjs:eventStatement',
  'paper-adapters/persistence/sqlite-campaign-telemetry-operations.mjs:mutate',
  'paper-adapters/persistence/sqlite-store.mjs:createPort',
  'paper-adapters/persistence/sqlite-store.mjs:createSqliteStore',
  'paper-adapters/persistence/sqlite-store.mjs:query',
  'paper-adapters/persistence/sqlite-store.mjs:run',
  'paper-adapters/persistence/sqlite-store.mjs:execute',
  'paper-adapters/persistence/sqlite-store.mjs:transaction',
  'paper-adapters/persistence/native-store-ledger-mutation-plan.mjs:moduleSchemaProvisioning',
  'paper-adapters/persistence/native-store-quality-release-mutation-plan.mjs:moduleSchemaProvisioning',
  'paper-adapters/persistence/native-store-ledger-mutation-plan.mjs:insertReceipt',
  'paper-adapters/persistence/native-store-ledger-mutation-plan.mjs:insertReceiptOrIgnore',
  'paper-adapters/persistence/native-store-ledger-mutation-plan.mjs:settleJob',
  'paper-adapters/persistence/native-store-ledger-mutation-plan.mjs:settleJobAttempt',
  'paper-adapters/persistence/native-store-ledger-mutation-plan.mjs:settlementStatements',
  'paper-adapters/persistence/sqlite-job-receipt-store.mjs:persistReceipt',
  'paper-adapters/persistence/sqlite-job-receipt-store.mjs:settleJobOffline',
  'paper-adapters/persistence/sqlite-receipt-ledger.mjs:prepare',
  'paper-adapters/automation/automation-runtime-reconciler.mjs:executeOfflineReconciliation',
  'paper-adapters/submission/sqlite-delivery-persistence.mjs:execute',
  'paper-adapters/persistence/native-store-submission-delivery-mutation-plan.mjs:moduleSchemaProvisioning',
  'paper-adapters/automation/externally-fenced-sqlite-mutation-coordinator.mjs:executeMutation',
  'paper-adapters/automation/externally-fenced-sqlite-mutation-coordinator.mjs:insertMarker',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs:insertInTransaction',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs:finishInTransaction',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs:recoverAttemptInTransaction',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs:markProviderAttemptInterrupted',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs:recoverStaleAttemptsInTransaction',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs:recoverActiveAttemptInTransaction',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs:cancelAttemptBeforeStartInTransaction',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs:completeRecoveryInTransaction',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs:storeRecoveryResultInTransaction',
  'paper-adapters/automation/autonomous-research-supervisor-state-provisioning.mjs:provisionAutonomousResearchSupervisorStateDatabase',
  'paper-core/bin/automation-campaign-smoke.mjs:moduleSchemaProvisioning',
  'paper-core/bin/automation-openclaw-multipaper-smoke.mjs:moduleSchemaProvisioning',
  'paper-core/bin/automation-strict-rereview-smoke.mjs:moduleSchemaProvisioning',
  'paper-core/bin/run-real-paper-provider-sandbox.mjs:moduleSchemaProvisioning',
  'paper-core/bin/run-isolated-verification.mjs:initialize',
]);
export const WRITABLE_FACTORY_IMPORT_SOURCES = Object.freeze({
  'paper-adapters/persistence/sqlite-store.mjs': Object.freeze([
    'createSqliteStore',
  ]),
  'paper-adapters/persistence/store-provider.mjs': Object.freeze([
    'createDefaultPaperStore', 'openExistingWritablePaperStore',
  ]),
  'paper-composition/bootstrap/operator-persistence-composition.mjs': Object.freeze([
    'createDefaultPaperStore', 'createSqliteCampaignStore',
    'openExistingWritablePaperStore',
  ]),
  'paper-adapters/persistence/sqlite-campaign-store.mjs': Object.freeze([
    'createSqliteCampaignStore',
  ]),
  'paper-adapters/persistence/sqlite-campaign-release-authority-repository.mjs': Object.freeze([
    'createSqliteCampaignReleaseAuthorityRepository',
  ]),
  'paper-adapters/persistence/sqlite-job-receipt-store.mjs': Object.freeze([
    'createSqliteJobReceiptStore',
  ]),
  'paper-adapters/persistence/sqlite-receipt-ledger-qualification.mjs': Object.freeze([
    'createSqliteReceiptLedgerQualificationStore',
  ]),
  'paper-adapters/persistence/sqlite-workflow-state-store.mjs': Object.freeze([
    'createSqliteWorkflowStateStore',
  ]),
  'paper-adapters/submission/sqlite-delivery-store.mjs': Object.freeze([
    'createSqliteSubmissionDeliveryStore',
  ]),
  'paper-adapters/inventory/inventory-repository.mjs': Object.freeze([
    'createInventoryRepository',
  ]),
  'paper-adapters/automation/autonomous-research-machine-intake-repository.mjs': Object.freeze([
    'createAutonomousResearchMachineIntakeRepository',
  ]),
  'paper-composition/automation/autonomous-research-machine-intake-composition.mjs': Object.freeze([
    'createLegacyAutonomousResearchMachineIntakeRepository',
  ]),
  'paper-adapters/automation/autonomous-research-topic-producer-repository.mjs': Object.freeze([
    'createAutonomousResearchTopicProducerRepository',
  ]),
  'paper-adapters/automation/autonomous-research-supervisor-state-repository.mjs': Object.freeze([
    'createAutonomousResearchSupervisorStateRepository',
  ]),
  'paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs': Object.freeze([
    'createAutonomousResearchSupervisorInstanceRepository',
  ]),
  'paper-adapters/automation/autonomous-research-runtime-refresh-state-repository.mjs': Object.freeze([
    'createAutonomousResearchRuntimeRefreshStateRepository',
  ]),
  'paper-adapters/automation/autonomous-research-qualification-state-repository.mjs': Object.freeze([
    'createAutonomousResearchQualificationStateRepository',
  ]),
  'paper-adapters/automation/runtime-image-reproducibility-receipt-repository.mjs': Object.freeze([
    'createRuntimeImageReproducibilityReceiptRepository',
  ]),
  'paper-composition/automation/runtime-image-reproducibility-composition.mjs': Object.freeze([
    'createRuntimeImageReproducibilityReceiptRepository',
  ]),
  'paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs': Object.freeze([
    'createFullResearchQualificationReceiptPointerRepository',
  ]),
  'paper-adapters/automation/autonomous-research-workspace-repository.mjs': Object.freeze([
    'createAutonomousResearchWorkspaceRepository',
  ]),
});
export const GENERIC_MUTATION_SURFACES = Object.freeze({
  ...Object.fromEntries(Object.entries(WRITABLE_FACTORY_IMPORT_SOURCES).map(
    ([sourceFile, entrypoints]) => [sourceFile, entrypoints],
  )),
  'paper-adapters/persistence/sqlite-store.mjs': Object.freeze([
    'createPort', 'createSqliteStore', 'query', 'run', 'execute', 'transaction',
  ]),
  'paper-core/bin/hepta-store.mjs': Object.freeze(['writableStore']),
});
