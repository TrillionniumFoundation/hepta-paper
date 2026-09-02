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
    'paper-core/src/test-impact-graph.mjs': 'export const impactGraph = true;\n',
    'paper-core/verification/documentation-integrity.mjs':
      'export const inspectDocumentationIntegrity = () => true;\n',
    'paper-core/tests/claim.test.mjs':
      "import '../../paper-application/use-claim.mjs';\n",
    'paper-core/tests/other.test.mjs':
      "import '../../paper-domain/other.mjs';\n",
    'paper-core/tests/spawn.test.mjs':
      "const executable = 'paper-core/bin/tool.mjs';\n",
    'paper-core/tests/documentation-integrity.test.mjs':
      "import '../verification/documentation-integrity.mjs';\n",
    'paper-core/tests/test-impact-graph.test.mjs':
      "import '../src/test-impact-graph.mjs';\n",
    'paper-core/bin/tool.mjs': 'process.stdout.write(\"ok\");\n',
    '.github/workflows/ci.yml': 'name: fixture-ci\n',
  };
  return buildTestImpactGraph({
    files: [
      ...Object.keys(sources),
      'paper-core/config/policy.json',
      'README.md',
      'docs/architecture/module-map.md',
      'runtime-images/README.md',
      '.github/pull_request_template.md',
      '.github/workflows/documentation-integrity.yml',
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

test('impact selection fails safe for global, nonmodule, unmapped, and workflow drift', () => {
  const graph = fixtureGraph();
  for (const changedFile of [
    'package.json',
    'paper-core/config/policy.json',
    'paper-domain/unmapped.mjs',
    '.github/workflows/ci.yml',
    'paper-core/verification/unmapped-security-check.mjs',
  ]) {
    const selection = selectImpactedTests({ graph, changedFiles: [changedFile] });
    assert.equal(selection.status, 'test_impact_selection_full_fallback', changedFile);
    assert.deepEqual(selection.selectedTests, graph.tests, changedFile);
    assert.ok(selection.fallbackFiles.includes(changedFile), changedFile);
  }
});

test('documentation and integrity-owned paths stay under the dedicated integrity gate', () => {
  const graph = fixtureGraph();
  for (const changedFile of [
    'README.md',
    'docs/architecture/module-map.md',
    'runtime-images/README.md',
    '.github/pull_request_template.md',
    '.github/workflows/documentation-integrity.yml',
    'paper-core/verification/documentation-integrity.mjs',
    'paper-core/src/test-impact-graph.mjs',
    'paper-core/tests/documentation-integrity.test.mjs',
    'paper-core/tests/test-impact-graph.test.mjs',
  ]) {
    const selection = selectImpactedTests({ graph, changedFiles: [changedFile] });
    assert.equal(selection.fullFallback, false, changedFile);
    assert.deepEqual(selection.fallbackFiles, [], changedFile);
    assert.deepEqual(selection.selectedTests, [], changedFile);
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

function runRepositoryPlan(changedFile) {
  const result = spawnSync(process.execPath, [
    'paper-core/bin/run-impacted-tests.mjs',
    '--changed-file',
    changedFile,
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
  return JSON.parse(result.stdout);
}

test('runner delegates its own integrity regression to the dedicated gate', () => {
  const report = runRepositoryPlan('paper-core/src/test-impact-graph.mjs');
  assert.equal(report.kind, 'ImpactedTestExecutionPlan');
  assert.equal(report.selectionStatus, 'test_impact_selection_no_tests_required');
  assert.equal(report.selectedTestCount, 0);
  assert.equal(report.shardTestCount, 0);
  assert.deepEqual(report.fallbackFiles, []);
});

test('only the exact reviewed CI workflow identity avoids global fallback', () => {
  const report = runRepositoryPlan('.github/workflows/ci.yml');
  assert.equal(report.selectionStatus, 'test_impact_selection_no_tests_required');
  assert.equal(report.selectedTestCount, 0);
  assert.equal(report.shardTestCount, 0);
  assert.deepEqual(report.fallbackFiles, []);
});
