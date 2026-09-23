#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copySqliteDatabase } from '../../paper-composition/bootstrap/operator-persistence-composition.mjs';
import { prepareImmutableLegacyMatrixReference } from '../../migration/legacy-matrix-reference.mjs';
import {
  declaredTestSuite,
} from '../src/test-suite-manifest.mjs';
import {
  defaultPaperAssetRoot,
  defaultPaperRuntimeRoot,
} from '../src/workspace-layout.mjs';
import { inspectTrackedProductionGraph } from '../verification/tracked-production-graph.mjs';
import {
  createBoundedVerificationCommandExecutor,
  runVerificationCommandsUntilFailure,
} from '../src/verification-command-batch.mjs';
import {
  buildCriticalCoveragePolicy,
  CRITICAL_COVERAGE_DEFAULT_THRESHOLD,
  CRITICAL_COVERAGE_TARGET_OVERRIDES,
  CRITICAL_COVERAGE_TRUST_BOUNDARY_THRESHOLD,
} from '../verification/critical-module-coverage-policy.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const coverageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-critical-coverage-'));
const isolatedRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-critical-runtime-'));
const productionRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-critical-production-'));
const criticalCoverageChildTimeoutMs = 30 * 60 * 1_000;
const copiedRuntimePaths = Object.freeze([
  'owner-acceptance',
  'operational-proof',
  'trust',
  'authority-inbox',
  'legacy-retirement',
  path.join('release-evidence', 'current'),
  path.join('audits', 'capability-verification'),
]);
let legacyReference = null;
const explicitlyTargetedTests = [
  'paper-core/tests/paper-contracts-facade.test.mjs',
  'paper-core/tests/domain-purity-identity.test.mjs',
  'paper-core/tests/empirical-contract.test.mjs',
  'paper-core/tests/empirical-p1-authority.test.mjs',
  'paper-core/tests/architecture-conformance.test.mjs',
  'paper-core/tests/composition-context-profiles.test.mjs',
  'paper-core/tests/typed-persistence-ports.test.mjs',
  'paper-core/tests/workflow-operational-authority.test.mjs',
  'paper-core/tests/campaign-state-policy.test.mjs',
  'paper-core/tests/automation-executors.test.mjs',
  'paper-core/tests/os-sandboxed-worker-dataset-exclusion.test.mjs',
  'paper-core/tests/campaign-empirical-repair-semantics.test.mjs',
  'paper-core/tests/analysis-statistics.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-full-mode-recovery.test.mjs',
  'paper-core/tests/autonomous-research-supervisor.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-composition.test.mjs',
  'paper-core/tests/autonomous-research-cold-start-e2e.test.mjs',
  'paper-core/tests/autonomous-research-state-backup.test.mjs',
  'paper-core/tests/autonomous-research-state-safety-readiness.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-closure.test.mjs',
  'paper-core/tests/nested-runtime-platform-qualification.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-pause-recovery.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-resident.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-progress.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-external-action-journal.test.mjs',
  'paper-core/tests/autonomous-research-campaign.test.mjs',
  'paper-core/tests/autonomous-launch-mode-golden-controller.test.mjs',
  'paper-core/tests/autonomous-research-qualification-progress.test.mjs',
  'paper-core/tests/autonomous-research-generalization-agenda-formal.test.mjs',
  'paper-core/tests/dynamic-formal-claim-kernel-e2e.test.mjs',
  'paper-core/tests/autonomous-research-generalization-contracts.test.mjs',
  'paper-core/tests/autonomous-research-generalization-plugin-capability.test.mjs',
  'paper-core/tests/autonomous-research-generalization-review-replay.test.mjs',
  'paper-core/tests/external-research-replay-strong-v3.test.mjs',
  'paper-core/tests/recoverable-reviewer-executor.test.mjs',
  'paper-core/tests/reviewer-principal-recovery-ports.test.mjs',
  'paper-core/tests/reviewer-cryptographic-trust-v2.test.mjs',
  'paper-core/tests/autonomous-research-author-identity-configuration.test.mjs',
  'paper-core/tests/autonomous-venue-signed-ranking-v2.test.mjs',
  'paper-core/tests/prior-art-evidence-v2-contract.test.mjs',
  'paper-core/tests/autonomous-research-generalization-venue-submission.test.mjs',
  'paper-core/tests/autonomous-research-external-capability-trust-wiring.test.mjs',
  'paper-core/tests/autonomous-research-production-configuration-readers.test.mjs',
  'paper-core/tests/campaign-mode-execution-semantics.test.mjs',
  'paper-core/tests/lean-source-formal-verifier.test.mjs',
  'paper-core/tests/formal-campaign-release.test.mjs',
  'paper-core/tests/proposal-scientific-claim-e2e.test.mjs',
  'paper-core/tests/autonomous-manuscript-release-proof.test.mjs',
  'paper-core/tests/full-research-qualification.test.mjs',
  'paper-core/tests/autonomous-external-qualification-process.test.mjs',
  'paper-core/tests/autonomous-submission-durable-outbox.test.mjs',
  'paper-core/tests/autonomous-submission-request-verifier-composition.test.mjs',
  'paper-core/tests/hotcrp-api-connector.test.mjs',
  'paper-core/tests/journal-connector-coverage.test.mjs',
  'paper-core/tests/portal-target-qualification.test.mjs',
  'paper-core/tests/ojs-api-connector.test.mjs',
  'paper-core/tests/openreview-api-connector.test.mjs',
  'paper-core/tests/openreview-submission-connector.test.mjs',
  'paper-core/tests/playwright-assisted-submission-connector.test.mjs',
  'paper-core/tests/universal-submission-contract.test.mjs',
  'paper-core/tests/pinned-external-evidence-verifier.test.mjs',
  'paper-core/tests/autonomous-research-execution-authorization.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-dispatch-authorization.test.mjs',
  'paper-core/tests/automation-readiness-policy.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-machine-intake.test.mjs',
  'paper-core/tests/autonomous-research-machine-intake-authority-rotation.test.mjs',
  'paper-core/tests/autonomous-research-topic-producer.test.mjs',
  'paper-core/tests/autonomous-research-topic-producer-recovery.test.mjs',
  'paper-core/tests/autonomous-research-topic-producer-schema.test.mjs',
  'paper-core/tests/autonomous-empirical-execution-profile.test.mjs',
  'paper-core/tests/autonomous-language-runtime-kernel-registry.test.mjs',
  'paper-core/tests/autonomous-empirical-plugin-package-loader.test.mjs',
  'paper-core/tests/autonomous-empirical-plugin-release.test.mjs',
  'paper-core/tests/autonomous-formal-lineage.test.mjs',
  'paper-core/tests/autonomous-formal-support-registry.test.mjs',
  'paper-core/tests/dataset-evaluation-dependency-contract.test.mjs',
  'paper-core/tests/process-isolated-system-benchmark-recomputation.test.mjs',
  'paper-core/tests/system-benchmark-harness-integrity.test.mjs',
  'paper-core/tests/analysis-protocol.test.mjs',
  'paper-core/tests/typed-numeric-oracle-production.test.mjs',
  'paper-core/tests/versioned-experiment-ir.test.mjs',
  'paper-core/tests/autonomous-readiness-topology.test.mjs',
  'paper-core/tests/fully-autonomous-research-system-status.test.mjs',
  'paper-core/tests/autonomous-runtime-reproducibility-refresh.test.mjs',
  'paper-core/tests/runtime-image-reproducibility.test.mjs',
  'paper-core/tests/runtime-image-reproducibility-trust.test.mjs',
  'paper-core/tests/automation-r-runtime-bootstrap.test.mjs',
  'paper-core/tests/agent-executor-template.test.mjs',
  'paper-core/tests/agent-executor-managed-codex.test.mjs',
  'paper-core/tests/campaign-node-workspace-support.test.mjs',
  'paper-core/tests/scoped-file-materialization-repository.test.mjs',
  'paper-core/tests/orchestrator-facade-compatibility.test.mjs',
  'paper-core/tests/research-verify-orchestrator.test.mjs',
  'paper-core/tests/repair-orchestrator-split.test.mjs',
  'paper-core/tests/runtime-retention.test.mjs',
  'paper-core/tests/workspace-registry.test.mjs',
  'paper-core/tests/workspace-snapshot-exporter.test.mjs',
  'paper-core/tests/workflow-state-store.test.mjs',
  'paper-core/tests/sqlite-store-failure-contract.test.mjs',
  'paper-core/tests/autonomous-research-online-writer-static-inspection.test.mjs',
  'paper-core/tests/externally-fenced-sqlite-mutation-coordinator-configuration.test.mjs',
  'paper-core/tests/paper-batch-dry-run.test.mjs',
  'paper-core/tests/automation-campaign.test.mjs',
  'paper-core/tests/campaign-attempt-fencing.test.mjs',
  'paper-core/tests/workspace-attempt-integration.test.mjs',
  'paper-core/tests/campaign-release-handoff.test.mjs',
  'paper-core/tests/campaign-release-evidence-capsule.test.mjs',
  'paper-core/tests/research-execution-release-attestor-rotation.test.mjs',
  'paper-core/tests/research-execution-release-attestor-fail-closed.test.mjs',
  'paper-core/tests/automation-runtime-reconciler.test.mjs',
  'paper-core/tests/receipt-issuer-policy.test.mjs',
  'paper-core/tests/native-receipt-hash-policy.test.mjs',
  'paper-core/tests/receipt-hash-selector.test.mjs',
  'paper-core/tests/batch-summary-golden.test.mjs',
  'paper-core/tests/trusted-research-producers.test.mjs',
  'paper-core/tests/release-trust-layer-gate.test.mjs',
  'paper-core/tests/external-intake-verifier.test.mjs',
  'paper-core/tests/release-evidence-selection.test.mjs',
  'paper-core/tests/release-integrity-evidence-mutation.test.mjs',
  'paper-core/tests/release-verification-receipt-selection.test.mjs',
  'paper-core/tests/formal-claim-binding-policy.test.mjs',
  'paper-core/tests/campaign-independent-referee.test.mjs',
  'paper-core/tests/campaign-source-closure.test.mjs',
  'paper-core/tests/formal-candidate-transaction.test.mjs',
  'paper-core/tests/formal-claim-universe-reader.test.mjs',
  'paper-core/tests/formal-project-closure.test.mjs',
  'paper-core/tests/dynamic-formal-project-closure-readiness.test.mjs',
  'paper-core/tests/formal-review-agent-bootstrap.test.mjs',
  'paper-core/tests/manuscript-promotion-boundaries.test.mjs',
  'paper-core/tests/theorem-manuscript-readiness-policy.test.mjs',
  'paper-core/tests/empirical-cache-policy.test.mjs',
  'paper-core/tests/empirical-assertion-contract.test.mjs',
  'paper-core/tests/independent-raw-event-recomputation.test.mjs',
  'paper-core/tests/legacy-provenance-delivery-hardening.test.mjs',
  'paper-core/tests/submission-live-delivery.test.mjs',
  'paper-core/tests/typed-research-gap-plan.test.mjs',
  'paper-core/tests/research-vacuity-boundaries.test.mjs',
  'paper-core/tests/critical-module-coverage-policy.test.mjs',
  'paper-core/tests/autonomous-research-online-runtime-adoption-v2.test.mjs',
  'paper-core/tests/autonomous-research-online-schema-transition-state-repository.test.mjs',
  'paper-core/tests/autonomous-research-online-schema-transition.test.mjs',
  'paper-core/tests/immutable-release-candidate-repository.test.mjs',
  'paper-core/tests/immutable-release-deployment-cli.test.mjs',
  'paper-core/tests/immutable-release-deployment-closure-builder.test.mjs',
  'paper-core/tests/immutable-release-deployment-intent-repository.test.mjs',
  'paper-core/tests/immutable-release-deployment-lock.test.mjs',
  'paper-core/tests/immutable-release-deployment-recovery.test.mjs',
  'paper-core/tests/immutable-release-deployment-transaction.test.mjs',
  'paper-core/tests/immutable-release-linux-host-adapter.test.mjs',
  'paper-core/tests/immutable-release-workspace.test.mjs',
  'paper-core/tests/release-state-consistency.test.mjs',
  'paper-core/tests/strict-full-auto-online-runtime-adoption.test.mjs',
  'paper-core/tests/strict-npm-audit-launcher.test.mjs',
  'migration/tests/operational-proof-intake.test.mjs',
  'migration/tests/capabilities/research.claim-registry.test.mjs',
  'migration/tests/capabilities/research.evidence-quality-gate.test.mjs',
  'migration/tests/capabilities/research.formal-verifier.test.mjs',
  'migration/tests/capabilities/research.gap-planner.test.mjs',
  'migration/tests/capabilities/runtime.job-receipt-store.test.mjs',
  'migration/tests/capabilities/submission.delivery-runtime.test.mjs',
];
const tests = Object.freeze([...new Set([
  ...explicitlyTargetedTests,
  ...declaredTestSuite('automation', 'critical-coverage').tests,
  ...declaredTestSuite('salvage-hardening', 'critical-coverage').tests,
])]);
const isolatedCoverageTests = Object.freeze([
  'paper-core/tests/production-research-closure-fixture.test.mjs',
]);

