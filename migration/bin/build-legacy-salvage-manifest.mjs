#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyLegacyFile } from '../retirement/classification.mjs';
import { LEGACY_CAPABILITY_MATRIX_V3 } from '../legacy-capability-matrix-v3.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceRootIndex = process.argv.indexOf('--source-root');
const requestedSourceRoot = sourceRootIndex >= 0 ? process.argv[sourceRootIndex + 1] : null;
if (!process.argv.includes('--historical-regeneration') || !requestedSourceRoot) {
  throw new Error('historical_salvage_regeneration_requires_explicit_source_root');
}
const legacyRoot = path.resolve(requestedSourceRoot);
if (!fs.existsSync(legacyRoot) || !fs.statSync(legacyRoot).isDirectory()) {
  throw new Error(`historical_salvage_source_root_missing:${legacyRoot}`);
}
const outputPath = path.join(workspaceRoot, 'migration', 'legacy-salvage-manifest.v1.json');
const allowedExtensions = new Set(['.py', '.rs', '.lean', '.sql', '.md', '.json', '.yaml', '.yml', '.toml']);
const roots = ['paperctl_modules', 'rust', 'PaperFactoryFormalVerifier', 'schema', 'docs', 'tests'];
const excludedDirectories = new Set(['.git', '__pycache__', 'target']);

