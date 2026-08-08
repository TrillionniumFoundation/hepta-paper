const DEFAULT_THRESHOLD = Object.freeze({
  lines: 40,
  functions: 25,
  maxUncoveredBranchBlocks: 180,
});

const TRUST_BOUNDARY_THRESHOLD = Object.freeze({
  lines: 55,
  functions: 40,
  maxUncoveredBranchBlocks: 48,
});

const MAXIMUM_AUDITED_BRANCH_CAP = 120;
const AUDITED_EXCEPTION_KIND = 'audited_large_branch_surface';
const EXACT_OVERRIDE_KEYS = Object.freeze([
  'auditKind',
  'functions',
  'lines',
  'maxUncoveredBranchBlocks',
  'rationale',
  'reviewedAttackSurface',
  'trustBoundary',
]);
const EXACT_TARGET_KEYS = Object.freeze(['path', 'trustBoundary']);

function exception({
  lines,
  functions,
  maxUncoveredBranchBlocks,
  trustBoundary,
  reviewedAttackSurface,
  rationale,
}) {
  return Object.freeze({
    lines,
    functions,
    maxUncoveredBranchBlocks,
    trustBoundary,
    auditKind: AUDITED_EXCEPTION_KIND,
    reviewedAttackSurface: Object.freeze([...reviewedAttackSurface]),
    rationale,
  });
}

function target(path, trustBoundary = false) {
  return Object.freeze({ path, trustBoundary });
}

