#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const coverageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-critical-coverage-'));
const tests = [
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
  'paper-core/tests/campaign-empirical-repair-semantics.test.mjs',
  'paper-core/tests/autonomous-research-supervisor.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-closure.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-pause-recovery.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-resident.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-progress.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-external-action-journal.test.mjs',
  'paper-core/tests/autonomous-research-campaign.test.mjs',
  'paper-core/tests/autonomous-research-execution-authorization.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-dispatch-authorization.test.mjs',
  'paper-core/tests/automation-readiness-policy.test.mjs',
  'paper-core/tests/autonomous-research-supervisor-machine-intake.test.mjs',
  'paper-core/tests/autonomous-research-machine-intake-authority-rotation.test.mjs',
  'paper-core/tests/autonomous-research-topic-producer.test.mjs',
  'paper-core/tests/autonomous-empirical-execution-profile.test.mjs',
  'paper-core/tests/autonomous-readiness-topology.test.mjs',
  'paper-core/tests/fully-autonomous-research-system-status.test.mjs',
  'paper-core/tests/autonomous-runtime-reproducibility-refresh.test.mjs',
  'paper-core/tests/runtime-image-reproducibility.test.mjs',
  'paper-core/tests/runtime-image-reproducibility-trust.test.mjs',
  'paper-core/tests/agent-executor-template.test.mjs',
  'paper-core/tests/campaign-node-workspace-support.test.mjs',
  'paper-core/tests/scoped-file-materialization-repository.test.mjs',
  'paper-core/tests/orchestrator-facade-compatibility.test.mjs',
  'paper-core/tests/research-verify-orchestrator.test.mjs',
  'paper-core/tests/repair-orchestrator-split.test.mjs',
  'paper-core/tests/runtime-retention.test.mjs',
  'paper-core/tests/workspace-registry.test.mjs',
  'paper-core/tests/workspace-snapshot-exporter.test.mjs',
  'paper-core/tests/workflow-state-store.test.mjs',
  'paper-core/tests/paper-batch-dry-run.test.mjs',
  'paper-core/tests/automation-campaign.test.mjs',
  'paper-core/tests/campaign-attempt-fencing.test.mjs',
  'paper-core/tests/workspace-attempt-integration.test.mjs',
  'paper-core/tests/campaign-release-handoff.test.mjs',
  'paper-core/tests/campaign-release-evidence-capsule.test.mjs',
  'paper-core/tests/research-execution-release-attestor-rotation.test.mjs',
  'paper-core/tests/automation-runtime-reconciler.test.mjs',
  'paper-core/tests/receipt-issuer-policy.test.mjs',
  'paper-core/tests/native-receipt-hash-policy.test.mjs',
  'paper-core/tests/receipt-hash-selector.test.mjs',
  'paper-core/tests/batch-summary-golden.test.mjs',
  'paper-core/tests/trusted-research-producers.test.mjs',
  'paper-core/tests/release-trust-layer-gate.test.mjs',
  'paper-core/tests/external-intake-verifier.test.mjs',
  'paper-core/tests/release-evidence-selection.test.mjs',
  'paper-core/tests/formal-claim-binding-policy.test.mjs',
  'paper-core/tests/manuscript-promotion-boundaries.test.mjs',
  'paper-core/tests/legacy-provenance-delivery-hardening.test.mjs',
  'paper-core/tests/submission-live-delivery.test.mjs',
  'paper-core/tests/typed-research-gap-plan.test.mjs',
  'migration/tests/operational-proof-intake.test.mjs',
  'migration/tests/capabilities/research.evidence-quality-gate.test.mjs',
  'migration/tests/capabilities/runtime.job-receipt-store.test.mjs',
];
const targets = [
  ...fs.readdirSync(path.join(workspaceRoot, 'paper-domain', 'contracts'))
    .filter((name) => name.endsWith('.mjs') && name !== 'index.mjs')
    .map((name) => `paper-domain/contracts/${name}`),
  'paper-adapters/automation/automation-runtime-reconciler.mjs',
  'paper-adapters/automation/agent-executor-template.mjs',
  'paper-adapters/automation/ollama-structured-agent-executor.mjs',
  'paper-adapters/automation/empirical-contract-reader.mjs',
  'paper-adapters/build-package/source-package-contract-reader.mjs',
  'paper-domain/automation/empirical-contract.mjs',
  'paper-domain/quality/source-package-contract.mjs',
  'paper-adapters/automation/bounded-child-process.mjs',
  'paper-adapters/automation/workspace-change-tracker.mjs',
  'paper-adapters/automation/workspace-attempt-repository.mjs',
  'paper-adapters/automation/isolated-agent-executor.mjs',
  'paper-application/automation/campaign-node-executor.mjs',
  'paper-application/automation/campaign-execution-budget-policy.mjs',
  'paper-application/automation/campaign-empirical-node-orchestrator.mjs',
  'paper-application/automation/campaign-empirical-repair-policy.mjs',
  'paper-application/automation/campaign-confirmatory-lineage-policy.mjs',
  'paper-application/automation/autonomous-research-supervisor.mjs',
  'paper-application/automation/autonomous-research-supervisor-autonomy-fence.mjs',
  'paper-application/automation/autonomous-research-resident-lifecycle.mjs',
  'paper-application/automation/autonomous-research-supervisor-dispatch-authorization.mjs',
  'paper-application/automation/autonomous-research-supervisor-progress.mjs',
  'paper-application/automation/autonomous-research-campaign.mjs',
  'paper-application/automation/autonomous-research-supervisor-readiness-policy.mjs',
  'paper-application/automation/autonomous-research-supervisor-provider-canary-dispatch.mjs',
  'paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs',
  'paper-adapters/automation/autonomous-research-supervisor-state-repository.mjs',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs',
  'paper-adapters/automation/autonomous-research-supervisor-provider-canary-state-operations.mjs',
  'paper-adapters/automation/autonomous-research-machine-intake-authority.mjs',
  'paper-adapters/automation/autonomous-research-machine-intake-authority-rotation.mjs',
  'paper-adapters/automation/autonomous-research-machine-intake-authority-rotation-authorization.mjs',
  'paper-application/automation/autonomous-research-runtime-refresh.mjs',
  'paper-adapters/automation/autonomous-research-runtime-refresh-state-repository.mjs',
  'paper-adapters/automation/runtime-image-registry.mjs',
  'paper-adapters/automation/runtime-image-build-input-closure.mjs',
  'paper-domain/automation/runtime-reproducibility-refresh-policy.mjs',
  'paper-domain/automation/autonomous-research-campaign-execution-admission.mjs',
  'paper-domain/automation/autonomous-research-provider-canary-side-effect-inspection.mjs',
  'paper-domain/automation/automation-readiness-side-effect-inspection.mjs',
  'paper-domain/automation/autonomous-research-supervisor-external-action-journal.mjs',
  'paper-composition/automation/autonomous-research-provider-canary.mjs',
  'paper-application/automation/autonomous-research-topic-producer-live-authority.mjs',
  'paper-application/automation/autonomous-research-topic-producer.mjs',
  'paper-adapters/automation/autonomous-research-topic-producer-repository-support.mjs',
  'paper-adapters/automation/autonomous-research-topic-producer-canary-journal-operations.mjs',
  'paper-adapters/automation/autonomous-research-topic-producer-repository.mjs',
  'paper-adapters/automation/autonomous-research-topic-producer-status.mjs',
  'paper-composition/automation/automation-readiness-query.mjs',
  'paper-composition/automation/automation-readiness-runtime-probes.mjs',
  'paper-composition/automation/autonomous-research-readiness-composition.mjs',
  'paper-composition/automation/autonomous-research-campaign-composition.mjs',
  'paper-composition/automation/autonomous-research-machine-intake-composition.mjs',
  'paper-adapters/automation/docker-runtime-image-manifest-inspection.mjs',
  'paper-adapters/runtime/sandbox-backend-probe.mjs',
  'paper-composition/automation/autonomous-research-supervisor-composition.mjs',
  'paper-composition/automation/autonomous-research-supervisor-external-action-composition.mjs',
  'paper-composition/automation/autonomous-research-resident-prerequisite-inspection.mjs',
  'paper-composition/automation/autonomous-research-enqueue-admission.mjs',
  'paper-application/automation/campaign-quality-release-orchestrator.mjs',
  'paper-application/automation/campaign-agent-policy.mjs',
  'paper-adapters/automation/campaign-node-primitives-adapter.mjs',
  'paper-adapters/automation/campaign-node-workspace-support.mjs',
  'paper-adapters/automation/campaign-release-packager.mjs',
  'paper-adapters/automation/campaign-release-repository.mjs',
  'paper-adapters/build-package/research-evidence-capsule.mjs',
  'paper-adapters/build-package/offline-operator-dataset-authority-verifier.mjs',
  'paper-adapters/build-package/research-execution-release-attestor.mjs',
  'paper-adapters/build-package/offline-research-execution-release-attestation-verifier.mjs',
  'paper-domain/automation/campaign-release-execution-attestation-contract.mjs',
  'paper-adapters/runtime/scoped-file-materialization-recovery-record.mjs',
  'paper-adapters/runtime/scoped-file-materialization-repository.mjs',
  'paper-adapters/automation/multi-language-empirical-executor.mjs',
  'paper-adapters/automation/runtime-retention.mjs',
  'paper-adapters/automation/workspace-registry.mjs',
  'paper-adapters/automation/workspace-snapshot-exporter.mjs',
  'paper-adapters/automation/workspace-retention-evidence.mjs',
  'paper-adapters/runtime/os-sandboxed-worker-runner.mjs',
  'paper-adapters/artifacts/filesystem-report-receipt-ledger.mjs',
  'paper-adapters/artifacts/filesystem-report-receipt-repository.mjs',
  'paper-adapters/persistence/sqlite-workflow-state-store.mjs',
  'paper-adapters/persistence/sqlite-store.mjs',
  'paper-adapters/persistence/sqlite-unit-of-work.mjs',
  'paper-adapters/persistence/sqlite-referee-issue-query.mjs',
  'paper-adapters/persistence/sqlite-campaign-release-authority-repository.mjs',
  'paper-adapters/persistence/scoped-schema-version-gate.mjs',
  'paper-adapters/persistence/store-provider.mjs',
  'paper-composition/batch/paper-batch-application.mjs',
  'paper-composition/bootstrap/batch-inventory-context-bootstrap.mjs',
  'paper-composition/bootstrap/automation-context-bootstrap.mjs',
  'paper-composition/bootstrap/capability-scoped-bootstrap.mjs',
  'paper-composition/bootstrap/context-foundation-composition.mjs',
  'paper-composition/compat/legacy-stage-port-composition.mjs',
  'paper-composition/bootstrap/typed-persistence-composition.mjs',
  'paper-adapters/persistence/sqlite-campaign-store.mjs',
  'paper-application/automation/campaign-engine.mjs',
  'paper-ports/campaign-store-port.mjs',
  'paper-ports/campaign-release-packager-port.mjs',
  'paper-ports/campaign-release-authority-port.mjs',
  'paper-domain/automation/campaign-release-contracts.mjs',
  'paper-domain/automation/campaign-release-evidence-capsule-contract.mjs',
  'paper-domain/automation/public-authority-trust-snapshot-contract.mjs',
  'paper-domain/automation/campaign-state-policy.mjs',
  'paper-domain/workflow/operational-authority-policy.mjs',
  'paper-adapters/submission/campaign-release-bundle-consumer.mjs',
  'paper-adapters/submission/submission-authority-orchestrator.mjs',
  'paper-adapters/submission/submission-lifecycle-orchestrator.mjs',
  'paper-adapters/submission/sqlite-delivery-persistence.mjs',
  'paper-adapters/submission/sqlite-delivery-row-mappers.mjs',
  'paper-adapters/submission/sqlite-delivery-outbox-operations.mjs',
  'paper-adapters/submission/sqlite-delivery-response-operations.mjs',
  'paper-adapters/submission/sqlite-delivery-redrive-operations.mjs',
  'paper-adapters/submission/sqlite-delivery-consumption-operations.mjs',
  'paper-adapters/persistence/receipt-issuer-policy.mjs',
  'paper-adapters/persistence/receipt-writer-broker.mjs',
  'paper-adapters/persistence/sqlite-receipt-ledger.mjs',
  'paper-adapters/persistence/sqlite-receipt-ledger-qualification.mjs',
  'paper-adapters/persistence/sqlite-job-receipt-store.mjs',
  'paper-composition/bootstrap/receipt-ledger-composition.mjs',
  'paper-core/bin/hepta-store.mjs',
  'paper-core/bin/automation-status.mjs',
  'paper-adapters/empirical-analysis/trusted-experiment-producer.mjs',
  'paper-adapters/research-verify/trusted-formal-producer.mjs',
  'paper-adapters/research-verify/worker-runtime.mjs',
  'paper-adapters/research-verify/research-evidence-reader.mjs',
  'paper-adapters/research-verify/research-report-builder.mjs',
  'paper-adapters/referee-revise/repair-patch-bundle.mjs',
  'paper-adapters/referee-revise/repair-apply-executor.mjs',
  'paper-adapters/referee-revise/repair-rollback-executor.mjs',
  'paper-adapters/referee-revise/repair-proof-builder.mjs',
  'paper-domain/evidence/receipt-hash-policy.mjs',
  'paper-domain/evidence/receipt-hash-selector.mjs',
  'paper-domain/evidence/trusted-ledger-receipt.mjs',
  'paper-domain/governance/release-trust-layer-gate.mjs',
  'paper-adapters/governance/external-intake-verifier.mjs',
  'paper-core/bin/verify-external-intake.mjs',
  'paper-domain/research/evidence-quality-gate.mjs',
  'paper-domain/research/experiment-evidence-binding.mjs',
  'paper-domain/research/formal-certificate-intake.mjs',
  'paper-adapters/referee-revise/planning-service.mjs',
  'paper-adapters/submission/live-authorization.mjs',
  'paper-application/reporting/metric-descriptor-collector.mjs',
];
const TRUST_TARGETS = new Set([
  'paper-domain/automation/automation-readiness-side-effect-inspection.mjs',
  'paper-domain/automation/autonomous-research-supervisor-external-action-journal.mjs',
  'paper-domain/automation/autonomous-research-provider-canary-side-effect-inspection.mjs',
  'paper-adapters/automation/autonomous-research-supervisor-state-repository.mjs',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs',
  'paper-adapters/automation/autonomous-research-supervisor-provider-canary-state-operations.mjs',
  'paper-application/automation/autonomous-research-supervisor-provider-canary-dispatch.mjs',
  'paper-application/automation/autonomous-research-supervisor-dispatch-authorization.mjs',
  'paper-application/automation/autonomous-research-supervisor-progress.mjs',
  'paper-application/automation/autonomous-research-campaign.mjs',
  'paper-composition/automation/autonomous-research-supervisor-external-action-composition.mjs',
  'paper-composition/automation/autonomous-research-provider-canary.mjs',
  'paper-application/automation/autonomous-research-topic-producer-live-authority.mjs',
  'paper-application/automation/autonomous-research-topic-producer.mjs',
  'paper-adapters/automation/autonomous-research-topic-producer-repository-support.mjs',
  'paper-adapters/automation/autonomous-research-topic-producer-canary-journal-operations.mjs',
  'paper-adapters/automation/autonomous-research-topic-producer-repository.mjs',
  'paper-adapters/automation/autonomous-research-machine-intake-authority.mjs',
  'paper-adapters/automation/autonomous-research-machine-intake-authority-rotation-authorization.mjs',
  'paper-adapters/automation/runtime-image-registry.mjs',
  'paper-adapters/automation/runtime-image-build-input-closure.mjs',
  'paper-adapters/persistence/receipt-issuer-policy.mjs',
  'paper-adapters/persistence/receipt-writer-broker.mjs',
  'paper-adapters/persistence/sqlite-receipt-ledger.mjs',
  'paper-adapters/persistence/sqlite-receipt-ledger-qualification.mjs',
  'paper-adapters/persistence/sqlite-job-receipt-store.mjs',
  'paper-composition/bootstrap/receipt-ledger-composition.mjs',
  'paper-core/bin/hepta-store.mjs',
  'paper-adapters/empirical-analysis/trusted-experiment-producer.mjs',
  'paper-adapters/research-verify/trusted-formal-producer.mjs',
  'paper-domain/evidence/receipt-hash-policy.mjs',
  'paper-domain/evidence/trusted-ledger-receipt.mjs',
  'paper-domain/governance/release-trust-layer-gate.mjs',
  'paper-adapters/governance/external-intake-verifier.mjs',
  'paper-adapters/submission/submission-authority-orchestrator.mjs',
  'paper-adapters/submission/live-authorization.mjs',
  'paper-adapters/build-package/offline-operator-dataset-authority-verifier.mjs',
  'paper-adapters/build-package/research-execution-release-attestor.mjs',
  'paper-adapters/build-package/offline-research-execution-release-attestation-verifier.mjs',
  'paper-domain/automation/campaign-release-execution-attestation-contract.mjs',
  'paper-domain/automation/public-authority-trust-snapshot-contract.mjs',
]);
const TARGET_THRESHOLDS = new Map([
  ['paper-adapters/automation/workspace-attempt-repository.mjs', { lines: 80, functions: 85, maxUncoveredBranchBlocks: 110 }],
  ['paper-adapters/automation/isolated-agent-executor.mjs', { lines: 75, functions: 80, maxUncoveredBranchBlocks: 60 }],
  ['paper-application/automation/campaign-node-executor.mjs', { lines: 55, functions: 50, maxUncoveredBranchBlocks: 110 }],
  ['paper-adapters/runtime/scoped-file-materialization-repository.mjs', { lines: 80, functions: 90, maxUncoveredBranchBlocks: 70 }],
]);

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

