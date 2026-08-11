import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import { datasetEnvironmentName, evaluateDatasetConsumptionContract, evaluateEmpiricalResultContract } from '../../paper-adapters/automation/empirical-contract-reader.mjs';
import { directoryMerkleHash, sourceTreeExcludedNames } from '../../paper-adapters/runtime/execution-snapshot.mjs';

test('non-release campaign DAG creates independent Python R GPU and LaTeX execution paths', () => {
  const plan = buildPaperCampaignPlan({
    paperId: 'multilingual-paper',
    sourceWorkspace: '/tmp/multilingual-paper',
    campaignId: 'multilingual-campaign',
    mode: 'local-review-loop',
    languages: ['python', 'r', 'gpu', 'latex'],
    benchmarkId: 'ml_algorithm_benchmark',
    applyManuscript: true,
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
    paperId: 'dataset-paper', sourceWorkspace: '/tmp/dataset-paper', mode: 'empirical-analysis', datasetMounts: [{ name: 'data', source: '/tmp/data', readOnly: true, manifestHash: `sha256:${'a'.repeat(64)}` }],
  }), /dataset_license_missing/);
  assert.throws(() => buildPaperCampaignPlan({
    paperId: 'dataset-paper', sourceWorkspace: '/tmp/dataset-paper', mode: 'empirical-analysis', datasetMounts: [{ name: 'data', source: '/tmp/data', readOnly: true, manifestHash: `sha256:${'a'.repeat(64)}`, licenseId: 'CC-BY-4.0' }],
  }), /campaign_benchmark_dataset_authorization_invalid:data/);
  assert.throws(() => buildPaperCampaignPlan({
    paperId: 'dataset-paper', sourceWorkspace: '/tmp/dataset-paper', mode: 'empirical-analysis', datasetMounts: [{ name: 'data', source: '/tmp/data', readOnly: true, manifestHash: `sha256:${'a'.repeat(64)}`, licenseId: 'looks-authorized' }],
  }), /dataset_license_spdx_invalid/);
  assert.throws(() => buildCampaignBenchmarkSelector({
    benchmarkId: 'operator-dataset',
    datasetMounts: [{
      name: 'operator-dataset', source: '/tmp/operator-dataset', readOnly: true,
      manifestHash: `sha256:${'a'.repeat(64)}`, splitManifestHash: `sha256:${'b'.repeat(64)}`,
      licenseId: 'CC-BY-4.0', operatorAuthorizationHash: `sha256:${'c'.repeat(64)}`,
    }],
  }), /campaign_benchmark_dataset_authorization_invalid/);
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
  assert.equal(passed.status, 'dataset_consumption_source_preflight_verified');
  assert.equal(passed.verificationStrength, 'source_static_preflight');
  assert.equal(passed.blockers.length, 0);
  const commentOnly = evaluateDatasetConsumptionContract({ sourceText: '# read.csv(Sys.getenv("HEPTA_DATASET_TRIAL_DATA"))\n# open("/datasets/holdout")', datasetMounts: mounts });
  assert.equal(commentOnly.status, 'dataset_consumption_contract_blocked');
  const listingOnly = evaluateDatasetConsumptionContract({
    sourceText: 'root <- Sys.getenv("HEPTA_DATASET_TRIAL_DATA"); list.files(root)',
    datasetMounts: [mounts[0]],
  });
  assert.deepEqual(listingOnly.blockers, ['declared_dataset_not_consumed:trial data']);
  const directoryContentRead = evaluateDatasetConsumptionContract({
    sourceText: [
      'root <- Sys.getenv("HEPTA_DATASET_TRIAL_DATA")',
      'probe <- read.csv(file.path(root, "factors_monthly.csv.gz"), nrows = 1)',
    ].join('\n'),
    datasetMounts: [mounts[0]],
  });
  assert.equal(
    directoryContentRead.status,
    'dataset_consumption_source_preflight_verified',
  );
  const namespacedTableRead = evaluateDatasetConsumptionContract({
    sourceText: [
      'root <- Sys.getenv("HEPTA_DATASET_TRIAL_DATA")',
      'relative <- "factors_monthly.txt"',
      'probe <- utils::read.table(file.path(root, relative), nrows = 1)',
    ].join('\n'),
    datasetMounts: [mounts[0]],
  });
  assert.equal(
    namespacedTableRead.status,
    'dataset_consumption_source_preflight_verified',
  );
  const derivedMultilineRead = evaluateDatasetConsumptionContract({
    sourceText: [
      'root <- Sys.getenv("HEPTA_DATASET_TRIAL_DATA",',
      '                   unset = "/datasets/trial-data")',
      'relative <- "factors_monthly.txt"',
      'dataset_file <- file.path(root, relative)',
      'probe <- read.table(dataset_file, nrows = 1)',
    ].join('\n'),
    datasetMounts: [mounts[0]],
  });
  assert.equal(
    derivedMultilineRead.status,
    'dataset_consumption_source_preflight_verified',
  );
  const connectionRead = evaluateDatasetConsumptionContract({
    sourceText: [
      'root <- Sys.getenv("HEPTA_DATASET_TRIAL_DATA", unset = "/datasets/trial-data")',
      'relative <- "factors_monthly.csv.gz"',
      'dataset_file <- file.path(root, relative)',
      'connection <- gzfile(dataset_file, "rt")',
      'probe <- readLines(connection, n = 2L)',
    ].join('\n'),
    datasetMounts: [mounts[0]],
  });
  assert.equal(
    connectionRead.status,
    'dataset_consumption_source_preflight_verified',
  );
  const helperConnectionRead = evaluateDatasetConsumptionContract({
    sourceText: [
      'dataset_root <- function() {',
      '  candidates <- c(Sys.getenv("HEPTA_DATASET_TRIAL_DATA", unset = ""), "/datasets/trial-data")',
      '  normalizePath(candidates[[1L]], mustWork = TRUE)',
      '}',
      'root <- dataset_root()',
      'dataset_file <- file.path(root, "factors_monthly.csv.gz")',
      'connection <- gzfile(dataset_file, "rt")',
      'probe <- readLines(connection, n = 2L)',
    ].join('\n'),
    datasetMounts: [mounts[0]],
  });
  assert.equal(
    helperConnectionRead.status,
    'dataset_consumption_source_preflight_verified',
  );
  const pythonHelperRead = evaluateDatasetConsumptionContract({
    sourceText: [
      'import os',
      'DATASET_ROOT = "/datasets/trial data"',
      'DATASET_ENV = "HEPTA_DATASET_TRIAL_DATA"',
      'def consume_dataset():',
      '    root = os.path.realpath(os.environ.get(DATASET_ENV, DATASET_ROOT))',
      '    for base, _, names in os.walk(root):',
      '        for name in names:',
      '            path = os.path.join(base, name)',
      '            with open(path, "rb") as stream:',
      '                return stream.read()',
    ].join('\n'),
    datasetMounts: [mounts[0]],
  });
  assert.equal(
    pythonHelperRead.status,
    'dataset_consumption_source_preflight_verified',
  );
  const pythonListingOnly = evaluateDatasetConsumptionContract({
    sourceText: [
      'import os',
      'DATASET_ENV = "HEPTA_DATASET_TRIAL_DATA"',
      'root = os.environ.get(DATASET_ENV)',
      'files = os.listdir(root)',
    ].join('\n'),
    datasetMounts: [mounts[0]],
  });
  assert.deepEqual(
    pythonListingOnly.blockers,
    ['declared_dataset_not_consumed:trial data'],
  );
});

