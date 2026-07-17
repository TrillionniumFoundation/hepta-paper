import fs from 'node:fs/promises';
import { createLeanFormalVerifier } from './formal-verifier.mjs';
import { executeLakeFormalWorker } from './lake-formal-worker.mjs';

export const NATIVE_RESEARCH_WORKER_TYPES = Object.freeze([
  'artifact_integrity',
  'csv_descriptive_statistics',
  'json_assertions',
  'formal_verifier_lean',
  'formal_verifier_lake',
]);

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

export async function executeNativeResearchWorker(worker, inputRecords, { sourceRoot, signal = null } = {}) {
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
  if (worker.type === 'formal_verifier_lake') {
    return executeLakeFormalWorker({ worker, inputRecords, sourceRoot, signal });
  }
  return { status: 'native_research_worker_blocked', blockers: ['native_research_worker_type_not_allowed'] };
}
