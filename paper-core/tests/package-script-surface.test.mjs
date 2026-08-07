import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import {
  parseFormalOperationalTapSummary,
} from '../bin/dynamic-formal-kernel-operational.mjs';
import {
  HEPTA_PAPER_COMMAND_REGISTRY,
  classifyNpmScriptSurface,
  generatedNpmRouteScripts,
  heptaPaperCiCommandMatrix,
  heptaPaperCommandUsage,
  inspectNpmScriptRegistry,
} from '../src/command-registry.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import {
  DECLARED_TEST_SUITES,
  declaredTestSuite,
  isOnlineMutationAutomationTest,
} from '../src/test-suite-manifest.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = packageJson.scripts || {};

function jsonLines(output) {
  return String(output || '').split(/\r?\n/).flatMap((line) => {
    const candidate = line.trim();
    if (!candidate.startsWith('{')) return [];
    try { return [JSON.parse(candidate)]; } catch { return []; }
  });
}

function formalOperationalTap(overrides = {}) {
  const counts = {
    tests: 22,
    suites: 0,
    pass: 22,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    ...overrides,
  };
  return [
    'TAP version 13',
    '1..22',
    ...Object.entries(counts).map(([name, value]) => `# ${name} ${value}`),
    '# duration_ms 109123.456',
    '',
  ].join('\n');
}

test('formal operational TAP parser requires one complete 22/22 terminal block at EOF', () => {
  assert.equal(parseFormalOperationalTapSummary(formalOperationalTap()).valid, true);
  const valid = formalOperationalTap();
  const cases = {
    skip: formalOperationalTap({ skipped: 1, pass: 21 }),
    forgedPrefix: `# skipped 0\n${valid}`,
    duplicateSummary: `${valid.trimEnd()}\n# tests 22\n`,
    missingPlan: valid.replace('1..22\n', ''),
    missingDuration: valid.replace('# duration_ms 109123.456\n', ''),
    truncated: valid.slice(0, -20),
    trailingGarbage: `${valid.trimEnd()}\ntrailing garbage\n`,
    testDrift: formalOperationalTap({ tests: 21 }),
    passDrift: formalOperationalTap({ pass: 21 }),
    failure: formalOperationalTap({ fail: 1, pass: 21 }),
    cancellation: formalOperationalTap({ cancelled: 1 }),
    todo: formalOperationalTap({ todo: 1 }),
  };
  for (const [name, candidate] of Object.entries(cases)) {
    assert.equal(
      parseFormalOperationalTapSummary(candidate).valid,
      false,
      name,
    );
  }
});

