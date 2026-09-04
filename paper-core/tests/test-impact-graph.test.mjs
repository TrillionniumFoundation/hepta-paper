import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  buildTestImpactGraph,
  selectImpactedTests,
  shardImpactedTests,
} from '../src/test-impact-graph.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const repositoryControlPlaneFiles = Object.freeze({
  codeowners: new URL('../../.github/CODEOWNERS', import.meta.url),
  continuousIntegration: new URL('../../.github/workflows/ci.yml', import.meta.url),
  gitignore: new URL('../../.gitignore', import.meta.url),
  runnerGroups: new URL('../../.github/runner-groups.yml', import.meta.url),
});

function fixtureGraph() {
  const sources = {
    'paper-domain/claim.mjs': 'export const claim = true;\n',
    'paper-application/use-claim.mjs':
      "import { claim } from '../paper-domain/claim.mjs';\nexport { claim };\n",
    'paper-domain/other.mjs': 'export const other = true;\n',
    'paper-domain/unmapped.mjs': 'export const unmapped = true;\n',
    'paper-core/tests/claim.test.mjs':
      "import '../../paper-application/use-claim.mjs';\n",
    'paper-core/tests/other.test.mjs': [
      "import '../../paper-domain/other.mjs';",
      "const currentStatus = '../docs/CURRENT_STATUS.md';",
      '',
    ].join('\n'),
    'paper-core/tests/spawn.test.mjs':
      "const executable = 'paper-core/bin/tool.mjs';\n",
    'paper-core/tests/repository-control-plane.test.mjs': [
      "const codeowners = '../../.github/CODEOWNERS';",
      "const ci = '../../.github/workflows/ci.yml';",
      "const gitignore = '../../.gitignore';",
      "const runnerGroups = '../../.github/runner-groups.yml';",
      '',
    ].join('\n'),
    'migration/tests/legacy-matrix-reference-publication.test.mjs': [
      "const workflow = '../../.github/workflows/legacy-matrix-reference-verification.yml';",
      "const verifier = '../bin/verify-legacy-matrix-reference-publication.mjs';",
      "const pointer = '../fixtures/legacy-matrix-reference-publication-v1.json';",
      '',
    ].join('\n'),
    'paper-core/bin/tool.mjs': 'process.stdout.write("ok");\n',
    'rust/oracle/legacy-stable-json-v1.mjs': 'process.stdout.write("rust-oracle");\n',
  };
  return buildTestImpactGraph({
    files: [
      ...Object.keys(sources),
      'paper-core/config/policy.json',
      'paper-core/docs/CURRENT_STATUS.md',
      'README.md',
      '.github/CODEOWNERS',
      '.github/actionlint.yaml',
      '.github/runner-groups.yml',
      '.github/workflows/ci.yml',
      '.github/workflows/legacy-matrix-reference-verification.yml',
      '.github/workflows/workflow-lint.yml',
      '.gitignore',
      'migration/bin/verify-legacy-matrix-reference-publication.mjs',
      'migration/fixtures/legacy-matrix-reference-publication-v1.json',
      'docs/rust/RUST_PLAN.md',
      'docs/rust/current-status.v1.json',
      'docs/rust/tools/validate-program-truth.py',
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
    '.github/workflows/unclassified.yml',
    'package.json',
    'paper-core/config/policy.json',
    'paper-domain/unmapped.mjs',
  ]) {
    const selection = selectImpactedTests({ graph, changedFiles: [changedFile] });
    assert.equal(selection.status, 'test_impact_selection_full_fallback', changedFile);
    assert.deepEqual(selection.selectedTests, graph.tests, changedFile);
    assert.ok(selection.fallbackFiles.includes(changedFile), changedFile);
  }
  for (const changedFile of ['README.md', 'paper-core/docs/CURRENT_STATUS.md']) {
    const documentation = selectImpactedTests({
      graph,
      changedFiles: [changedFile],
    });
    assert.equal(
      documentation.status,
      'test_impact_selection_no_tests_required',
      changedFile,
    );
    assert.deepEqual(documentation.selectedTests, [], changedFile);
    assert.deepEqual(documentation.fallbackFiles, [], changedFile);
  }

  for (const changedFile of [
    'docs/system/truth/program.v2.json',
    'docs/modules/schemas/module-manifest-v1.schema.json',
    'paper-core/docs/history/architecture-p1p2-review-groups-2026-07-14.json',
  ]) {
    const documentationArtifact = selectImpactedTests({
      graph,
      changedFiles: [changedFile],
    });
    assert.equal(
      documentationArtifact.status,
      'test_impact_selection_no_tests_required',
      changedFile,
    );
    assert.deepEqual(documentationArtifact.selectedTests, [], changedFile);
    assert.deepEqual(documentationArtifact.fallbackFiles, [], changedFile);
  }

  for (const changedFile of [
    '.github/actionlint.yaml',
    '.github/workflows/rust-foundation.yml',
    '.github/workflows/rust-broker-installed-qualification-v2.yml',
    '.github/workflows/exact-head-source-validation.yml',
    '.github/workflows/workflow-lint.yml',
    'docs/rust/RUST_PLAN.md',
    'docs/rust/current-status.v1.json',
    'docs/rust/tools/validate-program-truth.py',
    'docs/rust/qualification/hepta-broker-host-qualification.sh',
    'docs/rust/qualification/hepta-broker-qualification-evidence-v1.schema.json',
    'rust/Cargo.toml',
    'rust/crates/example/src/lib.rs',
    'rust/oracle/legacy-stable-json-v1.mjs',
  ]) {
    const isolated = selectImpactedTests({ graph, changedFiles: [changedFile] });
    assert.equal(isolated.status, 'test_impact_selection_no_tests_required', changedFile);
    assert.deepEqual(isolated.selectedTests, [], changedFile);
    assert.deepEqual(isolated.fallbackFiles, [], changedFile);
  }
});