const discoveredContractTargets = Object.freeze(
  fs.readdirSync(path.join(workspaceRoot, 'paper-domain', 'contracts'))
    .filter((name) => name.endsWith('.mjs') && name !== 'index.mjs')
    .map((name) => Object.freeze({
      path: `paper-domain/contracts/${name}`,
      trustBoundary: false,
    })),
);

function isOnlineStateMutationProductionTarget(relative) {
  return relative.endsWith('.mjs')
    && /(?:online|mutation|state-(?:backup|database|restore|safety))/.test(relative);
}

const productionGraph = inspectTrackedProductionGraph();
const discoveredOnlineStateMutationTargets = Object.freeze(
  productionGraph.manifest.modules
    .map((entry) => entry.path)
    .filter(isOnlineStateMutationProductionTarget)
    .sort(),
);
const coveragePolicy = buildCriticalCoveragePolicy({
  leadingTargets: discoveredContractTargets,
  trailingTargets: discoveredOnlineStateMutationTargets.map((relative) =>
    Object.freeze({ path: relative, trustBoundary: true })),
});
const {
  targets,
  trustTargets: TRUST_TARGETS,
  targetThresholds: TARGET_THRESHOLDS,
} = coveragePolicy;

function coverageChildEnvironment() {
  const environment = {
    ...process.env,
    NODE_V8_COVERAGE: coverageRoot,
    HEPTA_PAPER_ASSET_ROOT: process.env.HEPTA_PAPER_ASSET_ROOT || defaultPaperAssetRoot(),
    HEPTA_PAPER_RUNTIME_ROOT: isolatedRuntimeRoot,
    HEPTA_PAPER_RUNTIME_ISOLATED: '1',
    HEPTA_PRODUCTION_RUNTIME_ROOT: productionRuntimeRoot,
    HEPTA_EVIDENCE_ENVIRONMENT: 'verification',
    HEPTA_EVIDENCE_CLASS: 'technical_conformance',
    HEPTA_LEGACY_REFERENCE_PREPARED: '1',
    HEPTA_LEGACY_REFERENCE_ARCHIVE: legacyReference?.archivePath || '',
    PAPER_FACTORY_LEGACY_ROOT: legacyReference?.root || '',
  };
  delete environment.GIT_INDEX_FILE;
  return environment;
}