test('root package declares the pinned reference and a non-duplicated verification surface', () => {
  assert.deepEqual(packageJson.heptaPaper?.referencePackages, [{
    name: 'design-production-core',
    path: 'core',
    classification: 'pinned_submodule_reference',
    baseline: 'core/CORE_BASELINE.json',
    productionImportPolicy: 'forbidden',
  }]);
  assert.equal(packageJson.heptaPaper?.compatibilityManifest, 'migration/compatibility-support.v1.json');
  for (const name of [
    'reference:baseline:accept',
    'reference:integrity',
    'reference:selftest',
    'reference:runtime-dry-run',
    'safety:p0',
    'safety:p1',
    'safety:p2',
    'safety:all',
  ]) assert.equal(typeof scripts[name], 'string', name);
  assert.equal(scripts.selftest, undefined);
  assert.equal(scripts['test:contract-conformance'], undefined);
  assert.equal(scripts['paper:real-pilot'], undefined);
  assert.equal(typeof scripts['compat:legacy-workflow-projection'], 'string');
  assert.equal(typeof scripts['experimental:real-paper-pilot'], 'string');
  assert.equal(scripts['paper:submission-handoff'], 'node paper-core/bin/paper-submission-handoff.mjs');
  for (const name of [
    'core:baseline',
    'core:integrity',
    'core:selftest',
    'core:selftest:workspace',
    'core:runtime-dry-run',
  ]) assert.equal(scripts[name], undefined, name);
  const commands = new Map();
  for (const [name, command] of Object.entries(scripts)) {
    const aliases = commands.get(command) || [];
    aliases.push(name);
    commands.set(command, aliases);
  }
  assert.deepEqual([...commands.values()].filter((names) => names.length > 1), []);
  assert.match(scripts['ci:inner'], /npm run safety:all/);
  assert.match(scripts['ci:selftest'], /^npm run static:check/);
  assert.match(scripts['static:check'], /paper-core\/tests\/architecture-conformance\.test\.mjs/);
  assert.match(scripts['static:check'], /paper-core\/tests\/repository-module-imports\.test\.mjs/);
  assert.equal(
    scripts['test:impacted'],
    'node paper-core/bin/run-impacted-tests.mjs',
  );
  assert.equal(
    scripts['test:impacted:plan'],
    'node paper-core/bin/run-impacted-tests.mjs --dry-run --json',
  );
  assert.match(scripts['test:inner'], /npm run safety:all/);
  assert.match(scripts.test, /^npm run static:check/);
  assert.equal(
    scripts['release:verify'],
    'npm run static:check && npm run release:state-check -- --require-state release_ready'
      + ' && node paper-core/bin/run-isolated-verification.mjs release',
  );
  assert.doesNotMatch(scripts['release:inner'], /coverage:critical-modules/);
  assert.doesNotMatch(scripts['release:inner'], /coverage:repository/);
  assert.match(scripts['release:inner'], /coverage:system/);
  assert.match(scripts['release:inner'], /npm run test:academic-docker-operational/);
  assert.equal(
    scripts['release:inner'].split(' && ')
      .filter((step) => step === 'npm run test:dynamic-formal-kernel-operational').length,
    1,
  );
  assert.match(scripts['release:inner'], /npm run assets:cold-volume-release-gate/);
  assert.match(scripts['release:inner'], /npm run assets:cold-volume-cas-release-gate/);
  assert.match(scripts['release:inner'], /npm run store:restore-drill/);
  const releaseSteps = scripts['release:inner'].split(' && ');
  assert.ok(
    releaseSteps.indexOf('npm run test:academic-docker-operational')
      < releaseSteps.indexOf('npm run test:dynamic-formal-kernel-operational'),
  );
  assert.ok(
    releaseSteps.indexOf('npm run test:dynamic-formal-kernel-operational')
      < releaseSteps.indexOf('npm run test:migration-differential'),
  );
  assert.equal(
    releaseSteps.filter((step) => step === 'npm run legacy:deletion-drill').length,
    1,
  );
  assert.ok(
    releaseSteps.indexOf('npm run legacy:matrix-reference-status')
      < releaseSteps.indexOf('npm run legacy:deletion-drill'),
  );
  assert.ok(
    releaseSteps.indexOf('npm run legacy:deletion-drill')
      < releaseSteps.indexOf('npm run workspace:verify-decoupled'),
  );
  assert.doesNotMatch(scripts['release:inner'], /npm run assets:cold-volume-status(?:\s|$)/);
  assert.doesNotMatch(scripts['release:inner'], /npm run assets:cold-volume-cas-status(?:\s|$)/);
  assert.equal(scripts['assets:cold-volume-release-gate'],
    'node paper-core/bin/verify-cold-volume-contract.mjs --require-mounted');
  assert.equal(scripts['assets:cold-volume-cas-release-gate'],
    'node paper-core/bin/cold-volume-cas.mjs status --require-ready');
  assert.match(scripts['coverage:system-inner'], /--test-coverage-branches=54/);
  assert.match(scripts['coverage:system-inner'], /--test-skip-pattern='\^academic-docker-operational:'/);
  assert.equal(scripts['test:academic-docker-operational'], 'node paper-core/bin/academic-docker-operational.mjs');
  assert.equal(
    scripts['test:typed-numeric-process-operational'],
    'node --test --test-concurrency=1 paper-core/tests/typed-numeric-oracle-production.test.mjs',
  );
  assert.equal(
    scripts['test:dynamic-formal-kernel-operational'],
    'node paper-core/bin/dynamic-formal-kernel-operational.mjs',
  );
  const dynamicFormalOperationalRunner = fs.readFileSync(
    path.join(root, 'paper-core/bin/dynamic-formal-kernel-operational.mjs'),
    'utf8',
  );
  assert.match(dynamicFormalOperationalRunner,
    /HEPTA_DYNAMIC_FORMAL_KERNEL_OPERATIONAL_MODE: 'strict'/);
  assert.match(dynamicFormalOperationalRunner, /formal_operational_tap_summary_invalid/);
  const formalOperationalRunner = fs.readFileSync(
    path.join(root, 'paper-core/bin/dynamic-formal-kernel-operational.mjs'),
    'utf8',
  );
  assert.match(formalOperationalRunner, /HEPTA_FORMAL_OPERATIONAL_MODE: 'strict'/);
  assert.match(formalOperationalRunner, /formal_operational_tap_summary_invalid/);
  for (const required of [
    'dynamic-formal-claim-kernel-e2e.test.mjs',
    'formal-campaign-release.test.mjs',
    'formal-proof-search-operations.test.mjs',
    'typed-theorem-dependency-graph.test.mjs',
  ]) assert.match(formalOperationalRunner, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const required of [
    'paper-core/tests/academic-docker-operational-prerequisites.test.mjs',
    'paper-core/tests/hepta-store-restore-drill-exit.test.mjs',
    'paper-core/tests/isolated-verification-policy.test.mjs',
    'paper-core/tests/verification-runtime-isolation.test.mjs',
  ]) assert.match(scripts['safety:p0:inner'], new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const academicDockerTests = fs.readFileSync(
    path.join(root, 'paper-core/tests/docker-dataset-access-supervisor.test.mjs'),
    'utf8',
  );
  assert.equal((academicDockerTests.match(/test\('academic-docker-operational:/g) || []).length, 2);
});

test('dynamic formal operational runner fails non-zero instead of skipping a missing runtime', () => {
  const isolatedElanHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-missing-elan-'));
  try {
    const standaloneEnvironment = { ...process.env };
    delete standaloneEnvironment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      'paper-core/bin/dynamic-formal-kernel-operational.mjs',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...standaloneEnvironment, ELAN_HOME: isolatedElanHome },
      timeout: 30_000,
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /formal_operational_prerequisite_failed/,
    );
  } finally {
    fs.rmSync(isolatedElanHome, { recursive: true, force: true });
  }
});

test('unified formal operational runner fails non-zero instead of accepting skips', () => {
  const isolatedElanHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-missing-formal-elan-'));
  try {
    const standaloneEnvironment = { ...process.env };
    delete standaloneEnvironment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      'paper-core/bin/dynamic-formal-kernel-operational.mjs',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...standaloneEnvironment, ELAN_HOME: isolatedElanHome },
      timeout: 30_000,
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /formal_operational_prerequisite_failed|formal_operational_tap_summary_invalid/,
    );
  } finally {
    fs.rmSync(isolatedElanHome, { recursive: true, force: true });
  }
});

test('test:inner expands to a deduplicated test-file DAG', () => {
  const counts = new Map();
  const visiting = [];
  function expand(name) {
    assert.equal(visiting.includes(name), false, `npm script cycle: ${[...visiting, name].join(' -> ')}`);
    visiting.push(name);
    const command = scripts[name] || '';
    for (const match of command.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)) expand(match[1]);
    for (const match of command.matchAll(/run-declared-test-suite\.mjs\s+([A-Za-z0-9_-]+)\s+(full|deduplicated)/g)) {
      for (const candidate of declaredTestSuite(match[1], match[2]).tests) {
        counts.set(candidate, (counts.get(candidate) || 0) + 1);
      }
    }
    for (const match of command.matchAll(/(?:paper-core|migration)\/[A-Za-z0-9_./-]+\.test\.mjs/g)) {
      counts.set(match[0], (counts.get(match[0]) || 0) + 1);
    }
    visiting.pop();
  }
  expand('test:inner');
  assert.deepEqual([...counts].filter(([, count]) => count > 1), []);
});

