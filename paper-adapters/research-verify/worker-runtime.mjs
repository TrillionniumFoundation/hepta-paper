import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fileRecord,
  pathWithin,
  readJsonIfExists,
  sha256File,
} from '../../paper-core/src/utils.mjs';
import { hashPaperRecord } from '../../paper-core/src/paper-contracts.mjs';
import { createFilesystemArtifactRepository } from '../artifacts/filesystem-artifact-repository.mjs';
import { createLeanFormalVerifier } from './formal-verifier.mjs';

export const NATIVE_RESEARCH_WORKER_TYPES = Object.freeze([
  'artifact_integrity',
  'csv_descriptive_statistics',
  'json_assertions',
  'formal_verifier_lean',
]);

const WORKER_TYPE_SET = new Set(NATIVE_RESEARCH_WORKER_TYPES);

function safeWorkerId(value) {
  const id = String(value || '');
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id) ? id : null;
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(value.trim());
      value = '';
    } else {
      value += char;
    }
  }
  values.push(value.trim());
  return values;
}

function finiteNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function descriptiveStatistics(values) {
  const count = values.length;
  const sum = values.reduce((total, value) => total + value, 0);
  const mean = count ? sum / count : null;
  const variance = count > 1
    ? values.reduce((total, value) => total + ((value - mean) ** 2), 0) / (count - 1)
    : 0;
  return {
    count,
    min: count ? Math.min(...values) : null,
    max: count ? Math.max(...values) : null,
    sum,
    mean,
    sampleVariance: variance,
    sampleStdDev: Math.sqrt(variance),
  };
}

function jsonPathValue(document, pointer) {
  const parts = String(pointer || '')
    .replace(/^\$\.?/, '')
    .split('.')
    .filter(Boolean);
  let current = document;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function assertionPassed(actual, assertion) {
  switch (assertion.op) {
    case 'exists': return actual !== undefined;
    case 'equals': return JSON.stringify(actual) === JSON.stringify(assertion.value);
    case 'gte': return Number.isFinite(Number(actual)) && Number(actual) >= Number(assertion.value);
    case 'lte': return Number.isFinite(Number(actual)) && Number(actual) <= Number(assertion.value);
    case 'truthy': return Boolean(actual);
    default: return false;
  }
}

async function executeWorker(worker, inputRecords, { sourceRoot } = {}) {
  if (worker.type === 'artifact_integrity') {
    return {
      status: 'native_research_worker_passed',
      artifactCount: inputRecords.length,
      artifacts: inputRecords.map((record) => ({
        role: record.role,
        path: record.path,
        hash: record.hash,
        verified: record.hash === record.expectedHash,
      })),
    };
  }
  if (worker.type === 'csv_descriptive_statistics') {
    if (inputRecords.length !== 1) {
      return { status: 'native_research_worker_blocked', blockers: ['csv_worker_requires_exactly_one_input'] };
    }
    const text = await fs.readFile(inputRecords[0].absolutePath, 'utf8');
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) return { status: 'native_research_worker_blocked', blockers: ['csv_data_rows_missing'] };
    const headers = parseCsvLine(lines[0]);
    const rows = lines.slice(1).map((line) => parseCsvLine(line));
    const requestedColumns = Array.isArray(worker.parameters?.numericColumns)
      ? worker.parameters.numericColumns.map(String)
      : headers;
    const blockers = [];
    const columns = {};
    for (const name of requestedColumns) {
      const columnIndex = headers.indexOf(name);
      if (columnIndex < 0) {
        blockers.push(`csv_numeric_column_missing:${name}`);
        continue;
      }
      const values = rows.map((row) => finiteNumber(row[columnIndex])).filter((value) => value !== null);
      if (values.length !== rows.length) blockers.push(`csv_numeric_column_contains_non_numeric_value:${name}`);
      columns[name] = descriptiveStatistics(values);
    }
    return {
      status: blockers.length ? 'native_research_worker_blocked' : 'native_research_worker_passed',
      rowCount: rows.length,
      columns,
      blockers,
    };
  }
  if (worker.type === 'json_assertions') {
    if (inputRecords.length !== 1) {
      return { status: 'native_research_worker_blocked', blockers: ['json_assertion_worker_requires_exactly_one_input'] };
    }
    const document = JSON.parse(await fs.readFile(inputRecords[0].absolutePath, 'utf8'));
    const assertions = Array.isArray(worker.parameters?.assertions) ? worker.parameters.assertions : [];
    if (!assertions.length) {
      return { status: 'native_research_worker_blocked', blockers: ['json_assertions_missing'] };
    }
    const results = assertions.map((assertion) => {
      const actual = jsonPathValue(document, assertion.path);
      return {
        path: String(assertion.path || ''),
        op: String(assertion.op || ''),
        expected: assertion.value ?? null,
        actual: actual ?? null,
        passed: assertionPassed(actual, assertion),
      };
    });
    const blockers = results.filter((item) => !item.passed).map((item) => `json_assertion_failed:${item.path}`);
    return {
      status: blockers.length ? 'native_research_worker_blocked' : 'native_research_worker_passed',
      assertionCount: results.length,
      passedAssertionCount: results.filter((item) => item.passed).length,
      assertions: results,
      blockers,
    };
  }
  if (worker.type === 'formal_verifier_lean') {
    const verifier = createLeanFormalVerifier({
      sourceRoot,
      executable: String(worker.parameters?.executable || 'lean'),
    });
    return verifier.verify({ inputRecords, parameters: worker.parameters || {} });
  }
  return { status: 'native_research_worker_blocked', blockers: ['native_research_worker_type_not_allowed'] };
}