test('the development-documentation validator is narrow only when contract-tested', () => {
  const mapped = buildTestImpactGraph({
    files: [
      'docs/tools/validate-development-docs.mjs',
      'paper-core/tests/development-documentation-governance.test.mjs',
    ],
    readSource(file) {
      if (file === 'paper-core/tests/development-documentation-governance.test.mjs') {
        return "const validator = '../../docs/tools/validate-development-docs.mjs';\n";
      }
      return '';
    },
  });
  const selection = selectImpactedTests({
    graph: mapped,
    changedFiles: ['docs/tools/validate-development-docs.mjs'],
  });
  assert.equal(selection.status, 'test_impact_selection_ready');
  assert.deepEqual(selection.fallbackFiles, []);
  assert.deepEqual(selection.selectedTests, [
    'paper-core/tests/development-documentation-governance.test.mjs',
  ]);

  const unmapped = buildTestImpactGraph({
    files: [
      'docs/tools/validate-development-docs.mjs',
      'paper-core/tests/other.test.mjs',
    ],
    readSource: () => '',
  });
  const fallback = selectImpactedTests({
    graph: unmapped,
    changedFiles: ['docs/tools/validate-development-docs.mjs'],
  });
  assert.equal(fallback.status, 'test_impact_selection_full_fallback');
  assert.deepEqual(fallback.fallbackFiles, [
    'docs/tools/validate-development-docs.mjs',
  ]);
  assert.deepEqual(fallback.selectedTests, ['paper-core/tests/other.test.mjs']);
});

test('mixed current documentation and CODEOWNERS changes remain narrowly contract-tested', () => {
  const graph = fixtureGraph();
  const selection = selectImpactedTests({
    graph,
    changedFiles: [
      '.github/CODEOWNERS',
      'README.md',
      'docs/system/truth/program.v2.json',
      'docs/modules/schemas/module-manifest-v1.schema.json',
      'paper-core/docs/history/architecture-p1p2-review-groups-2026-07-14.json',
    ],
  });
  assert.equal(selection.status, 'test_impact_selection_ready');
  assert.equal(selection.fullFallback, false);
  assert.deepEqual(selection.fallbackFiles, []);
  assert.deepEqual(
    selection.selectedTests,
    ['paper-core/tests/repository-control-plane.test.mjs'],
  );
});

test('repository control-plane changes are narrow only when contract-tested', () => {
  const graph = fixtureGraph();
  for (const changedFile of [
    '.github/CODEOWNERS',
    '.github/runner-groups.yml',
    '.github/workflows/ci.yml',
    '.gitignore',
  ]) {
    const selection = selectImpactedTests({ graph, changedFiles: [changedFile] });
    assert.equal(selection.status, 'test_impact_selection_ready', changedFile);
    assert.equal(selection.fullFallback, false, changedFile);
    assert.deepEqual(selection.fallbackFiles, [], changedFile);
    assert.deepEqual(
      selection.selectedTests,
      ['paper-core/tests/repository-control-plane.test.mjs'],
      changedFile,
    );
  }

  const unmapped = buildTestImpactGraph({
    files: [
      '.github/CODEOWNERS',
      'paper-core/tests/other.test.mjs',
    ],
    readSource: () => '',
  });
  const selection = selectImpactedTests({
    graph: unmapped,
    changedFiles: ['.github/CODEOWNERS'],
  });
  assert.equal(selection.status, 'test_impact_selection_full_fallback');
  assert.deepEqual(selection.fallbackFiles, ['.github/CODEOWNERS']);
  assert.deepEqual(selection.selectedTests, unmapped.tests);
});