export const CRITICAL_COVERAGE_TARGET_REGISTRY = Object.freeze([
  target('paper-adapters/automation/automation-runtime-reconciler.mjs'),
  target('paper-adapters/automation/agent-executor-template.mjs'),
  target('paper-adapters/automation/ollama-structured-agent-executor.mjs'),
  target('paper-adapters/automation/empirical-contract-reader.mjs'),
  target('paper-adapters/automation/autonomous-empirical-runtime-preflight.mjs', true),
  target('paper-adapters/automation/system-benchmark-harness.mjs', true),
  target('paper-adapters/build-package/source-package-contract-reader.mjs'),
  target('paper-domain/automation/empirical-contract.mjs'),
  target('paper-domain/automation/academic-analysis-inference-profile.mjs'),
  target('paper-domain/automation/analysis-protocol-contract.mjs'),
  target('paper-domain/automation/analysis-protocol-evaluator.mjs'),
  target('paper-domain/automation/analysis-protocol-run-binding.mjs'),
  target('paper-domain/automation/analysis-statistics.mjs'),
  target('paper-domain/automation/autonomous-empirical-runtime-kernel-execution-binding.mjs'),
  target('paper-domain/automation/autonomous-empirical-execution-profile-policy.mjs'),
  target('paper-domain/automation/autonomous-language-runtime-kernel-registry.mjs'),
  target('paper-domain/automation/campaign-benchmark-selector.mjs'),
  target('paper-domain/automation/experiment-run-contract.mjs'),
  target('paper-domain/automation/system-benchmark-challenge.mjs'),
  target('paper-domain/automation/system-benchmark-evaluator-abi.mjs'),
  target('paper-domain/quality/source-package-contract.mjs'),
  target('paper-adapters/automation/bounded-child-process.mjs'),
  target('paper-adapters/automation/workspace-change-tracker.mjs'),
  target('paper-adapters/automation/workspace-attempt-repository.mjs'),
  target('paper-adapters/automation/isolated-agent-executor.mjs'),
  target('paper-application/automation/campaign-node-executor.mjs'),
  target('paper-application/automation/campaign-execution-budget-policy.mjs'),
  target('paper-application/automation/campaign-empirical-node-orchestrator.mjs'),
  target('paper-application/automation/campaign-empirical-repair-policy.mjs'),
  target('paper-application/automation/campaign-confirmatory-lineage-policy.mjs'),
  target('paper-application/automation/autonomous-research-supervisor.mjs'),
  target('paper-application/automation/autonomous-research-supervisor-autonomy-fence.mjs'),
  target('paper-application/automation/autonomous-research-resident-lifecycle.mjs'),
  target('paper-application/automation/autonomous-research-supervisor-dispatch-authorization.mjs', true),
  target('paper-application/automation/autonomous-research-supervisor-progress.mjs', true),
  target('paper-application/automation/autonomous-research-supervisor-cycle.mjs'),
  target('paper-application/automation/autonomous-research-supervisor-submission-recovery.mjs', true),
  target('paper-application/automation/campaign-agent-execution-boundary.mjs', true),
  target('paper-application/automation/campaign-manuscript-agent-receipts.mjs', true),
  target('paper-application/automation/autonomous-research-campaign.mjs', true),
  target('paper-application/automation/autonomous-research-campaign-submission.mjs', true),
  target('paper-application/automation/autonomous-research-submission-recovery.mjs', true),
  target('paper-application/automation/autonomous-submission-delivery.mjs', true),
  target('paper-adapters/automation/autonomous-submission-outbox-repository.mjs', true),
  target('paper-adapters/automation/autonomous-submission-metadata-profile-reader.mjs'),
  target('paper-adapters/automation/autonomous-venue-profile-registry-reader.mjs'),
  target('paper-adapters/automation/http-autonomous-submission-portal-adapter.mjs', true),
  target('paper-domain/automation/autonomous-submission-contract.mjs', true),
  target('paper-domain/automation/autonomous-submission-delivery-contract.mjs', true),
  target('paper-domain/automation/autonomous-submission-metadata-contract.mjs', true),
  target('paper-domain/automation/autonomous-venue-compliance-contract.mjs', true),
  target('paper-domain/automation/autonomous-venue-profile-contract.mjs', true),
  target('paper-composition/automation/autonomous-submission-request-verifier-composition.mjs', true),
  target('paper-ports/autonomous-submission-outbox-port.mjs'),
  target('paper-ports/autonomous-submission-portal-port.mjs'),
  target('paper-ports/autonomous-venue-compliance-inspector-port.mjs'),
  target('paper-domain/submission/hotcrp-submission-plan.mjs'),
  target('paper-domain/submission/journal-connector-coverage.mjs'),
  target('paper-domain/submission/journal-submission-target-registry.mjs'),
  target('paper-domain/submission/ojs-submission-plan.mjs'),
  target('paper-domain/submission/openreview-submission-plan.mjs'),
  target('paper-domain/submission/submission-connector-family-registry.mjs'),
  target('paper-domain/submission/submission-envelope.mjs'),
  target('paper-domain/submission/submission-portal-binding.mjs'),
  target('paper-ports/hotcrp-client-port.mjs'),
  target('paper-ports/ojs-client-port.mjs'),
  target('paper-ports/openreview-client-port.mjs'),
  target('paper-ports/submission-browser-session-port.mjs'),
  target('paper-ports/submission-commit-permit-authority-port.mjs'),
  target('paper-ports/submission-connector-port.mjs'),
  target('paper-ports/submission-identity-resolver-port.mjs'),
  target('paper-adapters/submission/hotcrp-api-connector.mjs'),
  target('paper-adapters/submission/ojs-api-connector.mjs'),
  target('paper-adapters/submission/openreview-api-connector.mjs'),
  target('paper-adapters/submission/openreview-submission-connector.mjs'),
  target('paper-adapters/submission/playwright-assisted-submission-connector.mjs'),
  target('paper-adapters/submission/submission-connector-router.mjs'),
  target('paper-application/automation/autonomous-research-supervisor-readiness-policy.mjs'),
  target('paper-application/automation/automation-readiness-policy.mjs'),
  target('paper-application/automation/autonomous-research-readiness.mjs'),
  target('paper-application/automation/autonomous-research-supervisor-provider-canary-dispatch.mjs', true),
  target('paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs'),
  target('paper-adapters/automation/autonomous-research-supervisor-instance-state.mjs', true),
  target('paper-adapters/automation/autonomous-research-supervisor-state-model.mjs', true),
  target('paper-adapters/automation/autonomous-research-supervisor-state-provisioning.mjs'),
  target('paper-adapters/automation/autonomous-research-supervisor-state-repository.mjs', true),
  target('paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs', true),
  target('paper-adapters/automation/autonomous-research-supervisor-provider-canary-state-operations.mjs', true),
  target('paper-adapters/automation/autonomous-research-machine-intake-authority.mjs', true),
  target('paper-adapters/automation/autonomous-research-machine-intake-authority-rotation.mjs'),
  target('paper-adapters/automation/autonomous-research-machine-intake-authority-rotation-authorization.mjs', true),
  target('paper-application/automation/autonomous-research-runtime-refresh.mjs'),
  target('paper-adapters/automation/autonomous-research-runtime-refresh-state-repository.mjs'),
  target('paper-adapters/automation/autonomous-research-qualification-state-repository.mjs'),
  target('paper-domain/automation/autonomous-research-state-backup-contract.mjs', true),
  target('paper-domain/automation/autonomous-research-state-safety-contract.mjs', true),
  target('paper-adapters/automation/autonomous-research-state-backup-authority.mjs', true),
  target('paper-adapters/automation/autonomous-research-state-database-inventory.mjs', true),
  target('paper-adapters/automation/autonomous-research-state-backup-repository.mjs', true),
  target('paper-adapters/automation/autonomous-research-state-backup-source-inspection.mjs', true),
  target('paper-adapters/automation/autonomous-research-state-restore-receipt-validation.mjs', true),
  target('paper-composition/bootstrap/autonomous-research-state-backup-composition.mjs', true),
  target('paper-composition/automation/autonomous-research-state-safety-inspection.mjs', true),
  target('paper-core/bin/autonomous-research-state-backup.mjs', true),
  target('paper-adapters/automation/runtime-image-registry.mjs', true),
  target('paper-adapters/automation/runtime-image-build-input-closure.mjs', true),
  target('paper-composition/automation/r-runtime-bootstrap-composition.mjs'),
  target('paper-domain/automation/runtime-reproducibility-refresh-policy.mjs'),
  target('paper-domain/automation/autonomous-research-campaign-execution-admission.mjs'),
  target('paper-domain/automation/autonomous-research-provider-canary-side-effect-inspection.mjs', true),
  target('paper-domain/automation/automation-readiness-side-effect-inspection.mjs', true),
  target('paper-domain/automation/autonomous-research-supervisor-external-action-journal.mjs', true),
  target('paper-composition/automation/autonomous-research-provider-canary.mjs', true),
  target('paper-application/automation/autonomous-research-topic-producer-live-authority.mjs', true),
  target('paper-application/automation/autonomous-research-topic-producer.mjs', true),
  target('paper-adapters/automation/autonomous-research-topic-producer-repository-support.mjs', true),
  target('paper-adapters/automation/autonomous-research-topic-producer-lease-operations.mjs', true),
  target('paper-adapters/automation/autonomous-research-topic-producer-canary-journal-operations.mjs', true),
  target('paper-adapters/automation/autonomous-research-topic-producer-repository.mjs', true),
  target('paper-adapters/automation/autonomous-research-topic-producer-status.mjs'),
  target('paper-composition/automation/automation-readiness-query.mjs'),
  target('paper-composition/automation/automation-readiness-agenda-authority-inspection.mjs', true),
  target('paper-composition/automation/automation-readiness-runtime-probes.mjs'),
  target('paper-composition/automation/autonomous-research-readiness-composition.mjs'),
  target('paper-composition/automation/autonomous-research-external-capability-composition.mjs', true),
  target('paper-composition/automation/autonomous-research-campaign-composition.mjs'),
  target('paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs', true),
  target('paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs', true),
  target('paper-composition/automation/autonomous-research-one-shot-campaign-attempt-state-machine.mjs', true),
  target('paper-composition/automation/autonomous-research-one-shot-campaign-attempt-composition.mjs', true),
  target('paper-core/bin/autonomous-research-one-shot-campaign-attempt.mjs', true),
  target('paper-composition/automation/autonomous-research-submission-composition.mjs'),
  target('paper-composition/automation/autonomous-research-machine-intake-composition.mjs'),
  target('paper-composition/automation/autonomous-research-machine-intake-enqueue-composition.mjs'),
  target('paper-composition/automation/autonomous-research-runtime-principal-preflight.mjs'),
  target('paper-composition/automation/autonomous-research-supervisor-prerequisites.mjs'),
  target('paper-adapters/automation/docker-runtime-image-manifest-inspection.mjs'),
  target('paper-adapters/runtime/sandbox-backend-probe.mjs'),
  target('paper-composition/automation/autonomous-research-supervisor-composition.mjs'),
  target('paper-composition/automation/autonomous-research-supervisor-state-composition.mjs'),
  target('paper-composition/automation/autonomous-research-supervisor-external-action-composition.mjs', true),
  target('paper-composition/automation/autonomous-research-resident-prerequisite-inspection.mjs'),
  target('paper-composition/automation/autonomous-research-enqueue-admission.mjs'),
  target('paper-application/automation/campaign-quality-release-orchestrator.mjs'),
  target('paper-application/automation/campaign-formal-verification-node-orchestrator.mjs'),
  target('paper-adapters/automation/campaign-research-verifier.mjs'),
  target('paper-adapters/automation/theorem-quality-revision-sink.mjs'),
  target('paper-application/automation/campaign-agent-policy.mjs'),
  target('paper-adapters/automation/campaign-node-primitives-adapter.mjs'),
  target('paper-adapters/automation/campaign-node-workspace-support.mjs'),
  target('paper-adapters/automation/campaign-release-packager.mjs'),
  target('paper-adapters/automation/campaign-release-repository.mjs'),
  target('paper-adapters/automation/campaign-formal-review-envelope.mjs'),
  target('paper-adapters/automation/agent-research-agenda-producer.mjs'),
  target('paper-adapters/automation/agent-research-content-producer.mjs'),
  target('paper-adapters/automation/autonomous-manuscript-ir-materialization.mjs'),
  target('paper-adapters/automation/trusted-autonomous-manuscript-renderer.mjs', true),
  target('paper-adapters/automation/trusted-autonomous-manuscript-revalidation.mjs', true),
  target('paper-adapters/automation/external-research-qualification-local-verifier.mjs', true),
  target('paper-adapters/automation/external-research-qualification-process-adapter.mjs', true),
  target('paper-adapters/automation/full-research-qualification-publication-mirror.mjs', true),
  target('paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs', true),
  target('paper-adapters/automation/http-external-research-replay-adapter.mjs', true),
  target('paper-adapters/automation/external-research-replay-identity-attestation.mjs', true),
  target('paper-adapters/automation/external-research-replay-receipt-verifier.mjs', true),
  target('paper-adapters/automation/http-prior-art-retrieval-adapter.mjs', true),
  target('paper-adapters/automation/http-reviewer-receipt-signer-adapter.mjs', true),
  target('paper-adapters/automation/http-recoverable-reviewer-executor-adapter.mjs', true),
  target('paper-adapters/automation/recoverable-reviewer-workspace-snapshot.mjs', true),
  target('paper-adapters/automation/opaque-runtime-credential-file.mjs', true),
  target('paper-adapters/automation/local-autonomous-venue-compliance-inspector.mjs', true),
  target('paper-adapters/automation/campaign-external-research-replay.mjs'),
  target('paper-adapters/automation/reviewer-principal-executor-pool.mjs', true),
  target('paper-adapters/automation/reviewer-principal-pool-configuration-reader.mjs', true),
  target('paper-adapters/automation/reviewer-principal-executor-recovery-port.mjs', true),
  target('paper-adapters/automation/reviewer-principal-signer-recovery-port.mjs', true),
  target('paper-adapters/automation/reviewer-principal-recovery-support.mjs', true),
  target('paper-adapters/automation/reviewer-principal-recovery-ports.mjs', true),
  target('paper-adapters/automation/formal-domain-qualification-recovery-append-only-repository.mjs', true),
  target('paper-adapters/automation/formal-domain-qualification-recovery-filesystem-repository.mjs', true),
  target('paper-adapters/automation/formal-domain-qualification-recovery-generation-contract.mjs', true),
  target('paper-adapters/automation/formal-domain-qualification-recovery-generation-repository.mjs', true),
  target('paper-adapters/automation/formal-domain-qualification-recovery-journal-contract.mjs', true),
  target('paper-adapters/automation/formal-domain-qualification-recovery-journal-repository.mjs', true),
  target('paper-adapters/automation/formal-domain-qualification-recovery-journal.mjs', true),
  target('paper-adapters/automation/formal-domain-qualification-recovery-lock-repository.mjs', true),
  target('paper-adapters/automation/strict-full-auto-acceptance-command-runner.mjs', true),
  target('paper-adapters/automation/strict-full-auto-acceptance-control-file-repository.mjs', true),
  target('paper-adapters/automation/strict-full-auto-acceptance-control-paths.mjs', true),
  target('paper-adapters/automation/strict-full-auto-acceptance-control-store-repository.mjs', true),
  target('paper-adapters/automation/strict-full-auto-acceptance-plan-control-store.mjs', true),
  target('paper-adapters/automation/strict-full-auto-acceptance-repository.mjs', true),
  target('paper-adapters/automation/strict-full-auto-acceptance-root-binding.mjs', true),
  target('paper-application/automation/strict-full-auto-acceptance-live-verification.mjs', true),
  target('paper-application/automation/strict-full-auto-acceptance-orchestrator.mjs', true),
  target('paper-application/automation/strict-full-auto-acceptance-state.mjs', true),
  target('paper-application/automation/external-qualification-recovery.mjs', true),
  target('paper-application/automation/golden-campaign-qualification-controller.mjs', true),
  target('paper-composition/automation/autonomous-research-qualification-composition.mjs', true),
  target('paper-composition/bootstrap/automation-research-authority-composition.mjs'),
  target('paper-adapters/build-package/research-evidence-capsule.mjs'),
  target('paper-adapters/build-package/offline-operator-dataset-authority-verifier.mjs', true),
  target('paper-adapters/build-package/research-execution-release-kms-hardware-attestation.mjs', true),
  target('paper-adapters/build-package/research-execution-release-attestor.mjs', true),
  target('paper-adapters/build-package/local-release-attestor-runtime.mjs', true),
  target('paper-adapters/build-package/local-release-attestor-socket.mjs', true),
  target('paper-adapters/automation/local-autonomous-research-state-authority-socket.mjs', true),
  target('paper-adapters/runtime/atomic-unix-socket-publication.mjs', true),
  target('paper-adapters/build-package/research-execution-release-attestor-inspection.mjs', true),
  target('paper-adapters/build-package/research-execution-release-attestor-inspection-support.mjs', true),
  target('paper-adapters/build-package/offline-research-execution-release-attestation-verifier.mjs', true),
  target('paper-domain/automation/campaign-release-execution-attestation-contract.mjs', true),
  target('paper-domain/automation/research-execution-release-kms-hardware-attestation-contract.mjs', true),
  target('paper-domain/automation/autonomous-research-release-binding-contract.mjs', true),
  target('paper-domain/automation/strict-full-auto-acceptance-plan.mjs', true),
  target('paper-domain/automation/strict-full-auto-acceptance-policy.mjs', true),
  target('paper-domain/automation/autonomous-research-launch-mode-policy.mjs'),
  target('paper-domain/automation/autonomous-research-proposal-contract.mjs'),
  target('paper-domain/automation/autonomous-research-readiness-policy.mjs'),
  target('paper-domain/automation/autonomous-research-topic-producer-contract.mjs'),
  target('paper-domain/automation/full-research-qualification-contract.mjs', true),
  target('paper-domain/automation/full-research-release-qualification-inspection.mjs', true),
  target('paper-domain/automation/trusted-autonomous-manuscript-render-contract.mjs', true),
  target('paper-domain/automation/autonomous-manuscript-release-proof-contract.mjs', true),
  target('paper-domain/automation/autonomous-research-agenda-production-contract.mjs', true),
  target('paper-domain/automation/autonomous-research-capability-scope-manifest.mjs', true),
  target('paper-domain/automation/autonomous-research-content-production-contract.mjs', true),
  target('paper-domain/evidence/isolated-agent-merge-receipt-contract.mjs', true),
  target('paper-domain/evidence/agent-execution-receipt-contract.mjs', true),
  target('paper-domain/research/evidence-bound-manuscript-ir.mjs', true),
  target('paper-domain/research/dynamic-formal-claim-seed-contract.mjs', true),
  target('paper-domain/research/formal-claim-contract.mjs', true),
  target('paper-domain/research/formal-proof-obligation-mapping.mjs', true),
  target('paper-domain/research/lean-type-identity.mjs', true),
  target('paper-domain/research/proposal-claim-to-theorem-binding.mjs', true),
  target('paper-domain/research/research-principal-pool-contract.mjs'),
  target('paper-domain/research/signed-reviewer-receipt-contract.mjs', true),
  target('paper-domain/research/external-research-replay-contract.mjs', true),
  target('paper-domain/research/external-operation-recovery-outcome-contract.mjs', true),
  target('paper-domain/research/native-formal-certificate-intake-v4.mjs', true),
  target('paper-domain/research/prior-art-evidence-contract.mjs', true),
  target('paper-domain/research/theorem-specification.mjs', true),
  target('paper-domain/research/independent-typed-numeric-oracle-recomputation.mjs', true),
  target('paper-domain/research/process-isolated-typed-numeric-oracle-recomputation-contract.mjs'),
  target('paper-domain/research/typed-numeric-oracle-certificate.mjs', true),
  target('paper-domain/research/typed-numeric-oracle-production.mjs', true),
  target('paper-domain/automation/versioned-experiment-ir.mjs'),
  target('paper-domain/automation/autonomous-formal-support-registry.mjs', true),
  target('paper-adapters/research-verify/dynamic-formal-project-closure-readiness.mjs'),
  target('paper-adapters/research-verify/dynamic-formal-sandbox-probe-verifier.mjs', true),
  target('paper-adapters/research-verify/dynamic-formal-execution-authority.mjs', true),
  target('paper-adapters/research-verify/dynamic-formal-sandbox-probe-qualification-repository.mjs', true),
  target('paper-adapters/research-verify/trusted-formal-producer-contract.mjs', true),
  target('paper-ports/external-research-replay-port.mjs', true),
  target('paper-ports/prior-art-retrieval-port.mjs'),
  target('paper-ports/research-agenda-producer-port.mjs'),
  target('paper-ports/research-content-producer-port.mjs'),
  target('paper-ports/reviewer-receipt-signer-port.mjs', true),
  target('paper-composition/automation/reviewer-principal-pool-composition.mjs', true),
  target('paper-composition/automation/formal-domain-qualification-external-evidence-composition.mjs', true),
  target('paper-adapters/runtime/scoped-file-materialization-recovery-record.mjs'),
  target('paper-adapters/runtime/scoped-file-materialization-repository.mjs'),
  target('paper-adapters/automation/multi-language-empirical-executor.mjs'),
  target('paper-adapters/automation/system-benchmark-harness-batch-verification.mjs', true),
  target('paper-adapters/automation/system-benchmark-typed-numeric-process.mjs'),
  target('paper-adapters/research-verify/empirical-assertion-universe-reader.mjs'),
  target('paper-adapters/research-verify/formal-claim-universe-reader.mjs', true),
  target('paper-adapters/research-verify/lake-formal-verifier.mjs', true),
  target('paper-adapters/research-verify/lean-source-contracts.mjs'),
  target('paper-adapters/research-verify/independent-system-benchmark-recomputation.mjs'),
  target('paper-adapters/research-verify/process-isolated-system-benchmark-recomputation.mjs', true),
  target('paper-adapters/research-verify/process-isolated-typed-numeric-oracle-recomputation.mjs'),
  target('paper-adapters/research-verify/evidence-bound-manuscript-surface-reader.mjs'),
  target('paper-adapters/research-verify/independent-system-benchmark-recomputation-worker.mjs'),
  target('paper-adapters/research-verify/independent-typed-numeric-oracle-recomputation-worker.mjs'),
  target('paper-domain/automation/analysis-observation-authority.mjs'),
  target('paper-domain/automation/dataset-evaluation-dependency-contract.mjs', true),
  target('paper-domain/automation/experiment-replay-comparison.mjs'),
  target('paper-domain/automation/experiment-replay-receipt-contract.mjs', true),
  target('paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs', true),
  target('paper-domain/automation/autonomous-empirical-plugin-release-contract.mjs', true),
  target('paper-adapters/automation/autonomous-empirical-plugin-signing-authority.mjs', true),
  target('paper-adapters/automation/autonomous-empirical-plugin-release-repository.mjs', true),
  target('paper-composition/automation/autonomous-empirical-plugin-release-composition.mjs', true),
  target('workflow-kernel/runtime/immutable-signed-json-bundle.mjs', true),
  target('paper-adapters/automation/runtime-retention.mjs'),
  target('paper-adapters/automation/workspace-registry.mjs'),
  target('paper-adapters/automation/workspace-snapshot-exporter.mjs'),
  target('paper-adapters/automation/workspace-retention-evidence.mjs'),
  target('paper-adapters/runtime/docker-worker-container-recovery.mjs', true),
  target('paper-adapters/runtime/os-sandbox-worker-execution-identity.mjs', true),
  target('paper-adapters/runtime/os-sandboxed-worker-runner.mjs', true),
  target('paper-adapters/runtime/runtime-resource-mounts.mjs', true),
  target('paper-adapters/artifacts/filesystem-report-receipt-ledger.mjs'),
  target('paper-adapters/artifacts/filesystem-report-receipt-repository.mjs'),
  target('paper-adapters/persistence/sqlite-workflow-state-store.mjs'),
  target('paper-adapters/persistence/sqlite-store.mjs'),
  target('paper-adapters/persistence/sqlite-unit-of-work.mjs'),
  target('paper-adapters/persistence/sqlite-referee-issue-query.mjs'),
  target('paper-adapters/persistence/sqlite-campaign-release-authority-repository.mjs'),
  target('paper-adapters/persistence/scoped-schema-version-gate.mjs'),
  target('paper-adapters/persistence/store-provider.mjs'),
  target('paper-composition/batch/paper-batch-application.mjs'),
  target('paper-composition/bootstrap/batch-inventory-context-bootstrap.mjs'),
  target('paper-composition/bootstrap/automation-context-bootstrap.mjs'),
  target('paper-composition/bootstrap/capability-scoped-bootstrap.mjs'),
  target('paper-composition/bootstrap/context-foundation-composition.mjs'),
  target('paper-composition/compat/legacy-stage-port-composition.mjs'),
  target('paper-composition/bootstrap/typed-persistence-composition.mjs'),
  target('paper-composition/bootstrap/autonomous-research-native-store-composition.mjs'),
  target('paper-adapters/persistence/sqlite-campaign-store.mjs'),
  target('paper-adapters/persistence/sqlite-campaign-lifecycle-terminal-operations.mjs'),
  target('paper-application/automation/campaign-engine.mjs'),
  target('paper-ports/campaign-store-port.mjs'),
  target('paper-ports/campaign-release-packager-port.mjs'),
  target('paper-ports/campaign-release-authority-port.mjs'),
  target('paper-domain/automation/campaign-release-contracts.mjs'),
  target('paper-domain/automation/campaign-release-evidence-capsule-contract.mjs'),
  target('paper-domain/automation/public-authority-trust-snapshot-contract.mjs', true),
  target('paper-domain/automation/campaign-state-policy.mjs'),
  target('paper-domain/workflow/operational-authority-policy.mjs'),
  target('paper-adapters/submission/campaign-release-bundle-consumer.mjs'),
  target('paper-adapters/submission/submission-authority-orchestrator.mjs', true),
  target('paper-adapters/submission/submission-lifecycle-orchestrator.mjs'),
  target('paper-adapters/submission/sqlite-delivery-persistence.mjs'),
  target('paper-adapters/submission/sqlite-delivery-row-mappers.mjs'),
  target('paper-adapters/submission/sqlite-delivery-outbox-operations.mjs'),
  target('paper-adapters/submission/sqlite-delivery-response-operations.mjs'),
  target('paper-adapters/submission/sqlite-delivery-redrive-operations.mjs'),
  target('paper-adapters/submission/sqlite-delivery-consumption-operations.mjs'),
  target('paper-adapters/persistence/receipt-issuer-policy.mjs', true),
  target('paper-adapters/persistence/receipt-writer-broker.mjs', true),
  target('paper-adapters/persistence/sqlite-receipt-ledger.mjs', true),
  target('paper-adapters/persistence/sqlite-receipt-ledger-qualification.mjs', true),
  target('paper-adapters/persistence/sqlite-job-receipt-store.mjs', true),
  target('paper-composition/bootstrap/receipt-ledger-composition.mjs', true),
  target('paper-core/bin/hepta-store.mjs', true),
  target('paper-core/bin/release-integrity-key-storage.mjs', true),
  target('paper-core/bin/release-integrity-key-reader.mjs', true),
  target('paper-core/bin/release-integrity-key-provisioning.mjs', true),
  target('paper-core/bin/automation-status.mjs'),
  target('paper-adapters/empirical-analysis/trusted-experiment-producer.mjs', true),
  target('paper-adapters/research-verify/trusted-formal-producer.mjs', true),
  target('paper-adapters/research-verify/worker-runtime.mjs'),
  target('paper-adapters/research-verify/formal-review-envelope-verifier.mjs', true),
  target('paper-adapters/research-verify/research-evidence-candidates.mjs'),
  target('paper-adapters/research-verify/research-evidence-reader.mjs'),
  target('paper-adapters/research-verify/research-report-builder.mjs'),
  target('paper-adapters/referee-revise/repair-patch-bundle.mjs'),
  target('paper-adapters/referee-revise/repair-apply-executor.mjs'),
  target('paper-adapters/referee-revise/repair-rollback-executor.mjs'),
  target('paper-adapters/referee-revise/repair-proof-builder.mjs'),
  target('paper-domain/evidence/receipt-hash-policy.mjs', true),
  target('paper-domain/evidence/receipt-hash-selector.mjs'),
  target('paper-domain/evidence/trusted-ledger-receipt.mjs', true),
  target('paper-domain/governance/release-trust-layer-gate.mjs', true),
  target('paper-adapters/governance/external-intake-verifier.mjs', true),
  target('paper-core/bin/verify-external-intake.mjs'),
  target('paper-domain/research/evidence-quality-gate.mjs'),
  target('paper-domain/research/experiment-evidence-binding.mjs'),
  target('paper-domain/research/formal-certificate-intake.mjs', true),
  target('paper-domain/research/formal-certificate-intake-primitives.mjs', true),
  target('paper-domain/research/formal-certificate-native-closure.mjs', true),
  target('paper-domain/research/formal-certificate-intake-builder.mjs', true),
  target('paper-adapters/referee-revise/planning-service.mjs'),
  target('paper-adapters/submission/live-authorization.mjs', true),
  target('paper-application/reporting/metric-descriptor-collector.mjs'),
  target('paper-domain/automation/nested-runtime-platform-qualification-contract.mjs', true),
  target('paper-domain/automation/nested-runtime-authority-independence-contract.mjs', true),
  target('paper-adapters/automation/nested-runtime-platform-qualification-verifier.mjs', true),
  target('paper-composition/automation/nested-runtime-platform-qualification-composition.mjs', true),
  target('paper-core/bin/nested-runtime-platform-qualification.mjs', true),
  target('paper-core/verification/critical-module-coverage-policy.mjs'),
  target('paper-adapters/runtime/immutable-release-workspace-repository.mjs', true),
  target('paper-adapters/runtime/release-dependency-tree.mjs', true),
]);