function digest(bytes) { return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`; }
function targetRecord(relative) {
  const candidate = path.join(workspaceRoot, relative);
  return { path: relative, hash: fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? digest(fs.readFileSync(candidate)) : null };
}
function walk(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) out.push(...walk(candidate));
    else if (entry.isFile() && allowedExtensions.has(path.extname(entry.name).toLowerCase())) out.push(candidate);
  }
  return out;
}

const semantic = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'migration', 'legacy-semantic-migration-matrix.json'), 'utf8'));
const semanticByPath = new Map(semantic.entries.map((entry) => [entry.source.path, entry]));
const capabilityByLegacyId = new Map(LEGACY_CAPABILITY_MATRIX_V3.entries.map((entry) => [entry.legacyMatrixEntryId, entry]));
const overrides = new Map([
  ['paperctl_modules/paper_workflow.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-domain/quality/theorem-manuscript-readiness-policy.mjs', 'paper-adapters/automation/theorem-manuscript-readiness-check.mjs'], evidence: ['paper-core/tests/theorem-manuscript-readiness-policy.test.mjs'] }],
  ['paperctl_modules/report_ref_health.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-domain/evidence/evidence-consumption-policy.mjs', 'paper-domain/evidence/dependency-freshness-policy.mjs'], evidence: ['paper-core/tests/evidence-consumption-policy.test.mjs', 'paper-core/tests/dependency-freshness-policy.test.mjs'] }],
  ['paperctl_modules/llm_consumption.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-adapters/referee-revise/decision-routing.mjs'], evidence: ['migration/tests/p1-referee-revision-differential.mjs'] }],
  ['schema/paper_factory_schema.sql', { disposition: 'verified_behavioral_replacement', targets: ['paper-adapters/persistence/legacy-history-snapshot-repository.mjs', 'paper-adapters/persistence/legacy-history-translator-repository.mjs'], evidence: ['paper-core/tests/legacy-history-snapshot.test.mjs'] }],
  ['paperctl_modules/paper_production_target_scope_audit.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-domain/automation/target-scope-policy.mjs'], evidence: ['paper-core/tests/manuscript-promotion-boundaries.test.mjs'] }],
  ['paperctl_modules/paper_production_v2_semantic_release_lock.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-domain/submission/semantic-promotion-lock.mjs'], evidence: ['paper-core/tests/manuscript-promotion-boundaries.test.mjs'] }],
  ['paperctl_modules/paper_production_artifact_maturity_queue.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-domain/quality/manuscript-promotion-gate.mjs', 'paper-adapters/build-package/package-verifier.mjs'], evidence: ['paper-core/tests/package-verifier.test.mjs', 'paper-core/tests/manuscript-promotion-boundaries.test.mjs'] }],
  ['paperctl_modules/paper_production_final_settlement_gate.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-domain/quality/manuscript-promotion-gate.mjs', 'paper-domain/submission/semantic-promotion-lock.mjs'], evidence: ['paper-core/tests/package-verifier.test.mjs', 'paper-core/tests/manuscript-promotion-boundaries.test.mjs'] }],
  ['paperctl_modules/research_compute_experiment_registry.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-domain/research/experiment-registry.mjs', 'paper-domain/research/experiment-acceptance-policy.mjs', 'paper-domain/research/experiment-profiles.mjs', 'paper-domain/research/experiment-evidence-binding.mjs', 'paper-domain/evidence/trusted-ledger-receipt.mjs', 'paper-adapters/runtime/os-sandboxed-worker-runner.mjs'], evidence: ['paper-core/tests/experiment-acceptance-policy.test.mjs', 'paper-core/tests/legacy-salvage-boundary-hardening.test.mjs', 'paper-core/tests/legacy-provenance-delivery-hardening.test.mjs', 'paper-core/tests/automation-executors.test.mjs'] }],
  ['paperctl_modules/research_compute_formal_verifier_adapter.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-adapters/research-verify/lake-formal-verifier.mjs', 'paper-adapters/research-verify/worker-runtime.mjs', 'paper-adapters/runtime/os-sandboxed-worker-runner.mjs', 'paper-domain/research/formal-verifier-registry.mjs', 'paper-domain/research/formal-certificate-intake.mjs', 'paper-domain/evidence/trusted-ledger-receipt.mjs'], evidence: ['paper-core/tests/lean-source-formal-verifier.test.mjs', 'paper-core/tests/formal-claim-binding-policy.test.mjs', 'paper-core/tests/verification-runtime-isolation.test.mjs', 'paper-core/tests/legacy-salvage-boundary-hardening.test.mjs', 'paper-core/tests/legacy-provenance-delivery-hardening.test.mjs'] }],
  ['paperctl_modules/research_compute_formal_verifier_certificate_intake.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-domain/research/formal-certificate-intake.mjs', 'paper-domain/research/formal-verifier-registry.mjs', 'paper-domain/evidence/trusted-ledger-receipt.mjs', 'paper-adapters/runtime/os-sandboxed-worker-runner.mjs'], evidence: ['paper-core/tests/lean-source-formal-verifier.test.mjs', 'paper-core/tests/verification-runtime-isolation.test.mjs', 'paper-core/tests/legacy-salvage-boundary-hardening.test.mjs', 'paper-core/tests/legacy-provenance-delivery-hardening.test.mjs'] }],
  ['paperctl_modules/paper_production_submission_lifecycle.py', { disposition: 'partial_semantic_replacement', targets: ['paper-domain/submission/delivery-runtime.mjs', 'paper-domain/submission/redrive-decision.mjs', 'paper-domain/submission/live-delivery-evidence.mjs', 'paper-adapters/submission/live-authorization.mjs', 'paper-adapters/submission/venue-observation-verification.mjs', 'paper-adapters/submission/redrive-review-verification.mjs', 'paper-adapters/submission/provider-capability-verification.mjs', 'paper-adapters/submission/sqlite-delivery-store.mjs', 'store/migrations/015_submission_boundary_hardening.sql', 'store/migrations/016_submission_delivery_leases.sql'], evidence: ['paper-core/tests/submission-live-delivery.test.mjs', 'migration/tests/capabilities/submission.delivery-runtime.test.mjs', 'paper-core/tests/legacy-salvage-boundary-hardening.test.mjs', 'paper-core/tests/legacy-provenance-delivery-hardening.test.mjs'] }],
  ['paperctl_modules/paper_production_executor_dispatch_cycle_audit.py', { disposition: 'partial_semantic_replacement', targets: ['paper-domain/submission/delivery-runtime.mjs', 'paper-adapters/submission/live-authorization.mjs', 'paper-adapters/submission/sqlite-delivery-store.mjs', 'store/migrations/016_submission_delivery_leases.sql'], evidence: ['paper-core/tests/submission-live-delivery.test.mjs', 'paper-core/tests/legacy-provenance-delivery-hardening.test.mjs'] }],
  ['paperctl_modules/paper_production_submission_evidence_real_intake_acceptance_gate.py', { disposition: 'partial_semantic_replacement', targets: ['paper-adapters/submission/venue-observation-verification.mjs', 'paper-domain/submission/reviewed-venue-evidence.mjs', 'paper-domain/evidence/trusted-ledger-receipt.mjs'], evidence: ['paper-core/tests/legacy-provenance-delivery-hardening.test.mjs'] }],
  ['paperctl_modules/external_submission_handoff_bundle.py', { disposition: 'partial_semantic_replacement', targets: ['paper-adapters/submission/handoff-bundle-exporter.mjs', 'paper-ports/artifact-repository-port.mjs', 'paper-domain/submission/reviewed-submission-decision.mjs'], evidence: ['paper-core/tests/submission-handoff-bundle.test.mjs', 'paper-core/tests/legacy-salvage-boundary-hardening.test.mjs'] }],
  ['paperctl_modules/paper_production_reviewed_target_evidence_autofill.py', { disposition: 'partial_semantic_replacement', targets: ['paper-domain/submission/reviewed-venue-evidence.mjs'], evidence: ['paper-core/tests/legacy-salvage-boundary-hardening.test.mjs'] }],
  ['paperctl_modules/paper_production_submission_decision_template.py', { disposition: 'partial_semantic_replacement', targets: ['paper-domain/submission/reviewed-submission-decision.mjs', 'paper-adapters/submission/handoff-bundle-exporter.mjs'], evidence: ['paper-core/tests/legacy-salvage-boundary-hardening.test.mjs', 'paper-core/tests/submission-handoff-bundle.test.mjs'] }],
  ['paperctl_modules/paper_production_submission_evidence_intake_quarantine_workflow_matrix.py', { disposition: 'partial_semantic_replacement', targets: ['paper-adapters/submission/sqlite-delivery-store.mjs', 'store/migrations/015_submission_boundary_hardening.sql'], evidence: ['paper-core/tests/legacy-salvage-boundary-hardening.test.mjs', 'paper-core/tests/legacy-provenance-delivery-hardening.test.mjs'] }],
  ['paperctl_modules/report_schema.py', { disposition: 'partial_semantic_replacement', targets: ['paper-ports/boundary-schema-catalog.mjs'], evidence: ['paper-core/tests/legacy-salvage-boundary-hardening.test.mjs'] }],
  ['paperctl_modules/paper_production_runner_execution_contract_matrix.py', { disposition: 'partial_semantic_replacement', targets: ['paper-ports/executor-capabilities.mjs', 'paper-ports/agent-executor-port.mjs', 'paper-ports/worker-runner-port.mjs', 'paper-ports/submission-executor-port.mjs'], evidence: ['paper-core/tests/executor-capabilities.test.mjs', 'paper-core/tests/automation-executors.test.mjs', 'migration/tests/capabilities/submission.executor-port.test.mjs'] }],
  ['paperctl_modules/paper_production_operator_drop_intake_preflight.py', { disposition: 'verified_behavioral_replacement', targets: ['workflow-kernel/runtime/scoped-file-identity.mjs', 'paper-adapters/build-package/package-verifier.mjs', 'paper-adapters/research-verify/evidence-verifier.mjs'], evidence: ['paper-core/tests/package-verifier.test.mjs', 'migration/tests/capabilities/research.evidence-ingestor.test.mjs'] }],
  ['paperctl_modules/paper_production_referee_repair_typed_evidence_contract_matrix.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-domain/quality/promotion-dependency-closure.mjs', 'paper-domain/research/gap-planner.mjs'], evidence: ['paper-core/tests/manuscript-promotion-boundaries.test.mjs', 'paper-core/tests/typed-research-gap-plan.test.mjs'] }],
  ['paperctl_modules/paper_production_stale_pass_invalidation_audit.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-core/bin/release-evidence-lib.mjs'], evidence: ['paper-core/tests/release-evidence-selection.test.mjs'] }],
  ['paperctl_modules/paper_production_strict_ordered_refresh_gate.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-domain/evidence/dependency-freshness-policy.mjs', 'paper-domain/quality/promotion-dependency-closure.mjs'], evidence: ['paper-core/tests/dependency-freshness-policy.test.mjs', 'paper-core/tests/manuscript-promotion-boundaries.test.mjs'] }],
  ['paperctl_modules/paper_production_theorem_proof_appendix_gate.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-domain/quality/theorem-manuscript-readiness-policy.mjs'], evidence: ['paper-core/tests/theorem-manuscript-readiness-policy.test.mjs'] }],
  ['paperctl_modules/research_compute_bridge.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-domain/research/gap-planner.mjs'], evidence: ['paper-core/tests/typed-research-gap-plan.test.mjs'] }],
  ['paperctl_modules/research_compute_gap_mapper.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-domain/research/gap-planner.mjs'], evidence: ['paper-core/tests/typed-research-gap-plan.test.mjs'] }],
  ['paperctl_modules/research_compute_claim_draft.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-domain/research/claim-registry.mjs', 'paper-domain/research/claim-contract-readiness-policy.mjs'], evidence: ['paper-core/tests/research-vacuity-boundaries.test.mjs'] }],
  ['paperctl_modules/research_compute_claim_evidence_quality_gate.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-domain/research/evidence-quality-gate.mjs', 'paper-domain/evidence/evidence-consumption-policy.mjs'], evidence: ['migration/tests/capabilities/research.evidence-quality-gate.test.mjs', 'paper-core/tests/evidence-consumption-policy.test.mjs'] }],
  ['paperctl_modules/research_compute_claim_quality_gate.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-domain/research/claim-contract-readiness-policy.mjs', 'paper-domain/quality/manuscript-promotion-gate.mjs'], evidence: ['paper-core/tests/research-vacuity-boundaries.test.mjs', 'paper-core/tests/manuscript-promotion-boundaries.test.mjs'] }],
  ['paperctl_modules/research_compute_evidence_gate.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-domain/research/evidence-quality-gate.mjs', 'paper-domain/evidence/evidence-consumption-policy.mjs'], evidence: ['migration/tests/capabilities/research.evidence-quality-gate.test.mjs', 'paper-core/tests/evidence-consumption-policy.test.mjs'] }],
  ['paperctl_modules/research_compute_evidence_ingestor.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-domain/research/evidence-ingestor.mjs', 'paper-adapters/research-verify/evidence-verifier.mjs'], evidence: ['migration/tests/capabilities/research.evidence-ingestor.test.mjs'] }],
  ['rust/paperctl-rs/src/telemetry.rs', { disposition: 'verified_behavioral_replacement', targets: ['paper-domain/automation/campaign-slo.mjs', 'store/migrations/013_campaign_telemetry.sql'], evidence: ['paper-core/tests/campaign-telemetry-persistence.test.mjs', 'paper-core/tests/campaign-slo.test.mjs'] }],
  ['paperctl_modules/paper_production_core.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-core/src/contracts/workflow-contracts.mjs'], evidence: ['paper-core/tests/architecture-conformance.test.mjs'] }],
  ['paperctl_modules/referee_revision.py', { disposition: 'verified_behavioral_replacement', targets: ['paper-adapters/referee-revise/index.mjs'], evidence: ['migration/tests/p1-referee-revision-differential.mjs'] }],
  ['rust/paperctl-rs/src/main.rs', { disposition: 'fixture_only', targets: ['paper-adapters/build-package/package-verifier.mjs'] }],
  ['PaperFactoryFormalVerifier/SourceBacked/PremiseProofBodies.lean', { disposition: 'fixture_only', targets: ['migration/fixtures/legacy-lean-adversarial-v1.json'] }],
  ['PaperFactoryFormalVerifier/SourceBacked/TransferComposition.lean', { disposition: 'fixture_only', targets: ['migration/fixtures/legacy-lean-adversarial-v1.json'] }],
  ['PaperFactoryFormalVerifier/SourceBacked/TargetTheoremIntegration.lean', { disposition: 'fixture_only', targets: ['migration/fixtures/legacy-lean-adversarial-v1.json'] }],
]);

function disposition(relative) {
  if (overrides.has(relative)) return overrides.get(relative);
  if (relative.startsWith('tests/')) return { disposition: 'fixture_only', targets: [] };
  const semanticEntry = semanticByPath.get(relative);
  if (semanticEntry?.verificationClass === 'behavioral_replacement') return { disposition: 'verified_behavioral_replacement', targets: [semanticEntry.target.path.replace(/^hepta-paper-workspace\//, '')] };
  const capability = semanticEntry ? capabilityByLegacyId.get(semanticEntry.id) : null;
  if (capability?.businessDecision === 'capability_reimplementation') return { disposition: 'capability_mapped_semantics_open', targets: capability.capabilityTargets.map((target) => target.target) };
  if (capability?.businessDecision === 'superseded_with_coverage') return { disposition: 'fixture_only', targets: capability.capabilityTargets.map((target) => target.target) };
  if (capability?.businessDecision === 'permanent_retirement') return { disposition: 'retired', targets: [] };
  const classified = classifyLegacyFile(relative);
  if (classified === 'quarantine_control_plane_report' || /(?:capstone|terminal_chain|refusal_matrix|status_guard)/.test(relative)) return { disposition: 'archive_only', targets: [] };
  if (classified.startsWith('retire_')) return { disposition: 'retired', targets: [] };
  if (classified === 'domain_asset_or_documentation') return { disposition: 'archive_only', targets: [] };
  if (classified.startsWith('adapter_candidate_')) return { disposition: 'capability_mapped_semantics_open', targets: [] };
  return { disposition: 'archive_only', targets: [] };
}

const files = roots.flatMap((relativeRoot) => walk(path.join(legacyRoot, relativeRoot))).map((candidate) => {
  const relative = path.relative(legacyRoot, candidate).replace(/\\/g, '/');
  const bytes = fs.readFileSync(candidate);
  const decision = disposition(relative);
  const targets = (decision.targets || []).map(targetRecord);
  const evidence = (decision.evidence || []).map(targetRecord);
  const evidenceComplete = evidence.length > 0 && evidence.every((item) => item.hash);
  const targetComplete = targets.length > 0 && targets.every((item) => item.hash);
  const effectiveDisposition = decision.disposition === 'verified_behavioral_replacement' && (!evidenceComplete || !targetComplete)
    ? 'capability_mapped_semantics_open'
    : decision.disposition;
  const verificationSubject = effectiveDisposition === 'verified_behavioral_replacement' ? {
    legacySourceHash: digest(bytes),
    targets,
    evidence,
  } : null;
  return {
    path: relative,
    language: path.extname(relative).slice(1).toLowerCase(),
    bytes: bytes.length,
    sourceHash: digest(bytes),
    disposition: effectiveDisposition,
    targets,
    evidence,
    replacementVerification: verificationSubject ? {
      status: 'salvage_replacement_verification_bound',
      verificationReceiptHash: digest(Buffer.from(JSON.stringify(verificationSubject))),
      ...verificationSubject,
    } : null,
    legacyMatrixEntryId: semanticByPath.get(relative)?.id || null,
  };
}).sort((left, right) => left.path.localeCompare(right.path));
if (!files.length) throw new Error('historical_salvage_source_is_empty');

const payload = {
  version: 1,
  kind: 'LegacySalvageManifest',
  sourceIdentity: 'paper_factory_immutable_reference',
  runtimeDependencyAllowed: false,
  generatedFromLiveLegacy: false,
  generatedFromExplicitHistoricalSource: true,
  summary: {
    fileCount: files.length,
    pythonModuleCount: files.filter((item) => item.path.startsWith('paperctl_modules/') && item.language === 'py').length,
    pythonTestCount: files.filter((item) => item.path.startsWith('tests/') && item.language === 'py').length,
    excludedBuildTrees: ['rust/paperctl-rs/target'],
    byDisposition: Object.fromEntries([...files.reduce((counts, item) => counts.set(item.disposition, (counts.get(item.disposition) || 0) + 1), new Map())].sort()),
  },
  files,
};
const manifest = { ...payload, manifestHash: digest(Buffer.from(JSON.stringify(payload))) };
if (process.argv.includes('--write')) {
  throw new Error('frozen_salvage_manifest_write_forbidden');
}
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
