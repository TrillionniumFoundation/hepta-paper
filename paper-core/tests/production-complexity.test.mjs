import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectProductionComplexity } from '../verification/production-complexity.mjs';

function fixtureGraph(modules, {
  blockers = undefined,
  manifest = {},
} = {}) {
  return Object.freeze({
    productionGraphManifestHash: `sha256:${'a'.repeat(64)}`,
    ...(blockers === undefined ? {} : {
      status: blockers.length
        ? 'tracked_production_graph_blocked'
        : 'tracked_production_graph_ready',
      blockers: Object.freeze(blockers),
    }),
    manifest: Object.freeze({
      version: 1,
      kind: 'ProductionReachabilityManifest',
      moduleCount: modules.length,
      modules: Object.freeze(modules),
      ...manifest,
    }),
  });
}

function writeModule(root, relative, source) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, source);
}

test('production complexity rejects synthetic oversized and high-fanout modules', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-production-complexity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative = 'paper-domain/research/synthetic-registry.mjs';
  const dependencies = Array.from(
    { length: 25 },
    (_, index) => `paper-domain/research/dependency-${index}.mjs`,
  );
  const source = [
    ...dependencies.map((dependency) => `import './${path.basename(dependency)}';`),
    ...Array.from({ length: 776 }, (_, index) => `const value${index} = ${index};`),
    'export const result = value0;',
    '',
  ].join('\n');
  writeModule(root, relative, source);

  const report = inspectProductionComplexity({
    workspaceRoot: root,
    graphReport: fixtureGraph([{ path: relative, dependencies }]),
  });

  assert.equal(report.status, 'production_complexity_blocked');
  assert.deepEqual(report.blockers, [
    'production_complexity_dependency_fanout_exceeded',
    'production_complexity_source_lines_exceeded',
  ]);
  assert.deepEqual(
    report.violations.map(({ metric, actual, maximum }) => ({ metric, actual, maximum })),
    [
      { metric: 'sourceLines', actual: 802, maximum: 800 },
      { metric: 'dependencyFanout', actual: 25, maximum: 24 },
    ],
  );
  assert.equal(report.rows[0].excluded, false);
  assert.equal(report.rows[0].layer, 'domain');
});

test('payload waivers apply only to the declared path rule', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-production-complexity-payload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative = 'paper-domain/journal/data/journal-profiles.v1.data.mjs';
  writeModule(root, relative, `${'export const payload = Object.freeze([]);\n'.repeat(1_000)}`);

  const report = inspectProductionComplexity({
    workspaceRoot: root,
    graphReport: fixtureGraph([{ path: relative, dependencies: [] }]),
  });

  assert.equal(report.status, 'production_complexity_ready');
  assert.equal(report.moduleCount, 1);
  assert.equal(report.inspectedModuleCount, 0);
  assert.equal(report.excludedModuleCount, 1);
  assert.equal(report.rows[0].exclusion, 'versioned-journal-profile-dataset');
});

test('payload-like executable modules outside the exact allowlist stay inspected', (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-production-complexity-payload-denied-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative = 'paper-domain/journal/data/generated.data.mjs';
  writeModule(root, relative, `${Array.from(
    { length: 1_000 },
    (_, index) => `const payload${index} = ${index};`,
  ).join('\n')}\n`);

  const report = inspectProductionComplexity({
    workspaceRoot: root,
    graphReport: fixtureGraph([{ path: relative, dependencies: [] }]),
  });

  assert.equal(report.status, 'production_complexity_blocked');
  assert.equal(report.excludedModuleCount, 0);
  assert.ok(report.blockers.includes('production_complexity_source_lines_exceeded'));
});

