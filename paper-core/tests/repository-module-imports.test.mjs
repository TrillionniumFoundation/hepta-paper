import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { parse } from 'espree';
import {
  OPENCLAW_MODEL_RUNTIME_PACKAGE_EXPORTS,
  openClawModelRuntimeLocation,
} from '../../paper-adapters/automation/codex-openclaw-managed-configuration.mjs';
import { HEPTA_PAPER_COMMAND_REGISTRY, classifyNpmScriptSurface } from '../src/command-registry.mjs';
import {
  ARCHITECTURE_ENTRYPOINT_MANIFEST,
  assertArchitectureEntrypointManifest,
} from '../src/architecture-entrypoint-manifest.mjs';
import {
  COMPATIBILITY_FACADE_CATALOG,
  STABLE_PUBLIC_FACADE_CATALOG,
} from '../src/compatibility-facade-catalog.mjs';
import { FORMAL_ASSURANCE_LADDER } from '../../paper-domain/research/formal-verifier-policy.mjs';
import { FORMAL_VERIFIER_REGISTRY } from '../../paper-domain/research/formal-verifier-registry.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { inspectTrackedProductionGraph } from '../verification/tracked-production-graph.mjs';
import { relativeModuleSpecifiers } from '../verification/javascript-module-specifiers.mjs';

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleRoots = Object.freeze([
  'workflow-kernel',
  'paper-ports',
  'paper-domain',
  'paper-application',
  'paper-adapters',
  'paper-composition',
  'paper-core/src',
  'paper-core/bin',
  'paper-core/verification',
  'paper-core/experimental',
  'paper-core/tests',
  'migration',
]);
const entrypoints = assertArchitectureEntrypointManifest(ARCHITECTURE_ENTRYPOINT_MANIFEST);
const compatibilityMarkers = Object.freeze([
  '/paper-composition/compat/',
  '/paper-core/src/contracts/',
  '/paper-core/src/paper-contract',
]);
const experimentalMarkers = Object.freeze([
  '/paper-composition/pilots/',
  '/paper-core/experimental/',
  '/paper-application/experimental/',
  '/paper-adapters/experimental/',
  '/paper-ports/experimental/',
]);
const verificationMarkers = Object.freeze([
  '/paper-core/tests/',
  '/paper-core/verification/',
]);
const migrationSupportMarkers = Object.freeze([
  '/migration/',
  '/paper-core/bin/legacy-immutable-snapshot.mjs',
  '/paper-core/bin/retire-legacy-archive.mjs',
]);
const architectureCategories = Object.freeze([
  'production',
  'compatibility',
  'experimental',
  'verification',
  'maintenance',
  'migrationSupport',
]);
const architectureOwnershipPriority = Object.freeze([
  'production',
  'compatibility',
  'experimental',
  'migrationSupport',
  'verification',
  'maintenance',
]);
const architectureMetricBudgets = Object.freeze({
  production: Object.freeze({ lines: 750, functions: 50, dependencies: 20 }),
  verification: Object.freeze({ lines: 900, testLines: 1500, functions: 80, dependencies: 25 }),
  maintenance: Object.freeze({ lines: 900, functions: 80, dependencies: 25 }),
  migrationSupport: Object.freeze({ lines: 900, functions: 80, dependencies: 30 }),
});

const layerImports = Object.freeze({
  'workflow-kernel': new Set(['workflow-kernel']),
  'paper-domain': new Set(['paper-domain', 'workflow-kernel']),
  'paper-ports': new Set(['paper-ports', 'paper-domain', 'workflow-kernel']),
  'paper-application': new Set(['paper-application', 'paper-ports', 'paper-domain', 'workflow-kernel']),
  'paper-adapters': new Set(['paper-adapters', 'paper-ports', 'paper-domain', 'workflow-kernel']),
  'paper-composition': new Set(['paper-composition', 'paper-adapters', 'paper-application', 'paper-ports', 'paper-domain', 'workflow-kernel']),
  'paper-core/src': new Set(['paper-core/src', 'paper-composition', 'paper-adapters', 'paper-application', 'paper-ports', 'paper-domain', 'workflow-kernel']),
  'paper-core/bin': new Set(['paper-core/bin', 'paper-core/src', 'paper-composition', 'paper-application', 'paper-ports', 'paper-domain', 'workflow-kernel']),
});

function packageScriptModuleEntries(groups) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'));
  const surface = classifyNpmScriptSurface(Object.keys(packageJson.scripts || {}));
  const selected = new Set((Array.isArray(groups) ? groups : [groups]).flatMap((group) => surface.groups[group] || []));
  const entries = [];
  for (const [name, command] of Object.entries(packageJson.scripts || {})) {
    if (!selected.has(name)) continue;
    for (const match of command.matchAll(/\b((?:paper-|workflow-|migration\/)[\w./-]+\.mjs)\b/g)) {
      if (fs.existsSync(path.join(workspaceRoot, match[1]))) entries.push(match[1]);
    }
  }
  return [...new Set(entries)];
}

function posix(relative) { return relative.replace(/\\/g, '/'); }

function dynamicImportExpressions(source) {
  const syntax = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
  });
  const pending = [syntax];
  const expressions = [];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'ImportExpression') {
      expressions.push({
        expression: source.slice(node.source.start, node.source.end),
        nodeBuiltin: node.source.type === 'Literal'
          && typeof node.source.value === 'string'
          && node.source.value.startsWith('node:'),
      });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === 'object') pending.push(value);
    }
  }
  return expressions;
}

function modulesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return modulesUnder(absolute);
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) return [];
    return [posix(path.relative(workspaceRoot, absolute))];
  });
}

function resolveRelativeImport(importer, specifier) {
  const candidate = path.resolve(path.dirname(importer), specifier);
  for (const resolved of [candidate, `${candidate}.mjs`, path.join(candidate, 'index.mjs')]) {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  }
  return null;
}

function reachableModules(entries) {
  const pending = entries.map((entry) => path.resolve(workspaceRoot, entry));
  const reached = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (reached.has(file) || !fs.existsSync(file)) continue;
    reached.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of relativeModuleSpecifiers(source)) {
      const resolved = resolveRelativeImport(file, specifier);
      if (resolved && !reached.has(resolved)) pending.push(resolved);
    }
  }
  return reached;
}