test('full and deduplicated test suites are derived from one declarative manifest', () => {
  assert.equal(scripts['automation:selftest'], 'node paper-core/bin/run-declared-test-suite.mjs automation full');
  assert.equal(scripts['automation:selftest:deduplicated'], 'node paper-core/bin/run-declared-test-suite.mjs automation deduplicated');
  assert.equal(scripts['paper:salvage-hardening-selftest'], 'node paper-core/bin/run-declared-test-suite.mjs salvage-hardening full');
  assert.equal(scripts['paper:salvage-hardening-selftest:deduplicated'], 'node paper-core/bin/run-declared-test-suite.mjs salvage-hardening deduplicated');
  for (const [name, suite] of Object.entries(DECLARED_TEST_SUITES)) {
    assert.equal(new Set(suite.full).size, suite.full.length, `${name}:full`);
    assert.equal(new Set(suite.deduplicated).size, suite.deduplicated.length, `${name}:deduplicated`);
    assert.deepEqual(suite.deduplicated, suite.full.filter((candidate) => !suite.omittedFromDeduplicated.includes(candidate)));
    assert.deepEqual(declaredTestSuite(name, 'full').tests, suite.full);
    assert.deepEqual(declaredTestSuite(name, 'deduplicated').tests, suite.deduplicated);
    for (const candidate of suite.full) assert.equal(fs.existsSync(path.join(root, candidate)), true, candidate);
  }
  for (const required of [
    'paper-core/tests/autonomous-research-cold-start-e2e.test.mjs',
    'paper-core/tests/autonomous-research-machine-intake-authority-rotation.test.mjs',
    'paper-core/tests/autonomous-research-machine-intake-migration.test.mjs',
    'paper-core/tests/autonomous-research-machine-intake.test.mjs',
    'paper-core/tests/autonomous-research-qualification-progress.test.mjs',
    'paper-core/tests/autonomous-research-state-backup-journal-replay.test.mjs',
    'paper-core/tests/autonomous-research-state-backup-renewal.test.mjs',
    'paper-core/tests/autonomous-research-state-recoverability-controller.test.mjs',
    'paper-core/tests/autonomous-research-resident-cycle-intent.test.mjs',
    'paper-core/tests/autonomous-research-resident-deployment-identity.test.mjs',
    'paper-core/tests/autonomous-submission-handoff-layout-provision.test.mjs',
    'paper-core/tests/autonomous-submission-handoff-storage.test.mjs',
    'paper-core/tests/autonomous-submission-request-verifier-composition.test.mjs',
    'paper-core/tests/autonomous-research-topic-producer.test.mjs',
    'paper-core/tests/fully-autonomous-research-system-status.test.mjs',
    'paper-core/tests/full-research-qualification-prior-art-lineage.test.mjs',
    'paper-core/tests/http-prior-art-retrieval-adapter-v2.test.mjs',
    'paper-core/tests/prior-art-evidence-v2-contract.test.mjs',
    'paper-core/tests/experiment-replay-receipt-contract.test.mjs',
  ]) assert.ok(DECLARED_TEST_SUITES.automation.full.includes(required), required);
  const discoveredOnlineMutationTests = fs.readdirSync(path.join(root, 'paper-core', 'tests'))
    .filter(isOnlineMutationAutomationTest)
    .map((name) => `paper-core/tests/${name}`)
    .sort();
  assert.deepEqual(
    discoveredOnlineMutationTests.filter((candidate) => (
      !DECLARED_TEST_SUITES.automation.full.includes(candidate)
    )),
    [],
  );
});

