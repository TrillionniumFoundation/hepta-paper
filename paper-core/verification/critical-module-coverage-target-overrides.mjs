export const CRITICAL_COVERAGE_AUDITED_EXCEPTION_KIND =
  'audited_large_branch_surface';

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
    auditKind: CRITICAL_COVERAGE_AUDITED_EXCEPTION_KIND,
    reviewedAttackSurface: Object.freeze([...reviewedAttackSurface]),
    rationale,
  });
}

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
    lines: 90,
    functions: 95,
    maxUncoveredBranchBlocks: 59,
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
  'paper-composition/automation/automation-readiness-query.mjs': exception({
    lines: 90,
    functions: 60,
    maxUncoveredBranchBlocks: 52,
    trustBoundary: true,
    reviewedAttackSurface: ['authority-aggregation', 'snapshot-fencing', 'blocker-projection'],
    rationale:
      'Readiness aggregation spans optional authority families and fail-closed blocker projections; policy and end-to-end tests cover absent authorities, stale snapshots, topology drift, and current-state replay.',
  }),
  'paper-composition/automation/automation-readiness-research-assurance-authority-inspection.mjs': exception({
    lines: 55,
    functions: 55,
    maxUncoveredBranchBlocks: 92,
    trustBoundary: true,
    reviewedAttackSurface: ['formal-review-authority', 'research-replay-lineage', 'gpu-snapshot-fencing'],
    rationale:
      'Research assurance inspection joins formal review, experiment replay, external research, and GPU evidence against one current snapshot; adversarial tests cover query failure, generation drift, archive mismatch, invalid signatures, and missing current verifiers.',
  }),
  'paper-composition/automation/automation-readiness-experiment-ir-authority-inspection.mjs': exception({
    lines: 80,
    functions: 95,
    maxUncoveredBranchBlocks: 97,
    trustBoundary: true,
    reviewedAttackSurface: ['canonical-result-hash', 'replay-lineage', 'campaign-snapshot'],
    rationale:
      'Experiment-IR authority inspection validates replay and original rows, hashes, revisions, lease attempts, and status snapshots; persistence tests mutate each binding and require fail-closed readiness.',
  }),
  'paper-adapters/automation/campaign-release-materialization.mjs': exception({
    lines: 90,
    functions: 95,
    maxUncoveredBranchBlocks: 65,
    trustBoundary: true,
    reviewedAttackSurface: ['generation-fencing', 'atomic-publication', 'completed-replay'],
    rationale:
      'Release materialization is a large crash-recoverable filesystem transaction; immutable package tests cover fencing, completed replay, no-clobber publication, identity drift, and successor generations.',
  }),
  'paper-adapters/automation/campaign-release-packager.mjs': exception({
    lines: 85,
    functions: 85,
    maxUncoveredBranchBlocks: 119,
    trustBoundary: true,
    reviewedAttackSurface: ['source-lineage', 'post-adapter-freshness', 'runtime-fencing'],
    rationale:
      'Release packaging spans source lineage, topology, runtime authority, post-adapter freshness, and artifact assembly; adversarial tests cover missing dependencies, cancellation, archive substitution, blocked packages, and absent compiled output.',
  }),
  'paper-adapters/automation/campaign-release-package-build-transaction-repository.mjs': exception({
    lines: 80,
    functions: 95,
    maxUncoveredBranchBlocks: 60,
    trustBoundary: true,
    reviewedAttackSurface: ['prepared-identity', 'staging-ownership', 'generation-fencing'],
    rationale:
      'Build transaction repository enforces PREPARED identity, staging ownership, generation fencing, and exact recovery; tests cover duplicate begin, tamper, stale successors, and completion ambiguity.',
  }),
  'paper-adapters/automation/campaign-release-package-transaction-repository.mjs': exception({
    lines: 75,
    functions: 95,
    maxUncoveredBranchBlocks: 66,
    trustBoundary: true,
    reviewedAttackSurface: ['journal-transition', 'generation-fencing', 'historical-replay'],
    rationale:
      'Package transaction repository coordinates immutable journal states across build and recovery; tests cover transition tamper, stale generations, exact replay, and completed historical readability.',
  }),
  'paper-adapters/submission/handoff-bundle-detached-records.mjs': exception({
    lines: 85,
    functions: 95,
    maxUncoveredBranchBlocks: 53,
    trustBoundary: true,
    reviewedAttackSurface: ['portable-record-path', 'record-set-integrity', 'release-lineage'],
    rationale:
      'Detached record graph validates portable paths, canonical bytes, exact record sets, release lineage, and manifest bindings; adversarial tests cover missing, extra, duplicate, and tampered records.',
  }),
  'paper-adapters/submission/handoff-bundle-exporter.mjs': exception({
    lines: 90,
    functions: 95,
    maxUncoveredBranchBlocks: 60,
    trustBoundary: true,
    reviewedAttackSurface: ['authority-freshness', 'staged-publication', 'detached-lineage'],
    rationale:
      'Handoff exporter spans staged filesystem publication, current authority revalidation, detached lineage, and crash recovery; tests cover boundary drift, write faults, stale authority, and replay.',
  }),
  'paper-adapters/submission/handoff-bundle-integrity.mjs': exception({
    lines: 90,
    functions: 95,
    maxUncoveredBranchBlocks: 51,
    trustBoundary: true,
    reviewedAttackSurface: ['sealed-tree-identity', 'manifest-integrity', 'resource-bounds'],
    rationale:
      'Bundle integrity verification walks a bounded sealed tree and validates canonical manifests, file identity, hashes, and resource limits; tests attack symlinks, hardlinks, extras, depth, and byte limits.',
  }),
  'paper-adapters/submission/handoff-bundle-recovery.mjs': exception({
    lines: 90,
    functions: 95,
    maxUncoveredBranchBlocks: 52,
    trustBoundary: true,
    reviewedAttackSurface: ['journal-phase-replay', 'request-binding', 'detached-proof-parity'],
    rationale:
      'Publication recovery validates journal phases, exact request binding, final-tree identity, and detached proof parity; tests cover prepared and completed crashes, tamper, mismatched replay, and lineage restoration.',
  }),
  'paper-adapters/submission/sqlite-submission-handoff-export-authority-query.mjs': exception({
    lines: 90,
    functions: 95,
    maxUncoveredBranchBlocks: 95,
    trustBoundary: true,
    reviewedAttackSurface: ['read-only-snapshot', 'durable-authority-binding', 'provider-signature-revalidation', 'receipt-ledger'],
    rationale:
      'Read-only authority query validates one coherent SQLite snapshot, durable payload hashes, issuer policy, and current provider signatures; tamper tests cover rows, payloads, schedules, timestamps, and ledger lineage.',
  }),
  'paper-domain/submission/submission-handoff-export-request.mjs': exception({
    lines: 85,
    functions: 95,
    maxUncoveredBranchBlocks: 71,
    trustBoundary: true,
    reviewedAttackSurface: ['request-binding', 'path-containment', 'authority-lineage'],
    rationale:
      'Export request contract binds every submission, package, authority, detached-root, and output-root field into one immutable request; tests cover missing records, hash substitution, path escape, and resealing.',
  }),
  'paper-adapters/automation/trusted-autonomous-manuscript-renderer.mjs': exception({
    lines: 85,
    functions: 80,
    maxUncoveredBranchBlocks: 56,
    trustBoundary: true,
    reviewedAttackSurface: ['manuscript-ir', 'toolchain-identity', 'output-attestation'],
    rationale:
      'Trusted renderer validates manuscript IR, template and toolchain identity, output hashes, and attestation lineage; tests cover source mutation, renderer substitution, output tamper, and receipt mismatch.',
  }),
  'paper-adapters/automation/trusted-autonomous-manuscript-revalidation.mjs': exception({
    lines: 70,
    functions: 65,
    maxUncoveredBranchBlocks: 72,
    trustBoundary: true,
    reviewedAttackSurface: ['source-freshness', 'artifact-integrity', 'attestation-lineage'],
    rationale:
      'Trusted manuscript revalidation checks rendered artifacts against current source, policy, and attestation lineage; tests cover stale sources, altered outputs, receipt substitution, and incomplete evidence.',
  }),
  'paper-domain/automation/gpu-scientific-artifact-body-archive-contract.mjs': exception({
    lines: 90,
    functions: 95,
    maxUncoveredBranchBlocks: 80,
    trustBoundary: true,
    reviewedAttackSurface: ['artifact-body-binding', 'runtime-lineage', 'replay-metadata'],
    rationale:
      'GPU artifact archive contract validates canonical bodies, descriptors, hashes, runtime lineage, and bounded replay metadata; tests cover body tamper, descriptor drift, missing evidence, and outer resealing.',
  }),
  'paper-domain/automation/gpu-scientific-release-authority-freshness-receipt-contract.mjs': exception({
    lines: 95,
    functions: 95,
    maxUncoveredBranchBlocks: 69,
    trustBoundary: true,
    reviewedAttackSurface: ['campaign-snapshot', 'release-topology', 'qualification-lineage'],
    rationale:
      'GPU release freshness receipt binds the exact campaign plan, release topology, qualification, archive, and observation snapshot; tests mutate each authority hash and reject stale or resealed receipts.',
  }),
  'paper-adapters/build-package/offline-operator-dataset-authority-verifier.mjs': exception({
    lines: 90,
    functions: 90,
    maxUncoveredBranchBlocks: 54,
    trustBoundary: true,
    reviewedAttackSurface: ['dataset-identity', 'signature-verification', 'path-containment'],
    rationale:
      'Offline dataset authority verifier pins dataset files, manifests, signatures, hashes, and filesystem identities before use; tests cover path substitution, byte drift, signer mismatch, and malformed authority.',
  }),
  'paper-domain/automation/full-research-release-qualification-inspection.mjs': exception({
    lines: 80,
    functions: 85,
    maxUncoveredBranchBlocks: 101,
    trustBoundary: true,
    reviewedAttackSurface: ['evidence-aggregation', 'authority-freshness', 'cross-family-binding'],
    rationale:
      'Full research release qualification inspection aggregates broad empirical, formal, reviewer, venue, and reproducibility evidence; tests cover missing authorities, stale receipts, hash drift, and cross-family substitution.',
  }),
});
