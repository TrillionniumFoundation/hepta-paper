import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { datasetEnvironmentName, evaluateDatasetConsumptionContract, evaluateEmpiricalResultContract } from '../../paper-domain/automation/empirical-contract.mjs';
import { directoryMerkleHash, sourceTreeExcludedNames } from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';

test('campaign DAG creates independent Python R GPU and LaTeX execution paths', () => {
  const plan = buildPaperCampaignPlan({
    paperId: 'multilingual-paper',
    sourceWorkspace: '/tmp/multilingual-paper',
    campaignId: 'multilingual-campaign',
    languages: ['python', 'r', 'gpu', 'latex'],
    maxRounds: 1,
  });
  const kinds = new Set(plan.nodes.map((node) => node.kind));
  for (const language of ['python', 'r', 'gpu']) {
    assert.equal(kinds.has(`coder-${language}`), true);
    assert.equal(kinds.has(`empirical-${language}`), true);
    assert.equal(kinds.has(`empirical-reproduce-${language}`), true);
    assert.equal(kinds.has(`revalidate-code-${language}`), true);
    assert.equal(kinds.has(`revalidate-empirical-${language}`), true);
  }
  assert.equal(kinds.has('compile'), true);
  const gpu = plan.nodes.find((node) => node.kind === 'empirical-gpu');
  assert.equal(gpu.language, 'python');
  assert.equal(gpu.requiresGpu, true);
  const integrate = plan.nodes.find((node) => node.kind === 'manuscript-integrate');
  assert.deepEqual(integrate.dependencies.filter((dependency) => dependency.includes('empirical-reproduce')).sort(), [
    'multilingual-campaign:0:empirical-reproduce-gpu',
    'multilingual-campaign:0:empirical-reproduce-python',
    'multilingual-campaign:0:empirical-reproduce-r',
  ]);
  for (const language of ['python', 'r', 'gpu']) {
    const code = plan.nodes.find((node) => node.kind === `revalidate-code-${language}`);
    const empirical = plan.nodes.find((node) => node.kind === `revalidate-empirical-${language}`);
    assert.deepEqual(empirical.dependencies, [code.nodeId]);
  }
});

test('dataset contracts require read-only hash and license evidence', () => {
  assert.throws(() => buildPaperCampaignPlan({
    paperId: 'dataset-paper', sourceWorkspace: '/tmp/dataset-paper', datasetMounts: [{ name: 'data', source: '/tmp/data', readOnly: true, manifestHash: `sha256:${'a'.repeat(64)}` }],
  }), /dataset_license_missing/);
  const plan = buildPaperCampaignPlan({
    paperId: 'dataset-paper', sourceWorkspace: '/tmp/dataset-paper', datasetMounts: [{ name: 'data', source: '/tmp/data', readOnly: true, manifestHash: `sha256:${'a'.repeat(64)}`, licenseId: 'CC-BY-4.0' }],
  });
  assert.equal(plan.datasetMounts[0].licenseId, 'CC-BY-4.0');
});

test('dataset consumption contract requires every declared worker mount in the entrypoint', () => {
  const mounts = [
    { name: 'trial data', licenseId: 'CC-BY-4.0' },
    { name: 'holdout', licenseId: 'CC-BY-4.0' },
  ];
  assert.equal(datasetEnvironmentName('trial data'), 'HEPTA_DATASET_TRIAL_DATA');
  const blocked = evaluateDatasetConsumptionContract({ sourceText: 'read.csv(Sys.getenv("HEPTA_DATASET_TRIAL_DATA"))', datasetMounts: mounts });
  assert.deepEqual(blocked.blockers, ['declared_dataset_not_consumed:holdout']);
  const passed = evaluateDatasetConsumptionContract({ sourceText: 'read.csv(Sys.getenv("HEPTA_DATASET_TRIAL_DATA")); open("/datasets/holdout")', datasetMounts: mounts });
  assert.equal(passed.status, 'dataset_consumption_verified');
  assert.equal(passed.blockers.length, 0);
});

test('empirical metric gate compares repeated numeric outputs within tolerance', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-metric-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ accuracy: 0.9, nested: { loss: 0.1 } }));
  const first = evaluateEmpiricalResultContract({ outputDirectory: root, metricSchema: { minimumMetricCount: 2 } });
  assert.equal(first.status, 'empirical_result_schema_verified');
  const consistent = evaluateEmpiricalResultContract({ outputDirectory: root, metricSchema: { minimumMetricCount: 2 }, baselineMetrics: first.metrics });
  assert.equal(consistent.status, 'empirical_reproduction_consistent');
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ accuracy: 0.7, nested: { loss: 0.1 } }));
  const inconsistent = evaluateEmpiricalResultContract({ outputDirectory: root, metricSchema: { minimumMetricCount: 2 }, baselineMetrics: first.metrics });
  assert.ok(inconsistent.blockers.includes('empirical_metric_inconsistent:accuracy'));
});

test('source Merkle excludes a separately hash-bound dataset root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-source-dataset-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataset = path.join(root, 'data');
  fs.mkdirSync(dataset);
  fs.writeFileSync(path.join(root, 'run.py'), 'print(1)\n');
  const virtualenv = path.join(root, '.venv-large');
  fs.mkdirSync(virtualenv);
  fs.writeFileSync(path.join(virtualenv, 'environment.bin'), Buffer.alloc(1024, 1));
  fs.writeFileSync(path.join(dataset, 'large.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
  const before = directoryMerkleHash(root, { excludeRoots: [dataset] });
  fs.writeFileSync(path.join(dataset, 'large.bin'), Buffer.alloc(3 * 1024 * 1024, 2));
  assert.equal(directoryMerkleHash(root, { excludeRoots: [dataset] }), before);
  fs.writeFileSync(path.join(root, 'run.py'), 'print(2)\n');
  assert.notEqual(directoryMerkleHash(root, { excludeRoots: [dataset] }), before);
  const sourceHash = directoryMerkleHash(root, { excludeRoots: [dataset], excludeNames: sourceTreeExcludedNames(root) });
  fs.writeFileSync(path.join(virtualenv, 'environment.bin'), Buffer.alloc(1024, 2));
  assert.equal(directoryMerkleHash(root, { excludeRoots: [dataset], excludeNames: sourceTreeExcludedNames(root) }), sourceHash);
});