function moduleDependencies(file) {
  const source = fs.readFileSync(file, 'utf8');
  return relativeModuleSpecifiers(source)
    .map((specifier) => resolveRelativeImport(file, specifier))
    .filter(Boolean);
}

function dependencyCycles(files) {
  const allowed = new Set(files);
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];
  function visit(file, trail = []) {
    if (visiting.has(file)) {
      cycles.push([...trail.slice(trail.indexOf(file)), file].map((item) => posix(path.relative(workspaceRoot, item))));
      return;
    }
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of moduleDependencies(file)) if (allowed.has(dependency)) visit(dependency, [...trail, file]);
    visiting.delete(file);
    visited.add(file);
  }
  for (const file of files) visit(file);
  return cycles;
}

function hasMarker(file, markers) {
  const normalized = `/${posix(path.relative(workspaceRoot, file))}`;
  return markers.some((marker) => normalized.includes(marker));
}

function sourceLayer(file) {
  const relative = posix(path.relative(workspaceRoot, file));
  return Object.keys(layerImports).find((root) => relative === root || relative.startsWith(`${root}/`)) || null;
}

function architectureMetrics(files) {
  return [...files]
    .filter((file) => file.endsWith('.mjs'))
    .map((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return {
        file: posix(path.relative(workspaceRoot, file)),
        lines: source.split(/\n/).length - 1,
        functions: [...source.matchAll(/\b(?:async\s+)?function\s+[A-Za-z]|\b[A-Za-z][A-Za-z0-9_]*\s*\([^)]*\)\s*\{/g)].length,
        dependencies: moduleDependencies(file).length,
      };
    });
}

function architectureBudgetViolations(metrics, moduleLabels) {
  const violations = [];
  for (const row of metrics) {
    const labels = moduleLabels.get(row.file);
    assert.ok(labels, `architecture_labels_missing:${row.file}`);
    const applicableBudgets = labels.exposure
      .map((category) => [category, architectureMetricBudgets[category]])
      .filter(([, budget]) => budget);
    const metricLimits = Object.freeze({
      lines: applicableBudgets.map(([category, budget]) => Object.freeze({
        category,
        limit: row.file.includes('/tests/') && budget.testLines
          ? budget.testLines
          : budget.lines,
      })),
      functions: applicableBudgets.map(([category, budget]) => Object.freeze({
        category,
        limit: budget.functions,
      })),
      dependencies: applicableBudgets.map(([category, budget]) => Object.freeze({
        category,
        limit: budget.dependencies,
      })),
    });
    for (const metric of Object.keys(metricLimits)) {
      if (metric === 'lines' && row.file.endsWith('.data.mjs')) continue;
      const finiteLimits = metricLimits[metric].filter(({ limit }) => Number.isFinite(limit));
      if (finiteLimits.length === 0) continue;
      const strictestLimit = Math.min(...finiteLimits.map(({ limit }) => limit));
      if (row[metric] <= strictestLimit) continue;
      violations.push(Object.freeze({
        file: row.file,
        metric,
        actual: row[metric],
        limit: strictestLimit,
        enforcedBy: Object.freeze(finiteLimits
          .filter(({ limit }) => limit === strictestLimit)
          .map(({ category }) => category)
          .sort()),
      }));
    }
  }
  return violations;
}

function layerImportViolations(files) {
  const violations = [];
  for (const file of files) {
    const importerLayer = sourceLayer(file);
    if (!importerLayer) continue;
    for (const dependency of moduleDependencies(file)) {
      const dependencyLayer = sourceLayer(dependency);
      if (dependencyLayer && !layerImports[importerLayer].has(dependencyLayer)) {
        violations.push(`${posix(path.relative(workspaceRoot, file))}->${posix(path.relative(workspaceRoot, dependency))}`);
      }
    }
  }
  return violations.sort();
}

function classifyRepositoryModules() {
  const productionReachable = reachableModules(entrypoints.production);
  const compatibilityReachable = reachableModules(entrypoints.compatibility);
  const experimentalReachable = reachableModules(entrypoints.experimental);
  const verificationReachable = reachableModules([
    ...entrypoints.verification,
    ...packageScriptModuleEntries(['verification', 'internal']),
  ]);
  const maintenanceReachable = reachableModules([
    ...entrypoints.maintenance,
    ...packageScriptModuleEntries('maintenance'),
  ]);
  const migrationSupportReachable = reachableModules([
    ...entrypoints.migrationSupport,
    ...packageScriptModuleEntries('retirement'),
  ]);
  const allModules = moduleRoots.flatMap((root) => modulesUnder(path.join(workspaceRoot, root)))
    .map((relative) => path.join(workspaceRoot, relative));
  const reachable = Object.freeze({
    production: productionReachable,
    compatibility: compatibilityReachable,
    experimental: experimentalReachable,
    verification: verificationReachable,
    maintenance: maintenanceReachable,
    migrationSupport: migrationSupportReachable,
  });
  const ownershipByCategory = Object.fromEntries(
    architectureCategories.map((category) => [category, new Set()]),
  );
  const exposureByCategory = Object.fromEntries(
    architectureCategories.map((category) => [category, new Set()]),
  );
  const moduleLabels = new Map();
  const unclassified = [];
  for (const file of allModules) {
    const exposure = new Set(architectureCategories
      .filter((category) => reachable[category].has(file)));
    if (hasMarker(file, compatibilityMarkers)) exposure.add('compatibility');
    if (hasMarker(file, experimentalMarkers)) exposure.add('experimental');
    if (hasMarker(file, verificationMarkers)) exposure.add('verification');
    if (hasMarker(file, migrationSupportMarkers)) exposure.add('migrationSupport');
    const orderedExposure = Object.freeze(architectureCategories
      .filter((category) => exposure.has(category)));
    const canonicalOwnership = architectureOwnershipPriority
      .find((category) => exposure.has(category)) || null;
    const relative = posix(path.relative(workspaceRoot, file));
    if (canonicalOwnership) {
      ownershipByCategory[canonicalOwnership].add(file);
      for (const category of orderedExposure) exposureByCategory[category].add(file);
      moduleLabels.set(relative, Object.freeze({
        canonicalOwnership,
        exposure: orderedExposure,
      }));
    } else {
      unclassified.push(relative);
    }
  }
  return Object.freeze({
    allModules,
    ownershipByCategory: Object.freeze(ownershipByCategory),
    exposureByCategory: Object.freeze(exposureByCategory),
    moduleLabels,
    unclassified: Object.freeze(unclassified.sort()),
    reachable,
  });
}

