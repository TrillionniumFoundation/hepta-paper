import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  buildTestImpactGraph,
  selectImpactedTests,
  shardImpactedTests,
} from '../src/test-impact-graph.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function fixtureGraph() {
  const sources = {
    'paper-domain/claim.mjs': 'export const claim = true;\n',
    'paper-application/use-claim.mjs':
      "import { claim } from '../paper-domain/claim.mjs';\nexport { claim };\n",
    'paper-domain/other.mjs': 'export const other = true;\n',
    'paper-domain/unmapped.mjs': 'export const unmapped = true;\n',
    'paper-core/tests/claim.test.mjs':
      "import '../../paper-application/use-claim.mjs';\n",
    'paper-core/tests/other.test.mjs':
      "import '../../paper-domain/other.mjs';\n",
    'paper-core/tests/spawn.test.mjs':
      "const executable = 'paper-core/bin/tool.mjs';\n",
    'paper-core/bin/tool.mjs': 'process.stdout.write("ok");\n',
  };
  return buildTestImpactGraph({
    files: [
      ...Object.keys(sources),
      'paper-core/config/policy.json',
      'README.md',
      'docs/rust/RUST_PLAN.md',
      'rust/Cargo.toml',
      'rust/crates/example/src/lib.rs',
    ],
    readSource: (file) => sources[file] || '',
  });
}

test('impact graph follows transitive imports and explicit executable references', () => {
  const graph = fixtureGraph();
  const transitive = selectImpactedTests({
    graph,
    changedFiles: ['paper-domain/claim.mjs'],
  });
  assert.equal(transitive.status, 'test_impact_selection_ready');
  assert.deepEqual(transitive.selectedTests, ['paper-core/tests/claim.test.mjs']);

  const executable = selectImpactedTests({
    graph,
    changedFiles: ['paper-core/bin/tool.mjs'],
  });
  assert.equal(executable.fullFallback, false);
  assert.deepEqual(executable.selectedTests, ['paper-core/tests/spawn.test.mjs']);
});

test('impact selection fails safe for global, nonmodule, and unmapped changes', () => {
  const graph = fixtureGraph();
  for (const changedFile of [
    '.github/workflows/ci.yml',
    'package.json',
    'paper-core/config/policy.json',
    'paper-domain/unmapped.mjs',
  ]) {
    const selection = selectImpactedTests({ graph, changedFiles: [changedFile] });
    assert.equal(selection.status, 'test_impact_selection_full_fallback', changedFile);
    assert.deepEqual(selection.selectedTests, graph.tests, changedFile);
    assert.ok(selection.fallbackFiles.includes(changedFile), changedFile);
  }
  const documentation = selectImpactedTests({
    graph,
    changedFiles: ['README.md'],
  });
  assert.equal(documentation.status, 'test_impact_selection_no_tests_required');
  assert.deepEqual(documentation.selectedTests, []);

  for (const changedFile of [
    '.github/workflows/rust-foundation.yml',
    '.github/workflows/rust-broker-installed-qualification-v2.yml',
    '.github/workflows/exact-head-source-validation.yml',
    'docs/rust/RUST_PLAN.md',
    'docs/rust/qualification/hepta-broker-host-qualification.sh',
    'docs/rust/qualification/hepta-broker-qualification-evidence-v1.schema.json',
    'rust/Cargo.toml',
    'rust/crates/example/src/lib.rs',
  ]) {
    const isolated = selectImpactedTests({ graph, changedFiles: [changedFile] });
    assert.equal(isolated.status, 'test_impact_selection_no_tests_required', changedFile);
    assert.deepEqual(isolated.selectedTests, [], changedFile);
    assert.deepEqual(isolated.fallbackFiles, [], changedFile);
  }
});

test('deterministic shards cover each selected test exactly once', () => {
  const tests = Array.from({ length: 41 }, (_, index) => (
    `paper-core/tests/fixture-${String(index).padStart(2, '0')}.test.mjs`
  ));
  const shards = Array.from({ length: 4 }, (_, shardIndex) => (
    shardImpactedTests(tests, { shardCount: 4, shardIndex })
  ));
  assert.deepEqual([...new Set(shards.flat())].sort(), tests);
  assert.equal(shards.flat().length, tests.length);
  assert.deepEqual(
    shardImpactedTests(tests, { shardCount: 4, shardIndex: 2 }),
    shards[2],
  );
  assert.throws(
    () => shardImpactedTests(tests, { shardCount: 9, shardIndex: 0 }),
    /test_impact_shard_configuration_invalid/,
  );
});

test('runner emits a real repository impact plan without executing tests', () => {
  const result = spawnSync(process.execPath, [
    'paper-core/bin/run-impacted-tests.mjs',
    '--changed-file',
    'paper-core/src/test-impact-graph.mjs',
    '--shard-count',
    '4',
    '--shard-index',
    '0',
    '--dry-run',
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.kind, 'ImpactedTestExecutionPlan');
  assert.equal(report.selectionStatus, 'test_impact_selection_ready');
  assert.ok(report.selectedTestCount >= 1);
  assert.ok(report.changedFiles.includes('paper-core/src/test-impact-graph.mjs'));
  assert.equal(report.shardCount, 4);
});