try {
  const testBatches = [tests.slice(0, 14), tests.slice(14, 28), tests.slice(28)];
  const commands = [
    ...testBatches.map((batch) => ['--test', '--test-concurrency=1', ...batch]),
    ['paper-core/verification/selftest.mjs'],
    ['paper-core/verification/authority-pipeline-selftest.mjs'],
    ['paper-core/verification/remediation-selftest.mjs'],
    ['migration/tests/p1-referee-revise-retirements.mjs'],
  ];
  const failed = commands.map((args) => spawnSync(process.execPath, args, {
    cwd: workspaceRoot,
    env: { ...process.env, NODE_V8_COVERAGE: coverageRoot },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })).find((run) => run.status !== 0);
  if (failed) {
    process.stdout.write(failed.stdout || '');
    process.stderr.write(failed.stderr || '');
    process.exitCode = failed.status || 1;
  } else {
    const entries = coverageEntries();
    const report = targets.map((target) => moduleCoverage(target, entries));
    const failures = report.filter((row) => {
      const threshold = TARGET_THRESHOLDS.get(row.relative)
        || (TRUST_TARGETS.has(row.relative) ? { lines: 55, functions: 40, maxUncoveredBranchBlocks: 48 } : { lines: 40, functions: 25, maxUncoveredBranchBlocks: 180 });
      return row.missing || row.lines < threshold.lines || row.functions < threshold.functions || row.uncoveredBranchBlocks > threshold.maxUncoveredBranchBlocks;
    });
    process.stdout.write(`${JSON.stringify({
      ok: failures.length === 0,
      kind: 'CriticalModuleCoverageReport',
      thresholds: {
        default: { lines: 40, functions: 25, maxUncoveredBranchBlocks: 180 },
        trustBoundary: { lines: 55, functions: 40, maxUncoveredBranchBlocks: 48 },
        targetOverrides: Object.fromEntries(TARGET_THRESHOLDS),
      },
      modules: report,
      failures: failures.map((row) => row.relative),
    }, null, 2)}\n`);
    if (failures.length) process.exitCode = 1;
  }
} finally {
  fs.rmSync(coverageRoot, { recursive: true, force: true });
}