test('empirical metric gate compares repeated numeric outputs within tolerance', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-metric-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ accuracy: 0.9, nested: { loss: 0.1 } }));
  fs.writeFileSync(path.join(root, 'results.csv'), 'metric,value\naccuracy,0.9\nloss,0.1\n');
  const first = evaluateEmpiricalResultContract({ outputDirectory: root, metricSchema: { minimumMetricCount: 2 } });
  assert.equal(first.status, 'empirical_result_schema_verified');
  const consistent = evaluateEmpiricalResultContract({ outputDirectory: root, metricSchema: { minimumMetricCount: 2 }, baselineMetrics: first.metrics });
  assert.equal(consistent.status, 'empirical_reproduction_consistent');
  fs.writeFileSync(path.join(root, 'results.csv'), 'score\n1\n');
  const legacyCsv = evaluateEmpiricalResultContract({ outputDirectory: root, metricSchema: { minimumMetricCount: 2 } });
  assert.ok(legacyCsv.blockers.includes('empirical_results_csv_invalid'));
  assert.equal(legacyCsv.csvVerified, false);
  fs.writeFileSync(path.join(root, 'results.csv'), 'metric,value\naccuracy,not-a-number\n');
  const nonNumericCsv = evaluateEmpiricalResultContract({ outputDirectory: root, metricSchema: { minimumMetricCount: 2 } });
  assert.ok(nonNumericCsv.blockers.includes('empirical_results_csv_invalid'));
  fs.writeFileSync(path.join(root, 'results.csv'), 'metric,value\naccuracy,0.9\nloss,0.1\n');
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
  const recovery = path.join(root, '.hepta-materialization-recovery');
  fs.mkdirSync(recovery);
  fs.writeFileSync(path.join(recovery, 'completed-operation.tombstone'), 'before\n');
  assert.equal(sourceTreeExcludedNames(root).includes('.hepta-materialization-recovery'), true);
  const sourceHash = directoryMerkleHash(root, { excludeRoots: [dataset], excludeNames: sourceTreeExcludedNames(root) });
  fs.writeFileSync(path.join(virtualenv, 'environment.bin'), Buffer.alloc(1024, 2));
  fs.writeFileSync(path.join(recovery, 'completed-operation.tombstone'), 'after\n');
  assert.equal(directoryMerkleHash(root, { excludeRoots: [dataset], excludeNames: sourceTreeExcludedNames(root) }), sourceHash);
});