async function validateInputs({ root, sourceRoot, worker }) {
  const blockers = [];
  const inputSpecs = Array.isArray(worker.inputs) ? worker.inputs : [];
  if (!inputSpecs.length) blockers.push('research_worker_inputs_missing');
  const records = [];
  for (const input of inputSpecs) {
    const relative = String(input?.path || '');
    const absolutePath = path.resolve(sourceRoot, relative);
    const inputBlockers = [];
    if (!relative || !pathWithin(sourceRoot, absolutePath)) inputBlockers.push('research_worker_input_outside_source_workspace');
    const record = inputBlockers.length ? null : await fileRecord(root, absolutePath, input?.role || 'research_worker_input');
    if (!record) inputBlockers.push('research_worker_input_missing');
    if (!input?.sha256) inputBlockers.push('research_worker_input_hash_missing');
    if (record && record.hash !== input.sha256) inputBlockers.push('research_worker_input_hash_mismatch');
    blockers.push(...inputBlockers.map((blocker) => `${relative || 'unknown'}:${blocker}`));
    records.push({
      role: String(input?.role || 'research_worker_input'),
      path: relative || null,
      absolutePath,
      hash: record?.hash || null,
      expectedHash: input?.sha256 || null,
      verified: inputBlockers.length === 0,
    });
  }
  return { records, blockers };
}

function normalizedWorkerDefinition(worker) {
  return {
    id: String(worker.id || ''),
    type: String(worker.type || ''),
    evidenceClass: String(worker.evidenceClass || ''),
    syntheticInput: worker.syntheticInput,
    outcomesPreprogrammed: worker.outcomesPreprogrammed,
    claimIds: Array.isArray(worker.claimIds) ? worker.claimIds.map(String).sort() : [],
    inputs: (Array.isArray(worker.inputs) ? worker.inputs : []).map((input) => ({
      role: String(input?.role || 'research_worker_input'),
      path: String(input?.path || ''),
      sha256: String(input?.sha256 || ''),
    })),
    parameters: worker.parameters || {},
  };
}

function receiptHash(receipt) {
  const { nativeResearchWorkerExecutionReceiptHash: _hash, ...payload } = receipt;
  return hashPaperRecord('NativeResearchWorkerExecutionReceipt', payload);
}

function validatePersistedReceipt({ persisted, expected }) {
  const blockers = [];
  if (!persisted) blockers.push('native_research_worker_execution_receipt_missing');
  if (persisted && receiptHash(persisted) !== persisted.nativeResearchWorkerExecutionReceiptHash) {
    blockers.push('native_research_worker_execution_receipt_hash_invalid');
  }
  for (const key of ['paperId', 'taskKey', 'workerId', 'workerType', 'planHash', 'workerDefinitionHash', 'engineHash', 'resultHash']) {
    if (persisted && persisted[key] !== expected[key]) blockers.push(`native_research_worker_receipt_${key}_mismatch`);
  }
  if (persisted && JSON.stringify(persisted.inputs) !== JSON.stringify(expected.inputs)) {
    blockers.push('native_research_worker_receipt_inputs_mismatch');
  }
  if (persisted && persisted.status !== 'native_research_worker_execution_verified') {
    blockers.push('native_research_worker_receipt_not_verified');
  }
  return blockers;
}