export const CRITICAL_COVERAGE_TARGET_OVERRIDES = Object.freeze({
  'paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 87,
    trustBoundary: true,
    reviewedAttackSurface: ['binding-integrity', 'phase-transition', 'terminal-replay'],
    rationale:
      'One-shot authority contract validates exact nested bindings and all recovery phases; direct tests cover immutable provider projection, CAS replay, terminal recovery, and mutation gating.',
  }),
  'paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 60,
    trustBoundary: true,
    reviewedAttackSurface: ['append-only-journal', 'filesystem-identity', 'side-effect-permit'],
    rationale:
      'Journal adapter retains SQLite and filesystem fault branches; tests cover canonical hash chains, no-replace triggers, commit ambiguity, stale replay, and single-use permits.',
  }),
  'paper-adapters/automation/workspace-attempt-repository.mjs': exception({
    lines: 80,
    functions: 85,
    maxUncoveredBranchBlocks: 110,
    trustBoundary: false,
    reviewedAttackSurface: ['path-containment', 'attempt-fencing', 'rollback'],
    rationale:
      'Large filesystem transaction adapter; direct tests cover containment, fencing, no-clobber publication, rollback, and crash cleanup.',
  }),
  'paper-adapters/automation/isolated-agent-executor.mjs': exception({
    lines: 75,
    functions: 80,
    maxUncoveredBranchBlocks: 60,
    trustBoundary: false,
    reviewedAttackSurface: ['workspace-isolation', 'merge-receipt', 'abort'],
    rationale:
      'Large isolation adapter with platform-specific cleanup branches; direct tests cover escape rejection, abort propagation, and merge authority.',
  }),
  'paper-application/automation/campaign-node-executor.mjs': exception({
    lines: 55,
    functions: 50,
    maxUncoveredBranchBlocks: 110,
    trustBoundary: false,
    reviewedAttackSurface: ['node-admission', 'attempt-fencing', 'receipt-binding'],
    rationale:
      'Central typed node dispatcher has a broad node-kind matrix; tests cover admission, authority binding, stale attempts, and terminal receipts.',
  }),
  'paper-adapters/runtime/scoped-file-materialization-repository.mjs': exception({
    lines: 80,
    functions: 90,
    maxUncoveredBranchBlocks: 70,
    trustBoundary: false,
    reviewedAttackSurface: ['path-containment', 'symlink-defense', 'crash-recovery'],
    rationale:
      'Filesystem materializer has OS-error and recovery branches; tests cover symlink, traversal, no-clobber, identity drift, and interrupted writes.',
  }),
  'paper-adapters/automation/system-benchmark-harness.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 56,
    trustBoundary: true,
    reviewedAttackSurface: ['dataset-authority', 'process-receipt', 'output-integrity'],
    rationale:
      'Multi-language benchmark authority retains runtime-specific validation branches; integrity tests attack dataset, process, and output bindings.',
  }),
  'paper-application/automation/autonomous-research-campaign.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 81,
    trustBoundary: true,
    reviewedAttackSurface: ['campaign-admission', 'release-binding', 'abort'],
    rationale:
      'Campaign aggregate spans typed node families and terminal states; boundary tests cover invalid admission, release lineage, stale state, and aborts.',
  }),
  'paper-domain/automation/autonomous-submission-contract.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 55,
    trustBoundary: true,
    reviewedAttackSurface: ['submission-binding', 'receipt-integrity', 'replay'],
    rationale:
      'Submission contract validates several venue-specific optional projections; tests cover binding tamper, receipt reseal, and replay isolation.',
  }),
  'paper-domain/automation/autonomous-venue-compliance-contract.mjs': exception({
    lines: 90,
    functions: 95,
    maxUncoveredBranchBlocks: 81,
    trustBoundary: true,
    reviewedAttackSurface: ['venue-policy', 'release-artifacts', 'compliance-receipt'],
    rationale:
      'Venue compliance validates a broad optional policy matrix; release-fixture tests cover artifact drift, metadata, limits, profile binding, and receipt verification.',
  }),
  'paper-adapters/automation/autonomous-research-state-database-inventory.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 57,
    trustBoundary: true,
    reviewedAttackSurface: ['database-identity', 'symlink-defense', 'schema-drift'],
    rationale:
      'State inventory handles multiple database families and file identities; tests cover path substitution, schema drift, and incomplete inventory.',
  }),
  'paper-adapters/automation/autonomous-research-state-backup-repository.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 49,
    trustBoundary: true,
    reviewedAttackSurface: ['snapshot-integrity', 'journal-replay', 'no-clobber'],
    rationale:
      'Backup repository retains backend error branches; tests cover signed snapshots, finalized-journal replay, collision, and marker tampering.',
  }),
  'paper-composition/automation/autonomous-research-external-capability-composition.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 53,
    trustBoundary: true,
    reviewedAttackSurface: ['principal-separation', 'credential-aliasing', 'authority-wiring'],
    rationale:
      'External authority composition has provider-version matrices; tests cover missing trust, aliased credentials, identity separation, and wiring.',
  }),
  'paper-adapters/automation/http-external-research-replay-adapter.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 61,
    trustBoundary: true,
    reviewedAttackSurface: ['signed-recovery', 'pre-abort', 'response-tamper'],
    rationale:
      'Versioned HTTP replay protocol retains transport failure branches; tests cover pre-abort zero-fetch, signed recovery, expiry, and response tamper.',
  }),
  'paper-adapters/automation/http-reviewer-receipt-signer-adapter.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 71,
    trustBoundary: true,
    reviewedAttackSurface: ['opaque-secret', 'signed-recovery', 'pre-abort'],
    rationale:
      'Versioned signer protocol includes credential and recovery matrices; tests cover opaque-file secrets, zero-fetch abort, signatures, and lookup.',
  }),
  'paper-adapters/automation/http-recoverable-reviewer-executor-adapter.mjs': exception({
    lines: 80,
    functions: 75,
    maxUncoveredBranchBlocks: 66,
    trustBoundary: true,
    reviewedAttackSurface: ['workspace-snapshot', 'signed-recovery', 'pre-abort'],
    rationale:
      'Recoverable reviewer protocol is a large signed HTTP state machine; direct tests cover snapshot drift, tamper, definitive-not-found, and abort.',
  }),
  'paper-domain/automation/strict-full-auto-acceptance-plan.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 57,
    trustBoundary: true,
    reviewedAttackSurface: ['configuration-injection', 'path-containment', 'authority-reference'],
    rationale:
      'Strict acceptance plan validates a large immutable configuration schema; tests cover secret injection, escaped paths, missing authority, and hash drift.',
  }),
  'paper-adapters/automation/local-autonomous-venue-compliance-inspector.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 52,
    trustBoundary: true,
    reviewedAttackSurface: ['venue-policy', 'template-binding', 'artifact-integrity'],
    rationale:
      'Venue inspection supports heterogeneous policy profiles; tests cover signed profiles, template substitution, missing artifacts, and hash mismatch.',
  }),
  'paper-domain/automation/autonomous-research-release-binding-contract.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 51,
    trustBoundary: true,
    reviewedAttackSurface: ['release-lineage', 'claim-binding', 'outer-reseal'],
    rationale:
      'Release binding validates a wide immutable evidence projection; tests cover claim substitution, lineage mismatch, missing authority, and resealing.',
  }),
  'paper-domain/automation/autonomous-formal-support-registry.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 52,
    trustBoundary: true,
    reviewedAttackSurface: ['profile-registry', 'kernel-binding', 'unsupported-domain'],
    rationale:
      'Formal support registry contains explicit domain and kernel matrices; tests cover unsupported profiles, kernel mismatch, and registry tampering.',
  }),
  'paper-adapters/research-verify/lake-formal-verifier.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 55,
    trustBoundary: true,
    reviewedAttackSurface: ['source-containment', 'toolchain-binding', 'process-failure'],
    rationale:
      'Lean verifier retains platform and process diagnostic branches; tests cover source escape, toolchain mismatch, timeout, and proof failure.',
  }),
  'paper-adapters/research-verify/trusted-formal-producer.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 70,
    trustBoundary: true,
    reviewedAttackSurface: ['formal-receipt', 'source-lineage', 'claim-manifest'],
    rationale:
      'Trusted formal producer validates a broad certificate projection; tests cover receipt replacement, source drift, missing lineage, and manifest tamper.',
  }),
  'paper-domain/research/formal-certificate-native-closure.mjs': exception({
    lines: 90,
    functions: 90,
    maxUncoveredBranchBlocks: 92,
    trustBoundary: true,
    reviewedAttackSurface: ['native-receipt', 'claim-binding', 'replay-closure'],
    rationale:
      'Native formal closure verification checks a dense immutable receipt projection; tests cover report, receipt, replay, claim, source, and ledger substitutions.',
  }),
  'paper-adapters/runtime/docker-worker-container-recovery.mjs': exception({
    lines: 80,
    functions: 95,
    maxUncoveredBranchBlocks: 51,
    trustBoundary: true,
    reviewedAttackSurface: ['container-ownership', 'cleanup-retry', 'cold-start-recovery'],
    rationale:
      'Docker recovery retains daemon timing and uncertain-inspection branches; tests cover ownership mismatch, partial cleanup, absence, timeout, and cold-start reconciliation.',
  }),
  'paper-adapters/runtime/os-sandboxed-worker-runner.mjs': exception({
    lines: 85,
    functions: 85,
    maxUncoveredBranchBlocks: 102,
    trustBoundary: true,
    reviewedAttackSurface: ['execution-identity', 'filesystem-isolation', 'resource-limits'],
    rationale:
      'The OS sandbox runner spans Docker and bubblewrap platform branches; tests cover identity replay, path escape, dataset drift, output bounds, cancellation, and immutable mounts.',
  }),
  'paper-adapters/automation/nested-runtime-platform-qualification-verifier.mjs': exception({
    lines: 90,
    functions: 95,
    maxUncoveredBranchBlocks: 54,
    trustBoundary: true,
    reviewedAttackSurface: ['authority-independence', 'pod-binding', 'signed-evidence'],
    rationale:
      'Nested runtime qualification validates independently signed platform and Pod evidence; tests cover signer aliasing, byte drift, expiry, profile mismatch, and deployment identity.',
  }),
});

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort())
      === JSON.stringify([...expected].sort());
}