async function prepareCoverageRuntime() {
  const productionSourceRoot = defaultPaperRuntimeRoot();
  const productionDb = path.join(productionSourceRoot, 'hepta-paper.sqlite');
  if (!fs.existsSync(productionDb)) {
    throw new Error(`critical_coverage_production_store_required:${productionDb}`);
  }
  const isolatedDb = path.join(isolatedRuntimeRoot, 'hepta-paper.sqlite');
  await copySqliteDatabase({
    sourcePath: productionDb,
    destinationPath: isolatedDb,
    sourceImmutable: true,
  });
  for (const relative of copiedRuntimePaths) {
    const source = path.join(productionSourceRoot, relative);
    const target = path.join(isolatedRuntimeRoot, relative);
    if (fs.existsSync(source)) fs.cpSync(source, target, { recursive: true, dereference: false });
  }
  legacyReference = prepareImmutableLegacyMatrixReference();
}

function coverageEntries() {
  return fs.readdirSync(coverageRoot)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => JSON.parse(fs.readFileSync(path.join(coverageRoot, name), 'utf8')).result || []);
}

function countAt(functions, offset) {
  let bestLength = Infinity;
  let count = 0;
  for (const fn of functions) {
    for (const range of fn.ranges || []) {
      if (range.startOffset <= offset && offset < range.endOffset) {
        const length = range.endOffset - range.startOffset;
        if (length < bestLength) {
          bestLength = length;
          count = range.count;
        } else if (length === bestLength) count = Math.max(count, range.count);
      }
    }
  }
  return count;
}