export async function runNativeResearchWorkers({
  root,
  sourceRoot,
  runtimeRoot,
  paperTask,
  execute = false,
} = {}) {
  const planPath = sourceRoot ? path.join(sourceRoot, 'RESEARCH_WORKER_PLAN.json') : null;
  const plan = planPath ? await readJsonIfExists(planPath) : null;
  const reportBlockers = [];
  if (!sourceRoot || !planPath) reportBlockers.push('research_worker_source_workspace_missing');
  if (!plan) reportBlockers.push('research_worker_plan_missing');
  if (plan && (plan.version !== 1 || plan.kind !== 'NativeResearchWorkerPlan')) {
    reportBlockers.push('research_worker_plan_schema_invalid');
  }
  if (plan && plan.paperId !== paperTask?.paperId) reportBlockers.push('research_worker_plan_paper_id_mismatch');
  if (plan && plan.taskKey !== paperTask?.taskKey) reportBlockers.push('research_worker_plan_task_key_mismatch');
  const workers = Array.isArray(plan?.workers) ? plan.workers : [];
  if (plan && (!workers.length || workers.length > 16)) reportBlockers.push('research_worker_plan_worker_count_invalid');
  const workerIds = workers.map((worker) => safeWorkerId(worker.id));
  if (workerIds.some((id) => !id)) reportBlockers.push('research_worker_id_invalid');
  if (new Set(workerIds.filter(Boolean)).size !== workerIds.filter(Boolean).length) reportBlockers.push('research_worker_id_duplicate');
  const planRecord = planPath && plan ? await fileRecord(root, planPath, 'native_research_worker_plan') : null;
  const engineFiles = [
    fileURLToPath(import.meta.url),
    fileURLToPath(new URL('./formal-verifier.mjs', import.meta.url)),
    fileURLToPath(new URL('../runtime/sandboxed-command-runner.mjs', import.meta.url)),
  ];
  const engineHash = hashPaperRecord('NativeResearchWorkerEngine', {
    files: await Promise.all(engineFiles.map(async (file) => ({ file: path.basename(file), hash: await sha256File(file) }))),
    workerTypes: NATIVE_RESEARCH_WORKER_TYPES,
  });
  const outputDir = runtimeRoot && paperTask?.paperId
    ? path.join(runtimeRoot, 'research-workers', paperTask.paperId)
    : null;
  if (!outputDir || !pathWithin(runtimeRoot, outputDir)) reportBlockers.push('research_worker_runtime_output_invalid');
  const artifactRepository = outputDir
    ? createFilesystemArtifactRepository({ scopeRoot: outputDir, repositoryId: 'native-research-worker-receipts' })
    : null;
  const receipts = [];
  for (const worker of workers) {
    const blockers = [];
    const id = safeWorkerId(worker.id);
    if (!id) blockers.push('research_worker_id_invalid');
    if (!WORKER_TYPE_SET.has(worker.type)) blockers.push('native_research_worker_type_not_allowed');
    if (worker.evidenceClass !== 'research_evidence') blockers.push('research_worker_evidence_class_invalid');
    if (worker.syntheticInput !== false) blockers.push('research_worker_synthetic_input_not_eligible');
    if (worker.outcomesPreprogrammed !== false) blockers.push('research_worker_preprogrammed_outcomes_not_eligible');
    if (!Array.isArray(worker.claimIds) || !worker.claimIds.length) blockers.push('research_worker_claim_ids_missing');
    const inputValidation = await validateInputs({ root, sourceRoot, worker });
    blockers.push(...inputValidation.blockers);
    const result = blockers.length
      ? { status: 'native_research_worker_blocked', blockers }
      : await executeWorker(worker, inputValidation.records, { sourceRoot });
    blockers.push(...(result.blockers || []));
    const workerDefinitionHash = hashPaperRecord(
      'NativeResearchWorkerDefinition',
      normalizedWorkerDefinition(worker),
    );
    const resultHash = hashPaperRecord('NativeResearchWorkerResult', result);
    const baseReceipt = {
      version: 1,
      kind: 'NativeResearchWorkerExecutionReceipt',
      paperId: paperTask?.paperId || null,
      taskKey: paperTask?.taskKey || null,
      workerId: id,
      workerType: worker.type || null,
      status: blockers.length
        ? 'native_research_worker_execution_blocked'
        : 'native_research_worker_execution_verified',
      planHash: planRecord?.hash || null,
      workerDefinitionHash,
      engineHash,
      inputs: inputValidation.records.map(({ absolutePath: _absolutePath, ...record }) => record),
      claimIds: Array.isArray(worker.claimIds) ? worker.claimIds.map(String) : [],
      result,
      resultHash,
      academicEvidenceEligible: blockers.length === 0,
      blockers: [...new Set(blockers)],
      safety: {
        boundedNativeWorker: true,
        allowlistedWorkerType: WORKER_TYPE_SET.has(worker.type),
        networkAccess: false,
        subprocessExecution: worker.type === 'formal_verifier_lean',
        subprocessBoundedByWorkerRunnerPort: worker.type === 'formal_verifier_lean',
        sourceMutation: false,
        writesRuntimeOnly: Boolean(execute),
        externalActionPerformed: false,
      },
      executedAt: execute ? new Date().toISOString() : null,
    };
    if (execute) {
      const receipt = {
        ...baseReceipt,
        nativeResearchWorkerExecutionReceiptHash: receiptHash(baseReceipt),
      };
      if (artifactRepository && id) {
        await artifactRepository.writeJson(path.join(outputDir, `${id}.receipt.json`), receipt, {
          role: 'native_research_worker_execution_receipt',
        });
      }
      receipts.push(receipt);
    } else {
      const persisted = outputDir && id
        ? await readJsonIfExists(path.join(outputDir, `${id}.receipt.json`))
        : null;
      const expected = {
        ...baseReceipt,
        executedAt: persisted?.executedAt || null,
      };
      const persistedBlockers = validatePersistedReceipt({ persisted, expected });
      receipts.push(persistedBlockers.length
        ? {
          ...expected,
          status: 'native_research_worker_execution_verification_blocked',
          academicEvidenceEligible: false,
          blockers: [...new Set([...expected.blockers, ...persistedBlockers])],
          nativeResearchWorkerExecutionReceiptHash: persisted?.nativeResearchWorkerExecutionReceiptHash || null,
        }
        : persisted);
    }
  }
  const verifiedReceipts = receipts.filter((receipt) => (
    receipt.status === 'native_research_worker_execution_verified'
    && receipt.academicEvidenceEligible === true
  ));
  const report = {
    version: 1,
    kind: 'NativeResearchWorkerExecutionReport',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: reportBlockers.length || verifiedReceipts.length !== workers.length
      ? 'native_research_workers_blocked'
      : 'native_research_workers_verified',
    executeRequested: Boolean(execute),
    planPath: planRecord?.path || null,
    planHash: planRecord?.hash || null,
    engineHash,
    plannedResearchWorkerCount: workers.length,
    executedResearchWorkerCount: verifiedReceipts.length,
    verifiedAcademicEvidenceWorkerCount: verifiedReceipts.length,
    workerReceipts: receipts,
    workerReceiptHashes: verifiedReceipts.map((receipt) => receipt.nativeResearchWorkerExecutionReceiptHash),
    blockers: [...new Set([
      ...reportBlockers,
      ...receipts.flatMap((receipt) => receipt.blockers || []),
    ])],
    safety: {
      allowlistedWorkerTypes: [...NATIVE_RESEARCH_WORKER_TYPES],
      networkAccess: false,
      subprocessExecution: workers.some((worker) => worker.type === 'formal_verifier_lean'),
      subprocessBoundedByWorkerRunnerPort: true,
      sourceMutation: false,
      writesRuntimeOnly: Boolean(execute),
      externalActionPerformed: false,
    },
  };
  const hashed = {
    ...report,
    nativeResearchWorkerExecutionReportHash: hashPaperRecord('NativeResearchWorkerExecutionReport', report),
  };
  if (execute && outputDir) {
    await artifactRepository.writeJson(path.join(outputDir, 'RESEARCH_WORKER_EXECUTION_REPORT.json'), hashed, {
      role: 'native_research_worker_execution_report',
    });
  }
  return hashed;
}