test('legacy matrix publication control surfaces are narrow only when contract-tested', () => {
  const graph = fixtureGraph();
  for (const changedFile of [
    '.github/workflows/legacy-matrix-reference-verification.yml',
    'migration/bin/verify-legacy-matrix-reference-publication.mjs',
    'migration/fixtures/legacy-matrix-reference-publication-v1.json',
  ]) {
    const selection = selectImpactedTests({ graph, changedFiles: [changedFile] });
    assert.equal(selection.status, 'test_impact_selection_ready', changedFile);
    assert.equal(selection.fullFallback, false, changedFile);
    assert.deepEqual(selection.fallbackFiles, [], changedFile);
    assert.deepEqual(
      selection.selectedTests,
      ['migration/tests/legacy-matrix-reference-publication.test.mjs'],
      changedFile,
    );
  }

  const unmapped = buildTestImpactGraph({
    files: [
      '.github/workflows/legacy-matrix-reference-verification.yml',
      'paper-core/tests/other.test.mjs',
    ],
    readSource: () => '',
  });
  const selection = selectImpactedTests({
    graph: unmapped,
    changedFiles: ['.github/workflows/legacy-matrix-reference-verification.yml'],
  });
  assert.equal(selection.status, 'test_impact_selection_full_fallback');
  assert.deepEqual(
    selection.fallbackFiles,
    ['.github/workflows/legacy-matrix-reference-verification.yml'],
  );
  assert.deepEqual(selection.selectedTests, unmapped.tests);
});

test('checked-in repository control-plane contracts remain fail-closed', () => {
  const codeowners = fs.readFileSync(repositoryControlPlaneFiles.codeowners, 'utf8');
  for (const rule of [
    '/.github/ @ProfHepta',
    '/rust/ @ProfHepta',
    '/paper-adapters/ @ProfHepta',
    '/migration/ @ProfHepta',
    '/store/migrations/ @ProfHepta',
  ]) {
    assert.ok(codeowners.split('\n').includes(rule), rule);
  }
  assert.doesNotMatch(codeowners, /@TrillionniumFoundation(?:\s|$)/u);

  const continuousIntegration = fs.readFileSync(
    repositoryControlPlaneFiles.continuousIntegration,
    'utf8',
  );
  assert.match(continuousIntegration, /^name: hepta-paper-ci$/mu);
  assert.match(continuousIntegration, /^  pull_request:$/mu);
  assert.match(continuousIntegration, /npm run test:impacted --/u);
  assert.match(
    continuousIntegration,
    /npm run static:check && npm run security:npm-audit/u,
  );
  assert.doesNotMatch(continuousIntegration, /\bpull_request_target\s*:/u);
  assert.doesNotMatch(continuousIntegration, /\bcontinue-on-error\s*:\s*true\b/u);

  const gitignore = fs.readFileSync(repositoryControlPlaneFiles.gitignore, 'utf8');
  assert.ok(gitignore.split('\n').includes('/rust/target/'));
  assert.ok(gitignore.split('\n').includes('/runtime/'));

  const runnerGroups = fs.readFileSync(repositoryControlPlaneFiles.runnerGroups, 'utf8');
  assert.deepEqual(runnerGroups.trimEnd().split('\n'), [
    'self-hosted-runner:',
    '  labels:',
    '    - nvidia-gpu',
    '    - nvidia-gpu-protected',
  ]);
});

test('mixed Rust governance and mapped JavaScript changes run only mapped tests', () => {
  const graph = fixtureGraph();
  const selection = selectImpactedTests({
    graph,
    changedFiles: [
      '.github/actionlint.yaml',
      'docs/rust/current-status.v1.json',
      'rust/oracle/legacy-stable-json-v1.mjs',
      'paper-domain/claim.mjs',
    ],
  });
  assert.equal(selection.status, 'test_impact_selection_ready');
  assert.equal(selection.fullFallback, false);
  assert.deepEqual(selection.fallbackFiles, []);
  assert.deepEqual(selection.selectedTests, ['paper-core/tests/claim.test.mjs']);
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