function moduleCoverage(relative, entries) {
  const absolute = path.join(workspaceRoot, relative);
  const url = pathToFileURL(absolute).href;
  const matching = entries.filter((entry) => {
    try {
      const instrumentedUrl = new URL(entry.url);
      instrumentedUrl.search = '';
      instrumentedUrl.hash = '';
      return instrumentedUrl.href === url;
    } catch {
      return entry.url === url;
    }
  });
  if (!matching.length) return { relative, lines: 0, functions: 0, uncoveredBranchBlocks: Number.POSITIVE_INFINITY, missing: true };
  const source = fs.readFileSync(absolute, 'utf8');
  let offset = 0;
  let executable = 0;
  let covered = 0;
  for (const line of source.split(/\n/)) {
    const first = line.search(/\S/);
    if (first >= 0 && !/^\s*(?:\/\/|\*|\/\*)/.test(line)) {
      executable += 1;
      if (matching.some((entry) => countAt(entry.functions || [], offset + first) > 0)) covered += 1;
    }
    offset += line.length + 1;
  }
  const functions = new Map();
  const branchBlocks = new Map();
  for (const entry of matching) {
    for (const fn of entry.functions || []) {
      const first = fn.ranges?.[0];
      if (!first || (!fn.functionName && first.startOffset === 0 && first.endOffset >= source.length)) continue;
      const key = `${fn.functionName}:${first.startOffset}:${first.endOffset}`;
      functions.set(key, Math.max(functions.get(key) || 0, first.count || 0));
      for (const range of (fn.ranges || []).slice(1)) {
        const blockKey = `${range.startOffset}:${range.endOffset}`;
        branchBlocks.set(blockKey, Math.max(branchBlocks.get(blockKey) || 0, range.count || 0));
      }
    }
  }
  const functionTotal = functions.size;
  const functionCovered = [...functions.values()].filter((count) => count > 0).length;
  const uncoveredBranchBlocks = [...branchBlocks.values()].filter((count) => count === 0).length;
  return {
    relative,
    lines: executable ? Number((covered * 100 / executable).toFixed(2)) : 100,
    functions: functionTotal ? Number((functionCovered * 100 / functionTotal).toFixed(2)) : 100,
    uncoveredBranchBlocks,
    coveredLines: covered,
    executableLines: executable,
    coveredFunctions: functionCovered,
    functionTotal,
    missing: false,
  };
}