test('experimental exposure cannot downgrade a shared maintenance module budget', () => {
  const file = 'paper-core/experimental/shared-maintenance-over-budget-fixture.mjs';
  const metrics = Object.freeze([Object.freeze({
    file,
    lines: 901,
    functions: 1,
    dependencies: 1,
  })]);
  const sharedLabels = new Map([[file, Object.freeze({
    canonicalOwnership: 'experimental',
    exposure: Object.freeze(['experimental', 'maintenance']),
  })]]);
  assert.deepEqual(architectureBudgetViolations(metrics, sharedLabels), [{
    file,
    metric: 'lines',
    actual: 901,
    limit: 900,
    enforcedBy: ['maintenance'],
  }]);

  const experimentalOnlyLabels = new Map([[file, Object.freeze({
    canonicalOwnership: 'experimental',
    exposure: Object.freeze(['experimental']),
  })]]);
  assert.deepEqual(architectureBudgetViolations(metrics, experimentalOnlyLabels), []);
});

test('production recomputation composition cannot import verification seams or inject runners', () => {
  const taxonomy = classifyRepositoryModules();
  const productionFiles = [...taxonomy.reachable.production];
  assert.deepEqual(productionFiles
    .map((file) => posix(path.relative(workspaceRoot, file)))
    .filter((file) => file.startsWith('paper-core/tests/')), []);
  for (const file of productionFiles) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\bregisterHooks\b/);
  }

  const publicCompositionFiles = [
    'paper-adapters/automation/multi-language-empirical-executor.mjs',
    'paper-adapters/automation/system-benchmark-empirical-execution.mjs',
    'paper-adapters/automation/system-benchmark-harness.mjs',
    'paper-adapters/automation/system-benchmark-independent-recomputation-assurance.mjs',
    'paper-adapters/research-verify/process-isolated-system-benchmark-recomputation.mjs',
    'paper-adapters/automation/system-benchmark-typed-numeric-process.mjs',
    'paper-adapters/research-verify/process-isolated-typed-numeric-oracle-recomputation.mjs',
  ];
  const injectedRunner = /\b(?:runRawEventRecomputation|rawEventRecomputationSandboxWorkerRunner|sandboxWorkerRunner|authorizeSynchronousRawEventRecomputationRunner)\b/;
  for (const relative of publicCompositionFiles) {
    assert.doesNotMatch(fs.readFileSync(path.join(workspaceRoot, relative), 'utf8'), injectedRunner);
  }
  for (const relative of publicCompositionFiles.slice(2, 4)) {
    assert.doesNotMatch(fs.readFileSync(path.join(workspaceRoot, relative), 'utf8'), /\bnowEpochMs\b/);
  }

  const factory = path.join(
    workspaceRoot,
    'paper-adapters/research-verify/raw-event-recomputation-sandbox-runner-factory.mjs',
  );
  assert.deepEqual(productionFiles
    .filter((file) => moduleDependencies(file).includes(factory))
    .map((file) => posix(path.relative(workspaceRoot, file)))
    .sort(), [
    'paper-adapters/research-verify/process-isolated-system-benchmark-recomputation.mjs',
  ]);
  const typedFactory = path.join(
    workspaceRoot,
    'paper-adapters/research-verify/typed-numeric-oracle-sandbox-runner-factory.mjs',
  );
  assert.deepEqual(productionFiles
    .filter((file) => moduleDependencies(file).includes(typedFactory))
    .map((file) => posix(path.relative(workspaceRoot, file)))
    .sort(), [
    'paper-adapters/research-verify/process-isolated-typed-numeric-oracle-recomputation.mjs',
  ]);
  const wallClock = path.join(
    workspaceRoot,
    'paper-adapters/automation/system-benchmark-wall-clock.mjs',
  );
  assert.deepEqual(productionFiles
    .filter((file) => moduleDependencies(file).includes(wallClock))
    .map((file) => posix(path.relative(workspaceRoot, file)))
    .sort(), [
    'paper-adapters/automation/system-benchmark-independent-recomputation-assurance.mjs',
    'paper-adapters/automation/system-benchmark-result-repository.mjs',
  ]);

  const seamSource = fs.readFileSync(path.join(
    workspaceRoot,
    'paper-core/tests/support/raw-event-recomputation-sandbox-test-seam.mjs',
  ), 'utf8');
  const fixtureSource = fs.readFileSync(path.join(
    workspaceRoot,
    'paper-core/tests/support/raw-event-recomputation-sandbox-fixture.mjs',
  ), 'utf8');
  const closureSeamSource = fs.readFileSync(path.join(
    workspaceRoot,
    'paper-core/tests/support/production-experiment-closure-test-seam.mjs',
  ), 'utf8');
  const closureFixtureSource = fs.readFileSync(path.join(
    workspaceRoot,
    'paper-core/tests/support/production-experiment-closure-fixture.mjs',
  ), 'utf8');
  const verifierDoubleSource = fs.readFileSync(path.join(
    workspaceRoot,
    'paper-core/tests/test-doubles/raw-event-recomputation-os-sandbox-worker-receipt-contract.mjs',
  ), 'utf8');
  assert.match(seamSource, /const exactTestEdgeRedirects = new Map/);
  assert.match(seamSource, /context\.parentURL, resolved\.url/);
  assert.doesNotMatch(seamSource, /backend:\s*['"]bubblewrap['"]/);
  assert.match(closureSeamSource, /const redirects = new Map/);
  assert.match(closureSeamSource, /context\.parentURL, resolved\.url/);
  assert.doesNotMatch(closureSeamSource, /context\.parentURL\?\.split/);
  assert.doesNotMatch(closureSeamSource, /backend:\s*['"](?:bubblewrap|docker)['"]/);
  assert.doesNotMatch(closureFixtureSource, /backend:\s*['"](?:bubblewrap|docker)['"]/);
  assert.match(closureFixtureSource, /backend:\s*['"]fixture['"]/);
  assert.match(fixtureSource, /runnerId:\s*['"]fixture-kernel-isolation-worker-v4['"]/);
  assert.match(fixtureSource, /backend:\s*['"]fixture['"]/);
  assert.doesNotMatch(fixtureSource, /\bbackend\s*=/);
  assert.match(verifierDoubleSource, /receipt\.backend === ['"]fixture['"]/);
  assert.match(
    verifierDoubleSource,
    /verifyRealProductionOsSandboxWorkerReceipt\(receipt\)/,
  );
});

test('production inventory is reachable only from declared executable entrypoints', async () => {
  const taxonomy = classifyRepositoryModules();
  const {
    ownershipByCategory,
    exposureByCategory,
    moduleLabels,
    reachable,
  } = taxonomy;
  const production = reachable.production;
  const compatibilityReachable = reachable.compatibility;

  assert.ok(production.size >= 120, `unexpected reachable production inventory: ${production.size}`);
  assert.ok(ownershipByCategory.compatibility.size >= 5, `unexpected compatibility inventory: ${ownershipByCategory.compatibility.size}`);
  assert.ok(ownershipByCategory.experimental.size >= 4, `unexpected experimental inventory: ${ownershipByCategory.experimental.size}`);
  assert.ok(ownershipByCategory.verification.size > 0, 'verification inventory must be explicit');
  assert.ok(ownershipByCategory.maintenance.size > 0, 'maintenance inventory must be explicit');
  assert.ok(ownershipByCategory.migrationSupport.size > 0, 'migration-support inventory must be explicit');
  assert.deepEqual(taxonomy.unclassified, []);
  const owned = Object.values(ownershipByCategory).flatMap((files) => [...files]);
  assert.equal(owned.length, taxonomy.allModules.length);
  assert.equal(new Set(owned).size, taxonomy.allModules.length);
  assert.equal(moduleLabels.size, taxonomy.allModules.length);
  for (const category of architectureCategories) {
    for (const file of reachable[category]) {
      const relative = posix(path.relative(workspaceRoot, file));
      assert.equal(
        exposureByCategory[category].has(file),
        true,
        `architecture_reachability_exposure_missing:${category}:${relative}`,
      );
      assert.equal(
        moduleLabels.get(relative)?.exposure.includes(category),
        true,
        `architecture_module_exposure_missing:${category}:${relative}`,
      );
    }
  }

  assert.deepEqual(
    moduleLabels.get('paper-adapters/runtime/os-sandboxed-worker-runner.mjs'),
    {
      canonicalOwnership: 'production',
      exposure: [...architectureCategories],
    },
  );
  assert.equal(
    fs.existsSync(path.join(workspaceRoot, 'paper-core/bin/release-evidence-lib.mjs')),
    false,
    'the zero-consumer release evidence aggregator must stay retired',
  );
  assert.equal(
    fs.existsSync(path.join(workspaceRoot, 'paper-core/bin/release-evidence-content-tree.mjs')),
    false,
    'the zero-consumer legacy content-tree helper must stay retired',
  );

  for (const category of architectureCategories) {
    assert.deepEqual(dependencyCycles(reachable[category]), [], category);
    assert.deepEqual(layerImportViolations(reachable[category]), [], category);
  }

  const executableBins = modulesUnder(path.join(workspaceRoot, 'paper-core', 'bin'))
    .map((relative) => path.join(workspaceRoot, relative));
  assert.deepEqual(executableBins.flatMap((file) => moduleDependencies(file)
    .filter((dependency) => sourceLayer(dependency) === 'paper-adapters')
    .map((dependency) => `${posix(path.relative(workspaceRoot, file))}->${posix(path.relative(workspaceRoot, dependency))}`)), []);
  assert.deepEqual(entrypoints.production.filter((entry) => fs.readFileSync(path.join(workspaceRoot, entry), 'utf8')
    .includes('operator-adapter-composition.mjs')), []);
  const campaignCli = fs.readFileSync(path.join(workspaceRoot, 'paper-core/bin/paper-campaign.mjs'), 'utf8');
  const campaignCliComposition = fs.readFileSync(path.join(workspaceRoot, 'paper-composition/automation/paper-campaign-command-composition.mjs'), 'utf8');
  assert.match(campaignCli, /executePaperCampaignCommand\(\{/);
  assert.match(campaignCliComposition, /composeCampaignWorkerExecution\(\{/);
  assert.match(campaignCliComposition, /composeCampaignCommandService\(\{/);
  assert.doesNotMatch(campaignCli, /\.(?:pauseCampaign|resumeCampaign|extendCampaign|retryNode|cancelNode)\(/);
  assert.doesNotMatch(campaignCli, /paper-adapters\//);
  const automationStatusCli = fs.readFileSync(path.join(workspaceRoot, 'paper-core/bin/automation-status.mjs'), 'utf8');
  assert.match(automationStatusCli, /queryAutomationReadiness\(\{/);
  assert.doesNotMatch(automationStatusCli, /(?:spawnSync|createReadOnlyPaperStore|inspectFullResearchQualification)/);
  const campaignApplication = fs.readFileSync(path.join(workspaceRoot, 'paper-application/automation/campaign-node-executor.mjs'), 'utf8');
  const campaignContext = fs.readFileSync(path.join(workspaceRoot, 'paper-application/automation/campaign-node-execution-context.mjs'), 'utf8');
  const campaignEmpirical = fs.readFileSync(path.join(workspaceRoot, 'paper-application/automation/campaign-empirical-node-orchestrator.mjs'), 'utf8');
  const campaignQualityRelease = fs.readFileSync(path.join(workspaceRoot, 'paper-application/automation/campaign-quality-release-orchestrator.mjs'), 'utf8');
  const campaignPrimitives = [
    'campaign-agent-primitives-adapter.mjs',
    'campaign-empirical-primitives-adapter.mjs',
    'campaign-quality-primitives-adapter.mjs',
    'campaign-release-primitives-adapter.mjs',
    'campaign-workspace-primitives-adapter.mjs',
  ].map((relative) => fs.readFileSync(path.join(workspaceRoot, 'paper-adapters/automation', relative), 'utf8')).join('\n');
  const campaignComposition = fs.readFileSync(path.join(workspaceRoot, 'paper-composition/automation/campaign-node-execution-composition.mjs'), 'utf8');
  assert.match(campaignApplication, /export \{ campaignNodeOperation \}/);
  assert.match(campaignApplication, /deferWorkspaceIntegration/);
  assert.doesNotMatch(`${campaignApplication}\n${campaignContext}\n${campaignEmpirical}\n${campaignQualityRelease}`, /paper-adapters\//);
  assert.match(campaignContext, /deriveCampaignNodeExecutionContext/);
  assert.match(campaignEmpirical, /executeWithRepair/);
  assert.match(campaignQualityRelease, /evaluateManuscriptPromotion/);
  assert.doesNotMatch(campaignPrimitives, /\ballNodes\b|requiredRevalidationForChanges|evaluateManuscriptPromotion|executeWithRepair|retryable\s*=\s*true/);
  assert.match(campaignComposition, /createApplicationCampaignNodeExecutor/);
  assert.match(campaignComposition, /createCampaignNodePrimitivesAdapter/);

  // File length is a coarse guardrail only; architecture-conformance applies
  // the stricter responsibility surface (public exports + dependency fanout).
  // A module keeps one canonical owner for inventory purposes, but every
  // reachable or path-marked category remains an exposure label. The strictest applicable
  // budget wins so an experimental entrypoint cannot weaken a maintenance,
  // verification, migration-support, or production constraint.
  assert.deepEqual(
    architectureBudgetViolations(architectureMetrics(taxonomy.allModules), moduleLabels),
    [],
  );

  const runnerFile = path.join(workspaceRoot, 'paper-adapters/runtime/os-sandboxed-worker-runner.mjs');
  const removedIdentityInputReferences = [...production]
    .filter((file) => file !== runnerFile)
    .filter((file) => fs.readFileSync(file, 'utf8').includes('containerImageIdentity'))
    .map((file) => posix(path.relative(workspaceRoot, file)));
  assert.deepEqual(removedIdentityInputReferences, []);
  const removedDigestInputCalls = [...production]
    .filter((file) => file !== runnerFile)
    .filter((file) => /(?:workerRunner|runner)\.run\s*\(\s*\{[\s\S]{0,1200}?\bcontainerImageDigest\s*:/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => posix(path.relative(workspaceRoot, file)));
  assert.deepEqual(removedDigestInputCalls, []);

  const automation = reachableModules(['paper-composition/bootstrap/automation-context-bootstrap.mjs', 'paper-core/bin/paper-campaign.mjs']);
  assert.deepEqual([...automation].filter((file) => file.includes(`${path.sep}paper-adapters${path.sep}submission${path.sep}`)), []);
  assert.equal([...production].some((file) => file.endsWith(`${path.sep}legacy-stage-adapter-registry.mjs`)), false);
  assert.equal([...production].some((file) => file.endsWith(`${path.sep}legacy-context-bootstrap.mjs`)), false);
  assert.equal([...production].some((file) => file.endsWith(`${path.sep}legacy-stage-port-composition.mjs`)), false);
  assert.deepEqual(
    [...production]
      .filter((file) => file.includes(`${path.sep}paper-adapters${path.sep}empirical-analysis${path.sep}`))
      .map((file) => posix(path.relative(workspaceRoot, file))),
    [],
  );
  assert.equal([...compatibilityReachable].some((file) => file.endsWith(`${path.sep}legacy-stage-port-composition.mjs`)), true);

  const operator = reachableModules(packageScriptModuleEntries('operator'));
  const forbiddenOperatorModules = [...operator].filter((file) => (
    hasMarker(file, compatibilityMarkers)
    || hasMarker(file, experimentalMarkers)
    || posix(path.relative(workspaceRoot, file)).startsWith('core/src/')
  ));
  assert.deepEqual(forbiddenOperatorModules, []);
  const externalRuntimeImports = [];
  for (const file of production) {
    const source = fs.readFileSync(file, 'utf8');
    for (const dynamicImport of dynamicImportExpressions(source)) {
      if (dynamicImport.nodeBuiltin) continue;
      externalRuntimeImports.push({
        file: posix(path.relative(workspaceRoot, file)),
        expression: dynamicImport.expression,
      });
    }
  }
  const byImportIdentity = (left, right) => (
    `${left.file}\0${left.expression}`.localeCompare(`${right.file}\0${right.expression}`)
  );
  assert.deepEqual(
    externalRuntimeImports.sort(byImportIdentity),
    entrypoints.externalRuntimeImports.map((declaration) => ({
      file: declaration.importer,
      expression: declaration.expression,
    })).sort(byImportIdentity),
  );
  assert.deepEqual(
    entrypoints.externalRuntimeImports.map((declaration) => ({
      locationProperty: declaration.locationProperty,
      packageName: declaration.packageName,
      packageExport: declaration.packageExport,
      requiredExports: declaration.requiredExports,
    })),
    OPENCLAW_MODEL_RUNTIME_PACKAGE_EXPORTS,
  );

  const importable = [...production]
    .filter((file) => !file.includes(`${path.sep}paper-core${path.sep}bin${path.sep}`))
    .filter((file) => !exposureByCategory.experimental.has(file));
  const failures = [];
  for (const file of importable) {
    try { await import(pathToFileURL(file).href); }
    catch (error) { failures.push({ relative: posix(path.relative(workspaceRoot, file)), error: error?.stack || error?.message || String(error) }); }
  }
  assert.deepEqual(failures, []);
});

test('every supported operator executable is covered by the production architecture manifest', () => {
  const declared = new Set(entrypoints.production);
  const routeEntrypoints = Object.values(HEPTA_PAPER_COMMAND_REGISTRY.operator)
    .filter((route) => route.argv[0] === 'node' && /^paper-core\/bin\/[^/]+\.mjs$/.test(route.argv[1] || ''))
    .map((route) => route.argv[1]);
  const npmEntrypoints = packageScriptModuleEntries('operator')
    .filter((entry) => /^paper-core\/bin\/[^/]+\.mjs$/.test(entry));
  for (const candidate of new Set(['paper-core/bin/hepta-paper.mjs', ...routeEntrypoints, ...npmEntrypoints])) {
    assert.equal(declared.has(candidate), true, `operator_entrypoint_missing_from_architecture_manifest:${candidate}`);
  }
});

test('OpenClaw external runtime edges resolve only declared public package exports', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-openclaw-package-exports-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, 'openclaw.mjs');
  fs.writeFileSync(binary, 'export {};\n');
  const exports = Object.fromEntries(OPENCLAW_MODEL_RUNTIME_PACKAGE_EXPORTS.map(
    (descriptor) => {
      const target = `./dist/plugin-sdk/${descriptor.packageExport.split('/').at(-1)}.js`;
      const absolute = path.join(root, target);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, 'export const fixture = true;\n');
      return [descriptor.packageExport, { default: target }];
    },
  ));
  const packagePath = path.join(root, 'package.json');
  const writePackage = (value) => fs.writeFileSync(
    packagePath,
    `${JSON.stringify(value, null, 2)}\n`,
  );
  writePackage({ name: 'openclaw', type: 'module', exports });

  const located = openClawModelRuntimeLocation(binary);
  assert.equal(located.packageRoot, root);
  for (const descriptor of OPENCLAW_MODEL_RUNTIME_PACKAGE_EXPORTS) {
    assert.equal(
      located[descriptor.locationProperty],
      path.join(
        root,
        exports[descriptor.packageExport].default,
      ),
    );
  }

  const missingExport = structuredClone(exports);
  delete missingExport['./plugin-sdk/session-store-runtime'];
  writePackage({ name: 'openclaw', type: 'module', exports: missingExport });
  assert.throws(
    () => openClawModelRuntimeLocation(binary),
    /codex_openclaw_managed_model_runtime_unavailable/,
  );

  writePackage({
    name: 'openclaw',
    type: 'module',
    exports: {
      ...exports,
      './plugin-sdk/session-store-runtime': { default: '../outside.js' },
    },
  });
  assert.throws(
    () => openClawModelRuntimeLocation(binary),
    /codex_openclaw_managed_model_runtime_unavailable/,
  );
});

test('release production graph is hash-bound to the Git index and rejects worktree-only modules', (t) => {
  const inheritedGitIndexFile = process.env.GIT_INDEX_FILE;
  delete process.env.GIT_INDEX_FILE;
  t.after(() => {
    if (inheritedGitIndexFile === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = inheritedGitIndexFile;
  });

  const releaseVerificationRunner = fs.readFileSync(path.join(
    workspaceRoot,
    'paper-core/bin/run-isolated-verification.mjs',
  ), 'utf8');
  assert.match(
    releaseVerificationRunner,
    /mode === 'release'[\s\S]+prepareImmutableReleaseWorkspace\([\s\S]+inspectTrackedProductionGraph\(\{ workspaceRoot: executionWorkspaceRoot \}\)/,
  );
  assert.match(releaseVerificationRunner, /productionGraphManifestHash: productionGraphTracking\.productionGraphManifestHash/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-tracked-production-graph-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function git(...args) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, String(result.stderr || result.stdout || 'git fixture failed'));
  }
  function write(relative, content) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }

  git('init', '--quiet');
  write('src/entry.mjs', "import { value } from './tracked.mjs';\nexport { value };\n");
  write('src/tracked.mjs', 'export const value = 1;\n');
  git('add', '--', 'src/entry.mjs', 'src/tracked.mjs');

  const ready = inspectTrackedProductionGraph({ workspaceRoot: root, entrypoints: ['src/entry.mjs'] });
  assert.equal(ready.status, 'tracked_production_graph_ready');
  assert.equal(ready.allProductionModulesTracked, true);
  assert.equal(ready.moduleCount, 2);
  assert.equal(ready.edgeCount, 1);
  assert.match(ready.productionGraphManifestHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(ready.manifest.modules.map((row) => row.path), ['src/entry.mjs', 'src/tracked.mjs']);
  assert.equal(inspectTrackedProductionGraph({
    workspaceRoot: root,
    entrypoints: ['src/entry.mjs'],
    expectedManifestHash: ready.productionGraphManifestHash,
  }).status, 'tracked_production_graph_ready');

  write('src/side-effect.mjs', 'globalThis.__sideEffectFixture = true;\n');
  write('src/entry.mjs', [
    "import './side-effect.mjs';",
    "import { value } from './tracked.mjs';",
    "export { value };",
    "// import './comment-only.mjs';",
    "const text = \"import './string-only.mjs'\";",
    'void text;',
    '',
  ].join('\n'));
  const sideEffectOnly = inspectTrackedProductionGraph({ workspaceRoot: root, entrypoints: ['src/entry.mjs'] });
  assert.deepEqual(sideEffectOnly.untrackedModules, ['src/side-effect.mjs']);
  assert.deepEqual(sideEffectOnly.unresolvedImports, []);
  assert.equal(sideEffectOnly.moduleCount, 3);

  write('src/entry.mjs', "import { value } from './tracked.mjs';\nimport { extra } from './worktree-only.mjs';\nexport { extra, value };\n");
  write('src/worktree-only.mjs', 'export const extra = 2;\n');
  const worktreeOnly = inspectTrackedProductionGraph({ workspaceRoot: root, entrypoints: ['src/entry.mjs'] });
  assert.equal(worktreeOnly.status, 'tracked_production_graph_blocked');
  assert.deepEqual(worktreeOnly.untrackedModules, ['src/worktree-only.mjs']);
  assert.deepEqual(worktreeOnly.indexMismatchedModules, ['src/entry.mjs']);
  assert.ok(worktreeOnly.blockers.includes('production_graph_modules_untracked'));
  assert.ok(worktreeOnly.blockers.includes('production_graph_modules_not_index_bound'));

  git('add', '--', 'src/entry.mjs', 'src/worktree-only.mjs');
  const rebound = inspectTrackedProductionGraph({
    workspaceRoot: root,
    entrypoints: ['src/entry.mjs'],
    expectedManifestHash: ready.productionGraphManifestHash,
  });
  assert.equal(rebound.status, 'tracked_production_graph_blocked');
  assert.deepEqual(rebound.untrackedModules, []);
  assert.deepEqual(rebound.indexMismatchedModules, []);
  assert.deepEqual(rebound.blockers, ['production_graph_manifest_hash_mismatch']);
  assert.notEqual(rebound.productionGraphManifestHash, ready.productionGraphManifestHash);
});

test('formal and empirical assurance tiers remain explicit and production-safe', () => {
  assert.deepEqual(FORMAL_ASSURANCE_LADDER.singleFileLean, {
    assuranceLevel: 'syntax_smoke_only',
    academicPromotionEligible: false,
    promotionScope: 'none',
  });
  assert.equal(FORMAL_ASSURANCE_LADDER.lakeClaimReplay.workerType, 'formal_verifier_lake');
  assert.equal(FORMAL_ASSURANCE_LADDER.lakeClaimReplay.requiredVerificationStatus, 'formal_claim_verified');
  assert.equal(FORMAL_ASSURANCE_LADDER.lakeClaimReplay.requiredReplayStatus, 'formal_claim_replay_verified');
  assert.equal(FORMAL_ASSURANCE_LADDER.lakeClaimReplay.academicPromotionEligible, true);
  for (const kind of ['coq', 'isabelle']) {
    assert.equal(FORMAL_VERIFIER_REGISTRY[kind].productionAvailability, 'unavailable');
    assert.equal(FORMAL_VERIFIER_REGISTRY[kind].academicPromotionEligible, false);
  }

  const smokeVerifier = fs.readFileSync(path.join(workspaceRoot, 'paper-adapters/research-verify/formal-verifier.mjs'), 'utf8');
  assert.match(smokeVerifier, /FORMAL_ASSURANCE_LADDER\.singleFileLean/);
  const formalPromotion = [
    'paper-adapters/research-verify/worker-runtime.mjs',
    'paper-adapters/research-verify/formal-academic-promotion-policy.mjs',
  ].map((relative) => fs.readFileSync(path.join(workspaceRoot, relative), 'utf8')).join('\n');
  assert.match(formalPromotion, /formal_promotion_requires_lake_verifier/);
  assert.match(formalPromotion, /formal_claim_independent_replay_required/);

  const compatibilityEmpirical = fs.readFileSync(path.join(workspaceRoot, 'paper-adapters/empirical-analysis/execution-contracts.mjs'), 'utf8');
  assert.match(compatibilityEmpirical, /assuranceLevel: 'compatibility_self_reported_execution_only'/);
  assert.match(compatibilityEmpirical, /academicPromotionEligible: false/);
  assert.match(compatibilityEmpirical, /promotionScope: 'compatibility_only'/);
  assert.match(compatibilityEmpirical, /receiptVocabulary: 'legacy-empirical-analysis-v1'/);
  assert.match(compatibilityEmpirical, /canonicalReceiptVocabulary: 'campaign-experiment-run-v1'/);
  const receipt = JSON.parse(fs.readFileSync(path.join(
    workspaceRoot,
    'migration/legacy-empirical-analysis-deprecation-receipt.v1.json',
  ), 'utf8'));
  const { legacyEmpiricalAnalysisDeprecationReceiptHash, ...payload } = receipt;
  assert.equal(receipt.status, 'legacy_empirical_analysis_compatibility_frozen');
  assert.equal(receipt.academicPromotionEligible, false);
  assert.equal(receipt.promotionScope, 'compatibility_only');
  assert.equal(hashRecord('LegacyEmpiricalAnalysisDeprecationReceipt', payload), legacyEmpiricalAnalysisDeprecationReceiptHash);
});

test('legacy empirical analysis is reachable only through explicit compatibility and verification boundaries', () => {
  const production = reachableModules(entrypoints.production);
  const compatibility = reachableModules(entrypoints.compatibility);
  const migrationCompatibility = reachableModules(['migration/tests/p1-plugin-wrapper-boundaries.mjs']);
  const empiricalDirectory = `${path.sep}paper-adapters${path.sep}empirical-analysis${path.sep}`;
  const legacyModules = modulesUnder(path.join(workspaceRoot, 'paper-adapters/empirical-analysis'))
    .map((relative) => path.join(workspaceRoot, relative));
  const deprecationReceipt = JSON.parse(fs.readFileSync(path.join(
    workspaceRoot,
    'migration/legacy-empirical-analysis-deprecation-receipt.v1.json',
  ), 'utf8'));

  assert.ok(legacyModules.length > 0);
  assert.deepEqual(
    fs.readdirSync(path.join(workspaceRoot, 'paper-adapters/empirical-analysis')).sort(),
    [...deprecationReceipt.implementationModules].sort(),
  );
  assert.deepEqual([...production].filter((file) => file.includes(empiricalDirectory)), []);
  assert.deepEqual(
    legacyModules.filter((file) => !compatibility.has(file)),
    [],
  );
  assert.equal(
    migrationCompatibility.has(path.join(workspaceRoot, 'paper-composition/compat/legacy-stage-adapter-registry.mjs')),
    true,
  );
  assert.deepEqual(
    legacyModules.filter((file) => !migrationCompatibility.has(file)),
    [],
  );

  const directImporters = moduleRoots
    .flatMap((root) => modulesUnder(path.join(workspaceRoot, root)))
    .filter((relative) => !relative.startsWith('paper-adapters/empirical-analysis/'))
    .filter((relative) => /(?:from\s+|import\s*\()['"][^'"]*paper-adapters\/empirical-analysis\//
      .test(fs.readFileSync(path.join(workspaceRoot, relative), 'utf8')));
  assert.deepEqual(directImporters.sort(), [
    'paper-composition/compat/legacy-stage-adapter-registry.mjs',
    'paper-core/tests/trusted-research-producers.test.mjs',
    'paper-core/verification/remediation-selftest.mjs',
    'paper-core/verification/selftest.mjs',
  ]);
});

test('compatibility and experimental modules are explicitly classified outside the production graph', () => {
  const production = reachableModules(entrypoints.production);
  const compatibilityReachable = reachableModules(entrypoints.compatibility);
  const allModules = moduleRoots.flatMap((root) => modulesUnder(path.join(workspaceRoot, root)))
    .map((relative) => path.join(workspaceRoot, relative));
  const compatibility = allModules.filter((file) => hasMarker(file, compatibilityMarkers));
  const experimental = allModules.filter((file) => hasMarker(file, experimentalMarkers));
  assert.ok(compatibility.some((file) => file.endsWith(`${path.sep}legacy-workflow-state-projection.mjs`)));
  assert.ok(compatibility.some((file) => file.endsWith(`${path.sep}legacy-stage-adapter-registry.mjs`)));
  assert.ok(experimental.some((file) => file.endsWith(`${path.sep}openclaw-taskflow-adapter.mjs`)));
  assert.equal([...production].some((file) => file.endsWith(`${path.sep}openclaw-taskflow-adapter.mjs`)), false);
  const compatibilityCli = reachableModules(['paper-core/bin/paper-compat-workflow-projection.mjs']);
  assert.equal([...compatibilityCli].some((file) => file.endsWith(`${path.sep}legacy-workflow-state-projection.mjs`)), true);
  assert.equal([...compatibilityCli].some((file) => file.endsWith(`${path.sep}batch-result-summary.mjs`)), true);
  const productionCli = production;
  assert.equal([...productionCli].some((file) => hasMarker(file, compatibilityMarkers)), false);
  assert.equal([...productionCli].some((file) => hasMarker(file, experimentalMarkers)), false);
  assert.equal([...productionCli].some((file) => file.endsWith(`${path.sep}batch-result-summary.mjs`)), false);
  assert.equal([...productionCli].some((file) => file.endsWith(`${path.sep}workflow-result-summary.mjs`)), false);
  assert.equal([...productionCli].some((file) => file.endsWith(`${path.sep}core-integrity.mjs`)), false);
  assert.equal([...production].some((file) => file.endsWith(`${path.sep}capability-scoped-bootstrap.mjs`)), false);
  assert.equal([...compatibilityReachable].some((file) => file.endsWith(`${path.sep}capability-scoped-bootstrap.mjs`)), true);
});

test('compatibility re-export facades are catalogued, tiny, and owned', () => {
  const paths = new Set();
  for (const row of COMPATIBILITY_FACADE_CATALOG) {
    assert.equal(paths.has(row.path), false, row.path);
    paths.add(row.path);
    assert.ok(row.owner, row.path);
    assert.ok(row.retireAfter, row.path);
    const source = fs.readFileSync(path.join(workspaceRoot, row.path), 'utf8');
    assert.match(source, /export\s+(?:\*|\{)/, row.path);
    assert.ok(source.split(/\n/).length - 1 <= 10, row.path);
  }

  const uncataloguedCrossOwnerFacades = modulesUnder(
    path.join(workspaceRoot, 'paper-adapters'),
  ).filter((relative) => {
    const absolute = path.join(workspaceRoot, relative);
    const source = fs.readFileSync(absolute, 'utf8');
    if (source.split(/\n/).length - 1 > 10) return false;
    const reexportSpecifiers = [...source.matchAll(
      /\bexport\s+(?:\*|\{[\s\S]*?\})\s+from\s+['"]([^'"]+)['"]/g,
    )].map((match) => match[1]);
    const facadeOwner = relative.split('/')[1];
    return reexportSpecifiers.some((specifier) => {
      const target = resolveRelativeImport(absolute, specifier);
      const targetParts = target
        ? posix(path.relative(workspaceRoot, target)).split('/')
        : [];
      return targetParts[0] === 'paper-adapters' && targetParts[1] !== facadeOwner;
    });
  }).filter((relative) => !paths.has(relative)).sort();
  assert.deepEqual(uncataloguedCrossOwnerFacades, []);
});

test('widely consumed paper-core runtime facades are versioned public APIs, not migration debt', () => {
  const compatibilityPaths = new Set(COMPATIBILITY_FACADE_CATALOG.map((row) => row.path));
  const publicPaths = new Set();
  for (const row of STABLE_PUBLIC_FACADE_CATALOG) {
    assert.equal(compatibilityPaths.has(row.path), false, row.path);
    assert.equal(publicPaths.has(row.path), false, row.path);
    publicPaths.add(row.path);
    assert.ok(row.owner, row.path);
    assert.ok(Number.isSafeInteger(row.apiVersion) && row.apiVersion >= 1, row.path);
    const source = fs.readFileSync(path.join(workspaceRoot, row.path), 'utf8');
    assert.match(source, /export\s+(?:\*|\{)/, row.path);
    assert.ok(source.split(/\n/).length - 1 <= 10, row.path);
  }
  assert.deepEqual([...publicPaths].sort(), [
    'paper-core/src/code-provenance.mjs',
    'paper-core/src/workspace-layout.mjs',
  ]);
});

test('SQLite campaign persistence is composed from bounded operation modules', () => {
  const facadePath = path.join(workspaceRoot, 'paper-adapters/persistence/sqlite-campaign-store.mjs');
  const facade = fs.readFileSync(facadePath, 'utf8');
  const operationModules = [
    'sqlite-campaign-query-operations.mjs',
    'sqlite-campaign-telemetry-operations.mjs',
    'sqlite-campaign-lifecycle-operations.mjs',
    'sqlite-campaign-lease-operations.mjs',
    'sqlite-campaign-node-attempt-operations.mjs',
    'sqlite-campaign-node-infrastructure-operations.mjs',
    'sqlite-campaign-prepared-integration-operations.mjs',
  ];
  assert.ok(facade.split(/\n/).length - 1 <= 150);
  for (const moduleName of operationModules) {
    assert.match(facade, new RegExp(moduleName.replaceAll('.', '\\.')));
    const source = fs.readFileSync(path.join(workspaceRoot, 'paper-adapters/persistence', moduleName), 'utf8');
    assert.ok(source.split(/\n/).length - 1 <= 250, moduleName);
  }
  const creationModuleName = 'sqlite-campaign-creation-operations.mjs';
  const lifecycleSource = fs.readFileSync(path.join(
    workspaceRoot,
    'paper-adapters/persistence/sqlite-campaign-lifecycle-operations.mjs',
  ), 'utf8');
  assert.match(lifecycleSource, new RegExp(creationModuleName.replaceAll('.', '\\.')));
  const creationSource = fs.readFileSync(path.join(
    workspaceRoot,
    'paper-adapters/persistence',
    creationModuleName,
  ), 'utf8');
  assert.ok(creationSource.split(/\n/).length - 1 <= 250, creationModuleName);
  const reservationSource = fs.readFileSync(path.join(
    workspaceRoot,
    'paper-adapters/persistence/sqlite-campaign-node-infrastructure-reservations.mjs',
  ), 'utf8');
  assert.ok(reservationSource.split(/\n/).length - 1 <= 250);
  for (const operation of ['createCampaign', 'claimReady', 'prepareNodeResult', 'completeNode', 'cancelCampaign']) {
    assert.doesNotMatch(facade, new RegExp(`\\b${operation}\\s*\\(`));
  }
});