function validThreshold(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

export function validateCriticalCoverageTargetRegistry({
  targetRegistry = CRITICAL_COVERAGE_TARGET_REGISTRY,
} = {}) {
  if (!Array.isArray(targetRegistry)) {
    throw new Error('critical_coverage_target_registry_invalid');
  }
  const paths = new Set();
  for (const [index, entry] of targetRegistry.entries()) {
    const relative = entry?.path || String(index);
    if (!exactKeys(entry, EXACT_TARGET_KEYS)
      || typeof entry.path !== 'string'
      || !entry.path.endsWith('.mjs')
      || entry.path.startsWith('/')
      || entry.path.includes('\\')
      || entry.path.split('/').includes('..')
      || typeof entry.trustBoundary !== 'boolean'
      || paths.has(entry.path)) {
      throw new Error(`critical_coverage_target_registry_invalid:${relative}`);
    }
    paths.add(entry.path);
  }
  return true;
}

function registeredTrustTargets() {
  validateCriticalCoverageTargetRegistry();
  return new Set(CRITICAL_COVERAGE_TARGET_REGISTRY
    .filter((entry) => entry.trustBoundary)
    .map((entry) => entry.path));
}

export function validateCriticalCoveragePolicy({
  trustTargets = registeredTrustTargets(),
  targetOverrides = CRITICAL_COVERAGE_TARGET_OVERRIDES,
} = {}) {
  if (!(trustTargets instanceof Set)
    || !targetOverrides || typeof targetOverrides !== 'object'
    || Array.isArray(targetOverrides)) {
    throw new Error('critical_coverage_policy_invalid');
  }
  for (const [relative, override] of Object.entries(targetOverrides)) {
    const baseline = trustTargets.has(relative)
      ? TRUST_BOUNDARY_THRESHOLD : DEFAULT_THRESHOLD;
    if (!relative.endsWith('.mjs') || !exactKeys(override, EXACT_OVERRIDE_KEYS)
      || override.auditKind !== AUDITED_EXCEPTION_KIND
      || override.trustBoundary !== trustTargets.has(relative)
      || !validThreshold(override.lines)
      || !validThreshold(override.functions)
      || override.lines < baseline.lines
      || override.functions < baseline.functions
      || !Number.isSafeInteger(override.maxUncoveredBranchBlocks)
      || override.maxUncoveredBranchBlocks < 0
      || override.maxUncoveredBranchBlocks > MAXIMUM_AUDITED_BRANCH_CAP
      || !Array.isArray(override.reviewedAttackSurface)
      || override.reviewedAttackSurface.length < 2
      || override.reviewedAttackSurface.some((item) => (
        typeof item !== 'string' || item.length < 3
      ))
      || new Set(override.reviewedAttackSurface).size
        !== override.reviewedAttackSurface.length
      || typeof override.rationale !== 'string'
      || override.rationale.length < 80) {
      throw new Error(`critical_coverage_target_override_invalid:${relative}`);
    }
  }
  return true;
}

export function buildCriticalCoverageTargetThresholds({
  trustTargets = registeredTrustTargets(),
} = {}) {
  validateCriticalCoveragePolicy({ trustTargets });
  return new Map(Object.entries(CRITICAL_COVERAGE_TARGET_OVERRIDES).map(
    ([relative, override]) => Object.freeze([
      relative,
      Object.freeze({
        lines: override.lines,
        functions: override.functions,
        maxUncoveredBranchBlocks: override.maxUncoveredBranchBlocks,
      }),
    ]),
  ));
}

export function buildCriticalCoveragePolicy({
  leadingTargets = [],
  targetRegistry = CRITICAL_COVERAGE_TARGET_REGISTRY,
  trailingTargets = [],
} = {}) {
  for (const candidates of [leadingTargets, targetRegistry, trailingTargets]) {
    validateCriticalCoverageTargetRegistry({ targetRegistry: candidates });
  }
  const mergedTargets = new Map();
  for (const entry of [...leadingTargets, ...targetRegistry, ...trailingTargets]) {
    const existing = mergedTargets.get(entry.path);
    if (!existing || (!existing.trustBoundary && entry.trustBoundary)) {
      mergedTargets.set(entry.path, target(entry.path, entry.trustBoundary));
    }
  }
  const registry = Object.freeze([...mergedTargets.values()]);
  const targets = Object.freeze(registry.map((entry) => entry.path));
  const trustTargets = new Set(registry
    .filter((entry) => entry.trustBoundary)
    .map((entry) => entry.path));
  const targetThresholds = buildCriticalCoverageTargetThresholds({ trustTargets });
  return Object.freeze({ registry, targets, trustTargets, targetThresholds });
}

export const CRITICAL_COVERAGE_DEFAULT_THRESHOLD = DEFAULT_THRESHOLD;
export const CRITICAL_COVERAGE_TRUST_BOUNDARY_THRESHOLD =
  TRUST_BOUNDARY_THRESHOLD;
export const CRITICAL_COVERAGE_MAXIMUM_AUDITED_BRANCH_CAP =
  MAXIMUM_AUDITED_BRANCH_CAP;