test('one declarative registry owns supported routes and npm command classification', () => {
  assert.deepEqual(inspectNpmScriptRegistry(scripts), {
    version: 1,
    kind: 'NpmScriptRegistryInspection',
    ready: true,
    generatedAliases: generatedNpmRouteScripts(),
    aliasMismatches: [],
    blocked: [],
  });
  assert.deepEqual(heptaPaperCiCommandMatrix().nightly.map((entry) => entry.id), [
    'full-portable',
    'formal-cache',
    'academic-empirical',
    'typed-numeric',
    'dynamic-formal',
  ]);
  assert.deepEqual(heptaPaperCiCommandMatrix().pullRequest, [
    {
      id: 'static-contracts',
      npmScripts: ['static:check'],
    },
    {
      id: 'impacted-tests',
      npmScripts: ['test:impacted'],
      shardCount: 4,
      targetDurationMinutes: 5,
    },
  ]);
  const result = spawnSync(process.execPath, ['paper-core/bin/command-surface.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const surface = JSON.parse(result.stdout);
  assert.equal(surface.version, 4);
  assert.deepEqual(surface.blocked, []);
  assert.deepEqual(
    Object.values(surface.groups).flat().sort(),
    Object.keys(scripts).sort(),
  );
  const expectedOperatorScripts = [
    'hepta-paper',
    ...Object.values(HEPTA_PAPER_COMMAND_REGISTRY.operator)
      .map((entry) => entry.npmScript)
      .filter(Boolean),
  ].sort();
  assert.deepEqual(surface.groups.operator, expectedOperatorScripts);
  for (const entry of Object.values(HEPTA_PAPER_COMMAND_REGISTRY.operator)) {
    if (!entry.npmScript) continue;
    assert.equal(scripts[entry.npmScript], entry.argv.join(' '), entry.npmScript);
  }
  for (const name of [
    'check:syntax',
    'reference:integrity',
    'reference:selftest',
    'safety:p0',
    'safety:p1',
    'safety:p2',
    'safety:all',
    'automation:selftest',
    'paper:capability-tests',
    'paper:capability-conformance',
    'paper:governance-contracts',
    'lint',
    'release:state-check',
    'static:check',
  ]) {
    assert.ok(surface.groups.verification.includes(name), name);
  }
  for (const name of ['safety:p0:inner', 'safety:p1:inner', 'safety:p2:inner', 'ci:inner', 'release:inner', 'test:inner']) {
    assert.ok(surface.groups.internal.includes(name), name);
  }
  for (const name of [
    'assets:cold-volume-cas-import',
    'automation:autonomous-research-online-schema-transition',
    'automation:runtime-build',
    'automation:runtime-bootstrap:python',
    'automation:runtime-bootstrap:r',
    'automation:runtime-image-bundle-load',
    'conformance:replay',
    'migration:matrix-refresh-hashes',
    'migration:salvage-verification-receipt',
    'owner:refresh-local-admin',
    'reference:baseline:accept',
    'runtime:hygiene',
    'runtime:permissions',
    'scripts:sync',
    'store:repair-ledger-integrity',
  ]) assert.ok(surface.groups.maintenance.includes(name), name);
  for (const name of surface.groups.maintenance) {
    assert.equal(surface.groups.operator.includes(name), false, name);
    assert.equal(surface.groups.verification.includes(name), false, name);
    assert.equal(surface.groups.retirement.includes(name), false, name);
  }
  assert.deepEqual(surface.groups.compatibility, ['compat:legacy-workflow-projection']);
  assert.ok(surface.groups.operator.includes('paper:submission-handoff'));
  for (const name of ['experimental:real-paper-pilot', 'experimental:taskflow-selftest', 'paper:real-provider-sandbox']) {
    assert.ok(surface.groups.experimental.includes(name), name);
    assert.equal(surface.groups.operator.includes(name), false, name);
    assert.equal(surface.groups.verification.includes(name), false, name);
  }

  const direct = classifyNpmScriptSurface([...Object.keys(scripts), 'future:unregistered-command']);
  assert.ok(direct.groups.internal.includes('future:unregistered-command'));
  assert.deepEqual(direct.blocked, ['future:unregistered-command']);

  const help = spawnSync(process.execPath, ['paper-core/bin/hepta-paper.mjs', '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.deepEqual(JSON.parse(help.stdout), heptaPaperCommandUsage());
  assert.equal(JSON.parse(help.stdout).version, 4);
  assert.deepEqual(HEPTA_PAPER_COMMAND_REGISTRY.retirement.drill.effects, {
    localMutation: 'read-only',
    externalAction: 'none',
    networkUse: 'none',
    credentialUse: 'none',
    providerCost: 'none',
  });
  assert.deepEqual(HEPTA_PAPER_COMMAND_REGISTRY.retirement['drill-attest'].effects, {
    localMutation: 'local-write',
    externalAction: 'none',
    networkUse: 'none',
    credentialUse: 'required',
    providerCost: 'none',
  });
  assert.deepEqual(HEPTA_PAPER_COMMAND_REGISTRY.maintenance['release-attest'].effects, {
    localMutation: 'local-write',
    externalAction: 'none',
    networkUse: 'none',
    credentialUse: 'required',
    providerCost: 'none',
  });
  assert.deepEqual(HEPTA_PAPER_COMMAND_REGISTRY.maintenance['release-integrity-key'].effects, {
    localMutation: 'argument-dependent',
    externalAction: 'none',
    networkUse: 'none',
    credentialUse: 'required',
    providerCost: 'none',
  });
  assert.deepEqual(HEPTA_PAPER_COMMAND_REGISTRY.verify.release.effects, {
    localMutation: 'local-write',
    externalAction: 'none',
    networkUse: 'none',
    credentialUse: 'required',
    providerCost: 'none',
  });
  assert.deepEqual(
    HEPTA_PAPER_COMMAND_REGISTRY.maintenance['autonomous-online-schema-transition'].effects,
    {
      localMutation: 'argument-dependent',
      externalAction: 'argument-dependent',
      networkUse: 'argument-dependent',
      credentialUse: 'argument-dependent',
      providerCost: 'none',
    },
  );
  assert.equal(
    HEPTA_PAPER_COMMAND_REGISTRY.maintenance['autonomous-online-schema-transition']
      .forwardingPolicy,
    'registry',
  );
  assert.equal(JSON.parse(help.stdout).commands.operator['research-readiness'].effects.externalAction, 'required');
  assert.ok(HEPTA_PAPER_COMMAND_REGISTRY.operator['submission-handoff']);
  assert.deepEqual(HEPTA_PAPER_COMMAND_REGISTRY.operator['research-readiness'].effects, {
    localMutation: 'read-only',
    externalAction: 'required',
    networkUse: 'required',
    credentialUse: 'required',
    providerCost: 'possible',
  });
  for (const command of ['campaign', 'batch']) {
    assert.equal(HEPTA_PAPER_COMMAND_REGISTRY.operator[command].effects.externalAction, 'argument-dependent');
    assert.equal(HEPTA_PAPER_COMMAND_REGISTRY.operator[command].effects.providerCost, 'argument-dependent');
  }
  assert.deepEqual(HEPTA_PAPER_COMMAND_REGISTRY.operator['autonomous-research'].effects, {
    localMutation: 'argument-dependent',
    externalAction: 'argument-dependent',
    networkUse: 'argument-dependent',
    credentialUse: 'argument-dependent',
    providerCost: 'argument-dependent',
  });
  assert.ok(HEPTA_PAPER_COMMAND_REGISTRY.operator['autonomous-research']
    .forwardedArgumentSchema.valueFlags.includes('external-qualification-config'));
  const autonomousValueFlags = HEPTA_PAPER_COMMAND_REGISTRY.operator['autonomous-research']
    .forwardedArgumentSchema.valueFlags;
  assert.equal(autonomousValueFlags.includes('agent-provider'), true);
  assert.equal(autonomousValueFlags.includes('formal-review-provider'), true);
  assert.equal(autonomousValueFlags.includes('launch-mode'), true);
  assert.equal(autonomousValueFlags.includes('openclaw-agent'), false);
  assert.equal(autonomousValueFlags.includes('ollama-model'), false);
  const autonomousBooleanFlags = HEPTA_PAPER_COMMAND_REGISTRY
    .operator['autonomous-research'].forwardedArgumentSchema.booleanFlags;
  assert.equal(autonomousBooleanFlags.includes('unlimited-tokens'), true);
  assert.equal(autonomousBooleanFlags.includes('unlimited-cost'), true);
  assert.equal(HEPTA_PAPER_COMMAND_REGISTRY.operator['autonomous-supervisor']
    .forwardedArgumentSchema.valueFlags.includes('topic-producer-profile'), true);
  assert.equal(HEPTA_PAPER_COMMAND_REGISTRY.operator['autonomous-supervisor-health']
    .forwardedArgumentSchema.booleanFlags.includes('require-current-machine-intake'), true);
  assert.deepEqual(
    HEPTA_PAPER_COMMAND_REGISTRY.operator['autonomous-intake-authority-rotation'].effects,
    {
      localMutation: 'argument-dependent',
      externalAction: 'none',
      networkUse: 'none',
      credentialUse: 'none',
      providerCost: 'none',
    },
  );
  assert.equal(HEPTA_PAPER_COMMAND_REGISTRY.operator['autonomous-intake-authority-rotation']
    .forwardedArgumentSchema.booleanFlags.includes('execute'), true);
  assert.equal(HEPTA_PAPER_COMMAND_REGISTRY.operator['autonomous-intake-authority-rotation']
    .forwardedArgumentSchema.valueFlags.includes('plan-hash'), true);
  assert.deepEqual(HEPTA_PAPER_COMMAND_REGISTRY.operator.automation.effects, {
    localMutation: 'read-only',
    externalAction: 'argument-dependent',
    networkUse: 'argument-dependent',
    credentialUse: 'argument-dependent',
    providerCost: 'none',
  });
  assert.equal(HEPTA_PAPER_COMMAND_REGISTRY.operator.automation.forwardingPolicy, 'registry');
  assert.deepEqual(
    HEPTA_PAPER_COMMAND_REGISTRY.operator.automation.forwardedArgumentSchema.valueFlags,
    ['deployment-environment-file', 'root', 'runtime-root'],
  );
  assert.equal(
    HEPTA_PAPER_COMMAND_REGISTRY.operator.automation.forwardedArgumentSchema.booleanFlags
      .includes('require-fully-autonomous'),
    true,
  );
  assert.equal(
    HEPTA_PAPER_COMMAND_REGISTRY.operator.automation.forwardedArgumentSchema.booleanFlags
      .includes('handoff'),
    true,
  );
  assert.equal(
    HEPTA_PAPER_COMMAND_REGISTRY.operator.automation.forwardedArgumentSchema.booleanFlags
      .includes('json'),
    true,
  );
  assert.deepEqual(
    HEPTA_PAPER_COMMAND_REGISTRY.operator['external-authority-intake'].effects,
    {
      localMutation: 'read-only',
      externalAction: 'none',
      networkUse: 'none',
      credentialUse: 'none',
      providerCost: 'none',
    },
  );
  assert.deepEqual(
    HEPTA_PAPER_COMMAND_REGISTRY.operator['external-authority-intake']
      .forwardedArgumentSchema.booleanFlags,
    ['help', 'require-ready'],
  );
  assert.deepEqual(
    HEPTA_PAPER_COMMAND_REGISTRY.operator['generic-domain-capability-evidence']
      .forwardedArgumentSchema.valueFlags,
    ['action', 'paper-id', 'root', 'runtime-root'],
  );
  assert.deepEqual(HEPTA_PAPER_COMMAND_REGISTRY.operator.batch.unsupportedModes, [
    'journal-manage',
    'venue-resolve',
    'source-adapt',
  ]);
});

test('retirement matrix command runs the isolated capability preflight before the release matrix', { timeout: 120_000 }, () => {
  const route = HEPTA_PAPER_COMMAND_REGISTRY.retirement.matrix;
  assert.deepEqual(route.argv, ['npm', 'run', 'migration:capability-matrix-v3']);
  assert.match(scripts[route.npmScript], /^node paper-core\/bin\/run-isolated-command\.mjs /);
  assert.match(
    scripts[route.npmScript],
    /node migration\/bin\/verify-capabilities\.mjs && node migration\/tests\/capability-matrix-v3\.mjs --release-profile/,
  );

  const result = spawnSync(process.execPath, [
    'paper-core/bin/hepta-paper.mjs',
    'retirement',
    'matrix',
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const records = jsonLines(result.stdout);
  const verificationIndex = records.findIndex((record) => record.kind === 'CapabilityVerificationManifest');
  const matrixIndex = records.findIndex((record) => record.kind === 'LegacyCapabilityMigrationMatrixV3Test');
  assert.ok(verificationIndex >= 0, result.stdout);
  assert.ok(matrixIndex > verificationIndex, result.stdout);
  assert.equal(records[verificationIndex].status, 'capability_verification_complete');
  assert.equal(records[verificationIndex].passedCount, records[verificationIndex].capabilityCount);
  assert.equal(records[matrixIndex].releaseProfile, true);
  assert.equal(records[matrixIndex].implementationVerified, 40);
});

test('shared strict argument parser rejects unknown, missing, duplicate, and positional input', () => {
  assert.deepEqual(parseStrictCliArguments(['--name=value', '--flag'], {
    booleanFlags: ['flag'],
    valueFlags: ['name'],
    positional: false,
  }), { _: [], name: 'value', flag: true });
  assert.throws(() => parseStrictCliArguments(['--unknown'], { booleanFlags: ['flag'] }), /unknown_cli_option:--unknown/);
  assert.throws(() => parseStrictCliArguments(['--name'], { valueFlags: ['name'] }), /missing_cli_option_value:--name/);
  assert.throws(() => parseStrictCliArguments(['--flag', '--flag'], { booleanFlags: ['flag'] }), /duplicate_cli_option:--flag/);
  assert.throws(() => parseStrictCliArguments(['unexpected'], { positional: false }), /unexpected_cli_positional:unexpected/);

  for (const [command, expected] of [
    [['paper-core/bin/paper-production-core.mjs', 'batch-run', '--unknown'], /unknown_cli_option:--unknown/],
    [['paper-core/bin/paper-production-core.mjs', 'batch-run', '--mode'], /missing_cli_option_value:--mode/],
    [['paper-core/bin/paper-campaign.mjs', '--unknown'], /unknown_cli_option:--unknown/],
    [['paper-core/bin/paper-campaign.mjs', '--action'], /missing_cli_option_value:--action/],
  ]) {
    const result = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0, command.join(' '));
    assert.match(result.stderr, expected, command.join(' '));
  }

  const missingSeparator = spawnSync(process.execPath, [
    'paper-core/bin/hepta-paper.mjs',
    'operator',
    'batch',
    '--help',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(missingSeparator.status, 2);
  assert.match(missingSeparator.stderr, /command_arguments_require_separator/);

  const noArgumentsRoute = spawnSync(process.execPath, [
    'paper-core/bin/hepta-paper.mjs',
    'retirement',
    'reference',
    '--',
    '--unknown',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(noArgumentsRoute.status, 2);
  assert.match(noArgumentsRoute.stderr, /command_does_not_accept_arguments/);

  const reconcileRoute = spawnSync(process.execPath, [
    'paper-core/bin/hepta-paper.mjs',
    'operator',
    'reconcile',
    '--',
    '--unknown',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(reconcileRoute.status, 2);
  assert.match(reconcileRoute.stderr, /unknown_cli_option:--unknown/);

  const registryValidatedRoute = spawnSync(process.execPath, [
    'paper-core/bin/hepta-paper.mjs',
    'operator',
    'workspace',
    '--',
    '--unknown',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(registryValidatedRoute.status, 2);
  assert.match(registryValidatedRoute.stderr, /unknown_cli_option:--unknown/);

  const automationRoute = spawnSync(process.execPath, [
    'paper-core/bin/hepta-paper.mjs',
    'operator',
    'automation',
    '--',
    '--root',
    '/tmp/hepta-assets',
    '--runtime-root',
    '/tmp/hepta-runtime',
    '--require-fully-autonomous',
    '--help',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(automationRoute.status, 0, automationRoute.stderr);
  assert.match(automationRoute.stdout, /AutomationStatusUsage/);

  const genericEvidenceRoute = spawnSync(process.execPath, [
    'paper-core/bin/hepta-paper.mjs',
    'operator',
    'generic-domain-capability-evidence',
    '--',
    '--action',
    'status',
    '--paper-id',
    'strict-route-paper',
    '--help',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(genericEvidenceRoute.status, 0, genericEvidenceRoute.stderr);
  assert.match(genericEvidenceRoute.stdout, /generic-domain-capability-evidence/);

  for (const argv of [
    ['paper-core/bin/automation-status.mjs', '--require-fully-autonomus'],
    ['paper-core/bin/hepta-paper.mjs', 'operator', 'automation', '--', '--require-fully-autonomus'],
  ]) {
    const result = spawnSync(process.execPath, argv, { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0, argv.join(' '));
    assert.match(result.stderr, /unknown_cli_option:--require-fully-autonomus/);
  }

  const autonomousRoute = spawnSync(process.execPath, [
    'paper-core/bin/hepta-paper.mjs',
    'operator',
    'autonomous-research',
    '--',
    '--action',
    'prepare',
    '--launch-mode',
    'golden-bootstrap',
    '--help',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(autonomousRoute.status, 0, autonomousRoute.stderr);
  const autonomousUsage = JSON.parse(autonomousRoute.stdout);
  assert.equal(autonomousUsage.kind, 'AutonomousResearchCampaignUsage');
  assert.equal(autonomousUsage.defaultLaunchMode, 'local-run');
  assert.match(autonomousUsage.launchModes['local-run'], /local-only mode/);
  assert.match(autonomousUsage.launchModes['local-run'], /does not require external identity/);
  assert.match(autonomousUsage.behavior.status, /without local mutation/);
  assert.match(autonomousUsage.behavior.status, /validates cached qualification state locally/);
  assert.match(autonomousUsage.behavior.converge, /idempotently prepares or continues/);
  assert.match(autonomousUsage.behavior.converge, /explicit budget flags/);
  assert.match(autonomousUsage.externalQualification.cachePolicy, /same release while unexpired/);
  assert.match(autonomousUsage.externalQualification.convergeRetryPolicy, /fails closed/);
  assert.equal(autonomousUsage.providerConfiguration.supportedProvider, 'codex');
  assert.match(autonomousUsage.providerConfiguration.researchAuthor, /auto\|codex/);
  assert.match(autonomousUsage.providerConfiguration.formalReviewer, /auto\|codex/);
  assert.equal(autonomousUsage.providerConfiguration.unsupportedProvidersFailClosed, true);
  assert.equal(autonomousUsage.safety.automaticBudgetExpansionEnabled, false);

  const autonomousQualificationConfigRoute = spawnSync(process.execPath, [
    'paper-core/bin/hepta-paper.mjs',
    'operator',
    'autonomous-research',
    '--',
    '--external-qualification-config',
    path.join(root, 'external-qualification-help-contract.json'),
    '--qualification-maximum-attempts',
    '2',
    '--qualification-global-deadline-ms',
    '5000',
    '--help',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(
    autonomousQualificationConfigRoute.status,
    0,
    autonomousQualificationConfigRoute.stderr,
  );
  assert.equal(
    JSON.parse(autonomousQualificationConfigRoute.stdout).kind,
    'AutonomousResearchCampaignUsage',
  );

  const invalidAutonomousRoute = spawnSync(process.execPath, [
    'paper-core/bin/hepta-paper.mjs',
    'operator',
    'autonomous-research',
    '--',
    '--unknown',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(invalidAutonomousRoute.status, 2);
  assert.match(invalidAutonomousRoute.stderr, /unknown_cli_option:--unknown/);
});

test('autonomous CLI rejects removed backend flags and unsupported providers', () => {
  for (const flag of ['--openclaw-agent', '--ollama-model']) {
    const direct = spawnSync(process.execPath, [
      'paper-core/bin/autonomous-research-readiness.mjs',
      flag,
      'removed-backend-value',
      '--help',
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(direct.status, 0, flag);
    assert.match(direct.stderr, new RegExp(`unknown_cli_option:${flag}`), flag);

    const routed = spawnSync(process.execPath, [
      'paper-core/bin/hepta-paper.mjs',
      'operator',
      'autonomous-research',
      '--',
      flag,
      'removed-backend-value',
      '--help',
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(routed.status, 2, flag);
    assert.match(routed.stderr, new RegExp(`unknown_cli_option:${flag}`), flag);
  }

  for (const [flag, provider, expectedError] of [
    ['--agent-provider', 'openclaw', 'autonomous_research_research_author_provider_unsupported:openclaw'],
    ['--agent-provider', 'ollama', 'autonomous_research_research_author_provider_unsupported:ollama'],
    ['--formal-review-provider', 'openclaw', 'autonomous_research_formal_reviewer_provider_unsupported:openclaw'],
    ['--formal-review-provider', 'ollama', 'autonomous_research_formal_reviewer_provider_unsupported:ollama'],
  ]) {
    const result = spawnSync(process.execPath, [
      'paper-core/bin/autonomous-research-readiness.mjs',
      '--action',
      'prepare',
      '--paper-id',
      `unsupported-${provider}`,
      flag,
      provider,
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0, `${flag}=${provider}`);
    assert.match(result.stderr, new RegExp(expectedError), `${flag}=${provider}`);
  }

  for (const provider of ['auto', 'codex']) {
    const accepted = spawnSync(process.execPath, [
      'paper-core/bin/hepta-paper.mjs',
      'operator',
      'autonomous-research',
      '--',
      '--agent-provider',
      provider,
      '--formal-review-provider',
      provider,
      '--help',
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).providerConfiguration.supportedProvider, 'codex');
  }
});

test('autonomous research status forwards external qualification configuration', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-autonomous-status-route-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const assetRoot = path.join(base, 'assets');
  const runtimeRoot = path.join(base, 'runtime');
  fs.mkdirSync(assetRoot, { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  createDefaultPaperStore({ root: assetRoot, runtimeRoot }).close();
  const configPath = path.join(base, 'qualification.json');
  fs.writeFileSync(configPath, '{"version":0}\n', { mode: 0o600 });
  const result = spawnSync(process.execPath, [
    'paper-core/bin/hepta-paper.mjs',
    'operator',
    'autonomous-research',
    '--',
    '--action',
    'status',
    '--campaign-id',
    'missing-campaign',
    '--launch-mode',
    'production-run',
    '--root',
    assetRoot,
    '--runtime-root',
    runtimeRoot,
    '--external-qualification-config',
    configPath,
  ], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /external_qualification_configuration_invalid/);
});

test('production batch CLI rejects the compatibility projection flag', () => {
  const result = spawnSync(process.execPath, [
    'paper-core/bin/paper-production-core.mjs',
    'batch-run',
    '--legacy-workflow-projection',
  ], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /legacy_workflow_projection_removed_use_compat_script/);

  const compatibilityHelp = spawnSync(process.execPath, [
    'paper-core/bin/paper-compat-workflow-projection.mjs',
    '--help',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(compatibilityHelp.status, 0, compatibilityHelp.stderr);
  assert.match(compatibilityHelp.stdout, /not part of\s+the supported production operator graph/);
});
