import path from 'node:path';
import fs from 'node:fs';
import {
  datasetEnvironmentName,
  evaluateDatasetConsumptionContract,
  evaluateEmpiricalResultContract as evaluateEmpiricalResultValueContract,
  normalizeDatasetMounts,
} from '../../paper-domain/automation/empirical-contract.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import {
  buildExperimentReplayReceipt,
  buildExperimentRunReceipt,
} from '../../paper-domain/automation/experiment-run-contract.mjs';

export { datasetEnvironmentName, evaluateDatasetConsumptionContract, normalizeDatasetMounts };

// Adapter compatibility facade: filesystem observation is converted into a
// value before the domain contract is evaluated.
export function evaluateEmpiricalResultContract({
  outputDirectory,
  metricSchema = {},
  baselineMetrics = null,
  baselineRunReceipt = null,
  benchmarkSelector = null,
  datasetMounts = [],
  executionReceipt = null,
  datasetConsumptionContractReceiptHash = null,
  rawArtifactWriteReceipt = null,
} = {}) {
  if (!outputDirectory) {
    return evaluateEmpiricalResultValueContract({
      resultStatus: 'missing',
      metricSchema,
      baselineMetrics,
    });
  }
  const read = readScopedFileSync({
    scopeRoot: outputDirectory,
    candidate: path.join(outputDirectory, 'results.json'),
    maximumBytes: 16 * 1024 * 1024,
  });
  const csvRead = readScopedFileSync({
    scopeRoot: outputDirectory,
    candidate: path.join(outputDirectory, 'results.csv'),
    maximumBytes: 16 * 1024 * 1024,
  });
  const missing = read.blockers?.includes('scoped_path_missing_or_unreadable');
  const csvMissing = csvRead.blockers?.includes('scoped_path_missing_or_unreadable');
  if (benchmarkSelector && read.status === 'scoped_file_read_verified' && csvRead.status === 'scoped_file_read_verified') {
    const harnessExecutionReceipt = executionReceipt?.harnessExecutionReceipt || null;
    const experimentRunReceipt = buildExperimentRunReceipt({
      resultDocument: harnessExecutionReceipt?.resultDocument || read.content.toString('utf8'),
      csvDocument: harnessExecutionReceipt?.csvDocument || csvRead.content.toString('utf8'),
      benchmarkSelector,
      datasetMounts,
      executionReceiptHash: executionReceipt?.runnerReceiptHash || null,
      runtimeIdentityHash: executionReceipt?.runtimeIdentityHash || null,
      sourceMerkleHash: executionReceipt?.sourceMerkleHash || null,
      sourceWorkspaceManifestHash: executionReceipt?.sourceWorkspaceManifestHash || null,
      cacheHit: executionReceipt?.cacheHit === true,
      datasetConsumptionContractReceiptHash,
      resultJsonHash: harnessExecutionReceipt?.resultJsonHash || hashBytes(read.content),
      resultCsvHash: harnessExecutionReceipt?.resultCsvHash || hashBytes(csvRead.content),
      runnerReceipt: executionReceipt?.runnerReceipt || null,
      experimentAttemptId: harnessExecutionReceipt?.experimentAttemptId
        || executionReceipt?.runnerReceipt?.executionBindings?.HEPTA_EXPERIMENT_ATTEMPT_ID || null,
      harnessExecutionReceipt,
      sourceLineageHash: executionReceipt?.sourceLineageHash || null,
      rawArtifactWriteReceipt,
    });
    const experimentReplayReceipt = baselineRunReceipt
      ? buildExperimentReplayReceipt({
        originalRunReceipt: baselineRunReceipt,
        replayRunReceipt: experimentRunReceipt,
        absoluteTolerance: metricSchema.absoluteTolerance,
        relativeTolerance: metricSchema.relativeTolerance,
      })
      : null;
    const blockers = [...experimentRunReceipt.blockers, ...(experimentReplayReceipt?.blockers || [])];
    const metrics = Object.entries(experimentRunReceipt.aggregateMetrics?.treatment || {})
      .map(([metric, value]) => ({ path: metric, value }));
    const payload = {
      version: 3,
      kind: 'EmpiricalResultContractReceipt',
      status: blockers.length
        ? 'empirical_result_contract_blocked'
        : experimentReplayReceipt ? 'empirical_reproduction_consistent' : 'empirical_result_schema_verified',
      metrics,
      experimentDesignHash: experimentRunReceipt.experimentDesignHash,
      experimentRunReceipt,
      experimentReplayReceipt,
      blockers: [...new Set(blockers)],
      externalActionPerformed: false,
    };
    return Object.freeze({ ...payload, empiricalResultContractReceiptHash: hashRecord('EmpiricalResultContractReceipt', payload) });
  }
  return evaluateEmpiricalResultValueContract({
    resultDocument: read.status === 'scoped_file_read_verified'
      ? read.content.toString('utf8')
      : undefined,
    resultStatus: read.status === 'scoped_file_read_verified'
      ? 'available'
      : missing ? 'missing' : 'invalid',
    csvDocument: csvRead.status === 'scoped_file_read_verified' ? csvRead.content.toString('utf8') : undefined,
    csvStatus: csvRead.status === 'scoped_file_read_verified' ? 'available' : csvMissing ? 'missing' : 'invalid',
    metricSchema,
    baselineMetrics,
    benchmarkSelector,
  });
}

export function writeExperimentRunEvidenceBundle({ outputDirectory, experimentRunReceipt, experimentReplayReceipt = null } = {}) {
  if (!outputDirectory || !experimentRunReceipt || experimentRunReceipt.status !== 'experiment_run_receipt_verified') return null;
  const experiment = {
    kind: 'experiment',
    experimentId: experimentRunReceipt.benchmarkId,
    runId: experimentRunReceipt.experimentRunReceiptHash,
    datasetHash: experimentRunReceipt.datasetAuthorizationSetHash,
    datasetManifestHash: experimentRunReceipt.datasetAuthorizations[0]?.manifestHash || experimentRunReceipt.datasetAuthorizationSetHash,
    datasetLicenseId: experimentRunReceipt.datasetAuthorizations[0]?.licenseId || 'builtin-benchmark',
    datasetReadOnly: true,
    datasetMounts: experimentRunReceipt.datasetAuthorizations,
    seed: experimentRunReceipt.seedSchedule[0] ?? null,
    codeHash: experimentRunReceipt.sourceMerkleHash,
    resultHash: experimentRunReceipt.observationManifestHash,
    resultPath: 'results.json',
    metric: experimentRunReceipt.aggregateMetrics,
    metrics: experimentRunReceipt.aggregateMetrics,
    experimentRunReceipt,
    reproducibilityReceipt: experimentReplayReceipt,
    promotionRequested: Boolean(experimentReplayReceipt?.status === 'experiment_replay_verified'),
  };
  const bundle = {
    version: 1,
    kind: 'CampaignExperimentEvidenceBundle',
    experiments: [experiment],
    experimentRunReceipt,
    experimentReplayReceipt,
  };
  const relative = 'EXPERIMENT_RUN_EVIDENCE.json';
  const candidate = path.join(outputDirectory, relative);
  writeDurableJsonSync(candidate, bundle);
  const stat = fs.statSync(candidate);
  return Object.freeze({ path: relative, sha256: hashBytes(fs.readFileSync(candidate)), bytes: stat.size, bundle });
}
