import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function datasetEnvironmentName(name) {
  return `HEPTA_DATASET_${String(name || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'DATASET'}`;
}

export function evaluateDatasetConsumptionContract({ sourceText = '', datasetMounts = [] } = {}) {
  const text = String(sourceText || '');
  const evidence = datasetMounts.map((mount) => {
    const workerPath = `/datasets/${mount.name}`;
    const environmentName = datasetEnvironmentName(mount.name);
    return Object.freeze({
      name: mount.name,
      workerPath,
      environmentName,
      referenced: text.includes(workerPath) || text.includes(environmentName),
    });
  });
  const blockers = evidence.filter((item) => !item.referenced).map((item) => `declared_dataset_not_consumed:${item.name}`);
  const payload = {
    version: 1,
    kind: 'DatasetConsumptionContractReceipt',
    status: blockers.length ? 'dataset_consumption_contract_blocked' : 'dataset_consumption_verified',
    evidence,
    blockers,
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, datasetConsumptionContractReceiptHash: hashRecord('DatasetConsumptionContractReceipt', payload) });
}

function numericLeaves(value, prefix = '', rows = []) {
  if (typeof value === 'number' && Number.isFinite(value)) rows.push({ path: prefix || '$', value });
  else if (Array.isArray(value)) value.forEach((item, index) => numericLeaves(item, `${prefix}[${index}]`, rows));
  else if (value && typeof value === 'object') Object.keys(value).sort().forEach((key) => numericLeaves(value[key], prefix ? `${prefix}.${key}` : key, rows));
  return rows;
}

export function normalizeDatasetMounts(mounts = []) {
  return mounts.map((mount, index) => {
    const normalized = {
      name: String(mount?.name || `dataset-${index + 1}`),
      source: String(mount?.source || ''),
      readOnly: mount?.readOnly === true,
      manifestHash: mount?.manifestHash || null,
      licenseId: String(mount?.licenseId || ''),
    };
    const blockers = [];
    if (!normalized.source) blockers.push('dataset_source_missing');
    if (!normalized.readOnly) blockers.push('dataset_mount_not_readonly');
    if (!/^sha256:[0-9a-f]{64}$/i.test(String(normalized.manifestHash || ''))) blockers.push('dataset_manifest_hash_invalid');
    if (!normalized.licenseId || /^(?:unknown|unlicensed|none)$/i.test(normalized.licenseId)) blockers.push('dataset_license_missing');
    if (blockers.length) throw new Error(`${blockers.join(',')}:${normalized.name}`);
    return Object.freeze(normalized);
  });
}

export function evaluateEmpiricalResultContract({ outputDirectory, metricSchema = {}, baselineMetrics = null } = {}) {
  const resultPath = path.join(outputDirectory || '', 'results.json');
  const blockers = [];
  let metrics = [];
  if (!fs.existsSync(resultPath)) blockers.push('empirical_results_json_missing');
  else {
    try { metrics = numericLeaves(JSON.parse(fs.readFileSync(resultPath, 'utf8'))); }
    catch { blockers.push('empirical_results_json_invalid'); }
  }
  const minimumMetricCount = Math.max(1, Number(metricSchema.minimumMetricCount || 1));
  if (metrics.length < minimumMetricCount) blockers.push('empirical_metric_schema_unsatisfied');
  const requested = Array.isArray(metricSchema.metrics) ? metricSchema.metrics : [];
  for (const item of requested) if (!metrics.some((metric) => metric.path === item.path)) blockers.push(`empirical_metric_missing:${item.path}`);
  const absoluteTolerance = Math.max(0, Number(metricSchema.absoluteTolerance ?? 1e-9));
  const relativeTolerance = Math.max(0, Number(metricSchema.relativeTolerance ?? 1e-6));
  const baseline = new Map((baselineMetrics || []).map((metric) => [metric.path, Number(metric.value)]));
  if (baselineMetrics) {
    if (baseline.size !== metrics.length) blockers.push('empirical_metric_shape_changed');
    for (const metric of metrics) {
      if (!baseline.has(metric.path)) { blockers.push(`empirical_metric_path_changed:${metric.path}`); continue; }
      const expected = baseline.get(metric.path);
      const delta = Math.abs(metric.value - expected);
      const allowed = Math.max(absoluteTolerance, relativeTolerance * Math.max(Math.abs(expected), Math.abs(metric.value)));
      if (delta > allowed) blockers.push(`empirical_metric_inconsistent:${metric.path}`);
    }
  }
  const payload = {
    version: 1,
    kind: 'EmpiricalResultContractReceipt',
    status: blockers.length ? 'empirical_result_contract_blocked' : baselineMetrics ? 'empirical_reproduction_consistent' : 'empirical_result_schema_verified',
    metricSchema: { minimumMetricCount, absoluteTolerance, relativeTolerance, metrics: requested },
    metrics,
    baselineCompared: Boolean(baselineMetrics),
    blockers: [...new Set(blockers)],
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, empiricalResultContractReceiptHash: hashRecord('EmpiricalResultContractReceipt', payload) });
}
