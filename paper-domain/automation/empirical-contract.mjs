import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE,
  LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS,
  isLocalGoldenDatasetAuthority,
} from './operator-dataset-harness-contract.mjs';

export function datasetEnvironmentName(name) {
  return `HEPTA_DATASET_${String(name || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'DATASET'}`;
}

const SPDX_LICENSE_IDS = new Set([
  '0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC-BY-4.0', 'CC-BY-SA-4.0',
  'CC0-1.0', 'MIT', 'ODbL-1.0', 'PDDL-1.0', 'Unlicense',
]);

export function isDatasetLicenseId(value) {
  const licenseId = String(value || '');
  return SPDX_LICENSE_IDS.has(licenseId) || /^LicenseRef-[A-Za-z0-9.-]+$/.test(licenseId);
}

function executableSourceText(sourceText) {
  return String(sourceText || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/#.*$/gm, '');
}

function datasetTokenIsRead(sourceText, token) {
  const text = executableSourceText(sourceText);
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const readCall = '(?:(?:[A-Za-z][A-Za-z0-9.]*::)?(?:open|read(?:File(?:Sync)?|Lines|Bin|_csv|\\.(?:csv|table|delim)|RDS)?|load|scan|fromJSON)|CSV\\.read|pandas\\.read_csv)';
  const quotedToken = `['\"]${escaped}['\"]`;
  const environmentAccess = `(?:os\\.environ\\s*\\[\\s*${quotedToken}\\s*\\]|(?:os\\.)?getenv\\s*\\(\\s*${quotedToken}|process\\.env\\.${escaped}|Sys\\.getenv\\s*\\(\\s*${quotedToken}|ENV\\s*\\[\\s*${quotedToken}\\s*\\])`;
  const directArgument = token.startsWith('/datasets/') ? quotedToken : environmentAccess;
  if (new RegExp(`${readCall}\\s*\\([^\\n]{0,240}${directArgument}`, 'i').test(text)) return true;
  const providerFunctions = [...text.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|<-)\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/gi)]
    .filter((match) => new RegExp(directArgument, 'i').test(match[2]))
    .map((match) => match[1]);
  const providerCall = providerFunctions.length
    ? `(?:${providerFunctions.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*\\(`
    : null;
  const assignment = new RegExp(
    `(?:const|let|var)?\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*(?:=|<-)\\s*(?:${directArgument}${providerCall ? `|${providerCall}` : ''})`,
    'i',
  ).exec(text);
  if (!assignment) return false;
  const derivedVariables = new Set([assignment[1]]);
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    for (const match of text.matchAll(/(?:const|let|var)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|<-)\s*([^\n]+)/gi)) {
      if ([...derivedVariables].some((name) => new RegExp(`\\b${name}\\b`).test(match[2])) && !derivedVariables.has(match[1])) {
        derivedVariables.add(match[1]);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return [...derivedVariables].some((name) => new RegExp(`${readCall}\\s*\\([^\\n]{0,240}\\b${name}\\b`, 'i').test(text));
}

export function evaluateDatasetConsumptionContract({ sourceText = '', datasetMounts = [] } = {}) {
  const text = String(sourceText || '');
  const environmentOwners = new Map();
  const collisions = [];
  const evidence = datasetMounts.map((mount) => {
    const workerPath = `/datasets/${mount.name}`;
    const environmentName = datasetEnvironmentName(mount.name);
    if (environmentOwners.has(environmentName) && environmentOwners.get(environmentName) !== mount.name) {
      collisions.push(`dataset_environment_name_collision:${environmentName}`);
    } else environmentOwners.set(environmentName, mount.name);
    return Object.freeze({
      name: mount.name,
      workerPath,
      environmentName,
      referenced: datasetTokenIsRead(text, workerPath) || datasetTokenIsRead(text, environmentName),
    });
  });
  const blockers = [...collisions, ...evidence.filter((item) => !item.referenced).map((item) => `declared_dataset_not_consumed:${item.name}`)];
  const payload = {
    version: 1,
    kind: 'DatasetConsumptionContractReceipt',
    status: blockers.length ? 'dataset_consumption_contract_blocked' : 'dataset_consumption_source_preflight_verified',
    verificationStrength: 'source_static_preflight',
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
  const environmentOwners = new Map();
  return mounts.map((mount, index) => {
    const normalized = {
      name: String(mount?.name || `dataset-${index + 1}`),
      source: String(mount?.source || ''),
      readOnly: mount?.readOnly === true,
      manifestHash: mount?.manifestHash || null,
      licenseId: String(mount?.licenseId || ''),
      ...(mount?.operatorAuthorizationHash ? { operatorAuthorizationHash: mount.operatorAuthorizationHash } : {}),
      ...(mount?.operatorDatasetAuthorityDocumentHash ? { operatorDatasetAuthorityDocumentHash: mount.operatorDatasetAuthorityDocumentHash } : {}),
      ...(mount?.operatorDatasetAuthority ? { operatorDatasetAuthority: mount.operatorDatasetAuthority } : {}),
      ...(mount?.operatorDatasetResearchSemantics ? {
        operatorDatasetResearchSemantics: mount.operatorDatasetResearchSemantics,
      } : {}),
      ...(mount?.operatorDatasetResearchSemanticsHash ? {
        operatorDatasetResearchSemanticsHash: mount.operatorDatasetResearchSemanticsHash,
      } : {}),
      ...(mount?.authorityScope ? {
        authorityScope: String(mount.authorityScope),
        evidenceClass: String(mount.evidenceClass || ''),
        academicPromotionEligible: mount.academicPromotionEligible === true,
        externalTrustClaimed: mount.externalTrustClaimed === true,
        localGoldenRuntimeScope: mount.localGoldenRuntimeScope,
      } : {}),
      ...(mount?.operatorDatasetHarnessHandle ? { operatorDatasetHarnessHandle: mount.operatorDatasetHarnessHandle } : {}),
      ...(mount?.splitManifestHash ? { splitManifestHash: mount.splitManifestHash } : {}),
      ...(mount?.benchmarkHarnessDocumentHash ? { benchmarkHarnessDocumentHash: mount.benchmarkHarnessDocumentHash } : {}),
      ...(mount?.benchmarkHarnessDefinitionHash ? { benchmarkHarnessDefinitionHash: mount.benchmarkHarnessDefinitionHash } : {}),
      ...(mount?.analysisProtocol ? { analysisProtocol: mount.analysisProtocol } : {}),
      ...(mount?.analysisProtocolHash ? { analysisProtocolHash: mount.analysisProtocolHash } : {}),
      ...(mount?.benchmarkFamily ? { benchmarkFamily: String(mount.benchmarkFamily) } : {}),
      ...(Array.isArray(mount?.benchmarkSeedSchedule) ? { benchmarkSeedSchedule: mount.benchmarkSeedSchedule.map(Number) } : {}),
      ...(mount?.benchmarkMinimumRepetitions ? { benchmarkMinimumRepetitions: Number(mount.benchmarkMinimumRepetitions) } : {}),
    };
    const blockers = [];
    if (!normalized.source) blockers.push('dataset_source_missing');
    if (!normalized.readOnly) blockers.push('dataset_mount_not_readonly');
    if (!/^sha256:[0-9a-f]{64}$/i.test(String(normalized.manifestHash || ''))) blockers.push('dataset_manifest_hash_invalid');
    if (!normalized.licenseId) blockers.push('dataset_license_missing');
    else if (!isDatasetLicenseId(normalized.licenseId)) blockers.push('dataset_license_spdx_invalid');
    if (normalized.licenseId.startsWith('LicenseRef-') && !/^sha256:[0-9a-f]{64}$/i.test(String(normalized.operatorAuthorizationHash || ''))) blockers.push('dataset_operator_authorization_missing');
    if (normalized.operatorDatasetAuthorityDocumentHash
      && normalized.operatorAuthorizationHash !== normalized.operatorDatasetAuthorityDocumentHash) blockers.push('dataset_operator_authority_identity_mismatch');
    const localGoldenAuthorityVersion = normalized.operatorDatasetAuthority?.version === 4;
    if ((localGoldenAuthorityVersion || normalized.authorityScope) && (
      normalized.authorityScope !== LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE
      || normalized.evidenceClass !== LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS
      || normalized.academicPromotionEligible !== false
      || normalized.externalTrustClaimed !== false
      || normalized.localGoldenRuntimeScope?.kind !== 'LocalGoldenDatasetRuntimeScope'
      || !isLocalGoldenDatasetAuthority(normalized.operatorDatasetAuthority)
      || JSON.stringify(normalized.localGoldenRuntimeScope)
        !== JSON.stringify(normalized.operatorDatasetAuthority.localGoldenRuntimeScope)
    )) blockers.push('dataset_local_golden_authority_scope_invalid');
    if (normalized.splitManifestHash && !/^sha256:[0-9a-f]{64}$/i.test(String(normalized.splitManifestHash))) blockers.push('dataset_split_manifest_hash_invalid');
    for (const field of ['operatorDatasetHarnessHandle', 'operatorDatasetAuthorityDocumentHash', 'operatorDatasetResearchSemanticsHash', 'benchmarkHarnessDocumentHash', 'benchmarkHarnessDefinitionHash', 'analysisProtocolHash']) {
      if (normalized[field] && !/^sha256:[0-9a-f]{64}$/i.test(String(normalized[field]))) blockers.push(`dataset_${field}_invalid`);
    }
    if (normalized.benchmarkSeedSchedule && (normalized.benchmarkSeedSchedule.length < 1
      || normalized.benchmarkSeedSchedule.some((seed) => !Number.isSafeInteger(seed)))) blockers.push('dataset_benchmark_seed_schedule_invalid');
    if (normalized.benchmarkMinimumRepetitions && !Number.isSafeInteger(normalized.benchmarkMinimumRepetitions)) blockers.push('dataset_benchmark_repetitions_invalid');
    const environmentName = datasetEnvironmentName(normalized.name);
    if (environmentOwners.has(environmentName) && environmentOwners.get(environmentName) !== normalized.name) blockers.push(`dataset_environment_name_collision:${environmentName}`);
    else environmentOwners.set(environmentName, normalized.name);
    if (blockers.length) throw new Error(`${blockers.join(',')}:${normalized.name}`);
    return Object.freeze(normalized);
  });
}

export function evaluateEmpiricalResultContract({
  resultDocument = undefined,
  resultStatus = resultDocument === undefined ? 'missing' : 'available',
  metricSchema = {},
  baselineMetrics = null,
  csvDocument = undefined,
  csvStatus = csvDocument === undefined ? 'missing' : 'available',
  benchmarkSelector = null,
} = {}) {
  const blockers = [];
  let metrics = [];
  if (resultStatus === 'missing') blockers.push('empirical_results_json_missing');
  else if (resultStatus !== 'available') blockers.push('empirical_results_json_invalid');
  else {
    try {
      const value = typeof resultDocument === 'string' ? JSON.parse(resultDocument) : resultDocument;
      if (value === null || value === undefined) throw new Error('result_document_missing');
      metrics = numericLeaves(value);
    } catch {
      blockers.push('empirical_results_json_invalid');
    }
  }
  const minimumMetricCount = Math.max(1, Number(metricSchema.minimumMetricCount || 1));
  if (metrics.length < minimumMetricCount) blockers.push('empirical_metric_schema_unsatisfied');
  const csvLines = csvStatus === 'available'
    ? String(csvDocument || '').split(/\r?\n/).filter((line) => line.trim())
    : [];
  const csvHeader = csvLines[0]?.split(',').map((value) => value.trim()) || [];
  const csvColumnCount = csvHeader.length;
  const csvRows = csvLines.slice(1).map((line) => line.split(',').map((value) => value.trim()));
  const canonicalCsvHeader = csvColumnCount === 2 && csvHeader[0] === 'metric' && csvHeader[1] === 'value';
  const csvHasFiniteObservation = csvRows.length > 0
    && csvRows.every((row) => row.length === 2 && row[0] !== '' && row[1] !== '' && Number.isFinite(Number(row[1])));
  const csvVerified = csvStatus === 'available' && canonicalCsvHeader && csvHasFiniteObservation;
  if (csvStatus === 'missing') blockers.push('empirical_results_csv_missing');
  else if (!csvVerified) blockers.push('empirical_results_csv_invalid');
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
  const design = benchmarkSelector?.experimentDesign || null;
  if (benchmarkSelector) {
    let resultValue = null;
    try { resultValue = typeof resultDocument === 'string' ? JSON.parse(resultDocument) : resultDocument; } catch { resultValue = null; }
    if (!design || benchmarkSelector.experimentDesignHash !== design.experimentDesignHash) blockers.push('empirical_experiment_design_invalid');
    if (resultValue?.experimentDesignHash !== benchmarkSelector.experimentDesignHash) blockers.push('empirical_experiment_design_not_executed');
    const observedSeeds = new Set(Array.isArray(resultValue?.seeds) ? resultValue.seeds.map(Number) : []);
    if ((design?.seedSchedule || []).some((seed) => !observedSeeds.has(Number(seed)))) blockers.push('empirical_seed_schedule_incomplete');
    if (Number(resultValue?.repetitions || 0) < Number(design?.minimumRepetitions || 0)) blockers.push('empirical_repetition_schedule_incomplete');
    if (design?.requireBaseline === true && (!Array.isArray(resultValue?.baselines) || !resultValue.baselines.length)) blockers.push('empirical_baseline_results_missing');
    if (design?.requireAblation === true && (!Array.isArray(resultValue?.ablations) || !resultValue.ablations.length)) blockers.push('empirical_ablation_results_missing');
    for (const metricName of design?.requiredMetrics || []) {
      if (!metrics.some((metric) => metric.path === metricName || metric.path.endsWith(`.${metricName}`))) blockers.push(`empirical_benchmark_metric_missing:${metricName}`);
    }
  }
  const payload = {
    version: 3,
    kind: 'EmpiricalResultContractReceipt',
    status: blockers.length ? 'empirical_result_contract_blocked' : baselineMetrics ? 'empirical_reproduction_consistent' : 'empirical_result_schema_verified',
    metricSchema: { minimumMetricCount, absoluteTolerance, relativeTolerance, metrics: requested },
    metrics,
    baselineCompared: Boolean(baselineMetrics),
    csvVerified,
    csvSchema: { header: ['metric', 'value'], rowCount: csvRows.length },
    experimentDesignHash: benchmarkSelector?.experimentDesignHash || null,
    assuranceScope: benchmarkSelector?.assuranceScope || 'draft-or-software-conformance-only-v1',
    academicPromotionEligible: benchmarkSelector?.assuranceScope === 'operator-authorized-hidden-evaluation-v1',
    promotionScope: benchmarkSelector?.assuranceScope === 'operator-authorized-hidden-evaluation-v1'
      ? 'academic-research-promotion' : 'draft-or-software-conformance-only',
    blockers: [...new Set(blockers)],
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, empiricalResultContractReceiptHash: hashRecord('EmpiricalResultContractReceipt', payload) });
}