test('control-flow and export metrics come from syntax rather than source text fragments', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-production-complexity-syntax-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative = 'paper-application/research/syntax-metrics.mjs';
  writeModule(root, relative, [
    '// if (commentOnly) export const phantom = true;',
    'const text = \"while (stringOnly) export default false\";',
    'export const result = text && (text ? 1 : 0);',
    '',
  ].join('\n'));

  const report = inspectProductionComplexity({
    workspaceRoot: root,
    graphReport: fixtureGraph([{ path: relative, dependencies: [] }]),
  });

  assert.equal(report.status, 'production_complexity_ready');
  assert.equal(report.rows[0].metrics.publicExports, 1);
  assert.equal(report.rows[0].metrics.controlFlowPoints, 2);
});

test('structurally blocked and empty production graphs fail closed', () => {
  const report = inspectProductionComplexity({
    graphReport: fixtureGraph([], {
      blockers: ['production_graph_entrypoints_missing'],
    }),
  });

  assert.equal(report.status, 'production_complexity_blocked');
  assert.ok(report.blockers.includes('production_graph_entrypoints_missing'));
  assert.ok(report.blockers.includes('production_complexity_graph_manifest_empty'));
});

test('invalid dependency rows and manifest identities fail closed', (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-production-complexity-invalid-graph-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative = 'paper-domain/research/invalid-dependencies.mjs';
  writeModule(root, relative, 'export const value = 1;\n');

  const dependenciesReport = inspectProductionComplexity({
    workspaceRoot: root,
    graphReport: fixtureGraph([{ path: relative, dependencies: 'not-an-array' }]),
  });
  assert.equal(dependenciesReport.status, 'production_complexity_blocked');
  assert.ok(dependenciesReport.blockers.includes(
    'production_complexity_graph_module_dependencies_invalid',
  ));

  for (const manifest of [
    { version: 2 },
    { kind: 'WrongManifestKind' },
    { moduleCount: 2 },
  ]) {
    const report = inspectProductionComplexity({
      workspaceRoot: root,
      graphReport: fixtureGraph([{ path: relative, dependencies: [] }], { manifest }),
    });
    assert.equal(report.status, 'production_complexity_blocked');
    assert.deepEqual(report.blockers, ['production_complexity_graph_manifest_invalid']);
  }
});

test('critical facade path ceilings remain tighter than layer-wide budgets', (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-production-complexity-path-override-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative = 'paper-adapters/empirical-analysis/index.mjs';
  writeModule(root, relative, `${Array.from(
    { length: 401 },
    (_, index) => `const value${index} = ${index};`,
  ).join('\n')}\n`);

  const report = inspectProductionComplexity({
    workspaceRoot: root,
    graphReport: fixtureGraph([{ path: relative, dependencies: [] }]),
  });

  assert.equal(report.status, 'production_complexity_blocked');
  const sourceViolation = report.violations.find(
    (violation) => violation.metric === 'sourceLines',
  );
  assert.deepEqual(
    {
      actual: sourceViolation.actual,
      maximum: sourceViolation.maximum,
    },
    { actual: 401, maximum: 400 },
  );
});

test('legacy high-risk paths retain their fanout and control-flow ceilings', (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-production-complexity-high-risk-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative =
    'paper-adapters/automation/workspace-attempt-manifest.mjs';
  const dependencies = Array.from(
    { length: 17 },
    (_, index) => `paper-adapters/automation/dependency-${index}.mjs`,
  );
  writeModule(root, relative, [
    ...dependencies.map(
      (dependency) => `import './${path.basename(dependency)}';`,
    ),
    ...Array.from(
      { length: 221 },
      (_, index) => `const branch${index} = true ? ${index} : 0;`,
    ),
    '',
  ].join('\n'));

  const report = inspectProductionComplexity({
    workspaceRoot: root,
    graphReport: fixtureGraph([{ path: relative, dependencies }]),
  });

  assert.equal(report.status, 'production_complexity_blocked');
  assert.deepEqual(
    report.violations.map(({ metric, actual, maximum }) => ({
      metric,
      actual,
      maximum,
    })),
    [
      { metric: 'dependencyFanout', actual: 17, maximum: 16 },
      { metric: 'controlFlowPoints', actual: 221, maximum: 220 },
    ],
  );
});