async function runCriticalCoverage() {
try {
  await prepareCoverageRuntime();
  const testBatchSize = 24;
  const testBatches = Array.from(
    { length: Math.ceil(tests.length / testBatchSize) },
    (_, index) => tests.slice(index * testBatchSize, (index + 1) * testBatchSize),
  );
  const commands = [
    ...testBatches.map((batch) => ['--test', '--test-concurrency=1', ...batch]),
    ...isolatedCoverageTests.map(
      (candidate) => ['--test', '--test-concurrency=1', candidate],
    ),
    ['paper-core/verification/selftest.mjs'],
    ['paper-core/verification/authority-pipeline-selftest.mjs'],
    ['paper-core/verification/remediation-selftest.mjs'],
    ['migration/tests/p1-referee-revise-retirements.mjs'],
  ];
  const failed = runVerificationCommandsUntilFailure(
    commands,
    createBoundedVerificationCommandExecutor({
      spawnSyncImpl: spawnSync,
      executable: process.execPath,
      cwd: workspaceRoot,
      env: coverageChildEnvironment(),
      maxBuffer: 32 * 1024 * 1024,
      timeoutMs: criticalCoverageChildTimeoutMs,
    }),
  );
  if (failed) {
    process.stdout.write(failed.stdout || '');
    process.stderr.write(failed.stderr || '');
    process.exitCode = failed.status || 1;
  } else {
    const entries = coverageEntries();
    const report = targets.map((target) => moduleCoverage(target, entries));
    const failures = report.filter((row) => {
      const threshold = TARGET_THRESHOLDS.get(row.relative)
        || (TRUST_TARGETS.has(row.relative)
          ? CRITICAL_COVERAGE_TRUST_BOUNDARY_THRESHOLD
          : CRITICAL_COVERAGE_DEFAULT_THRESHOLD);
      return row.missing || row.lines < threshold.lines || row.functions < threshold.functions || row.uncoveredBranchBlocks > threshold.maxUncoveredBranchBlocks;
    });
    process.stdout.write(`${JSON.stringify({
      ok: failures.length === 0,
      kind: 'CriticalModuleCoverageReport',
      thresholds: {
        default: CRITICAL_COVERAGE_DEFAULT_THRESHOLD,
        trustBoundary: CRITICAL_COVERAGE_TRUST_BOUNDARY_THRESHOLD,
        targetOverrides: Object.fromEntries(TARGET_THRESHOLDS),
        auditedTargetExceptions: CRITICAL_COVERAGE_TARGET_OVERRIDES,
      },
      modules: report,
      failures: failures.map((row) => row.relative),
      failureDetails: failures,
    }, null, 2)}\n`);
    if (failures.length) process.exitCode = 1;
  }
} finally {
  legacyReference?.cleanup();
  fs.rmSync(coverageRoot, { recursive: true, force: true });
  fs.rmSync(isolatedRuntimeRoot, { recursive: true, force: true });
  fs.rmSync(productionRuntimeRoot, { recursive: true, force: true });
}
}

await runCriticalCoverage();
