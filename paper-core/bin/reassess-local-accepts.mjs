#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonFile } from '../../paper-adapters/artifacts/write-artifact.mjs';
import { fileURLToPath } from 'node:url';
import { bootstrapPaperExecutionContext } from '../../paper-composition/bootstrap/service-bootstrap.mjs';
import { withArtifactWriteContext } from '../../paper-adapters/artifacts/artifact-write-context.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeRoot = path.join(workspaceRoot, 'runtime');

function walkJson(root) {
  const out = [];
  const walk = (current) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === 'audits') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
    }
  };
  walk(root);
  return out.sort((left, right) => left.localeCompare(right));
}

function collectObjects(value, jsonPath = '$', out = []) {
  if (!value || typeof value !== 'object') return out;
  if (!Array.isArray(value) && value.kind) out.push({ jsonPath, value });
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectObjects(item, `${jsonPath}[${index}]`, out));
  } else {
    for (const [key, item] of Object.entries(value)) collectObjects(item, `${jsonPath}.${key}`, out);
  }
  return out;
}

function compact(item) {
  const value = item.value;
  return {
    file: item.file,
    jsonPath: item.jsonPath,
    kind: value.kind,
    paperId: value.paperId || null,
    status: value.status || null,
    hash: value.refereeAutopilotAcceptanceReceiptHash
      || value.freshRefereeVerdictHash
      || value.empiricalEvidenceGateHash
      || value.venueEvidenceGateHash
      || null,
  };
}

function uniqueFindingCount(items) {
  return new Set(items.map((item) => {
    const compacted = compact(item);
    return compacted.hash || `${compacted.file}:${compacted.jsonPath}`;
  })).size;
}

const parseErrors = [];
const objects = [];
for (const file of walkJson(runtimeRoot)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const item of collectObjects(parsed)) {
      objects.push({
        ...item,
        file: path.relative(workspaceRoot, file).replace(/\\/g, '/'),
      });
    }
  } catch (error) {
    parseErrors.push({
      file: path.relative(workspaceRoot, file).replace(/\\/g, '/'),
      error: error.message,
    });
  }
}

const acceptanceReceipts = objects.filter(({ value }) => (
  value.kind === 'RefereeAutopilotAcceptanceReceipt'
  && (value.accepted === true || value.status === 'referee_autopilot_accept_recorded')
));
const freshRefereeAccepts = objects.filter(({ value }) => (
  value.kind === 'FreshRefereeVerdict'
  && (value.verdict === 'accept' || value.status === 'fresh_referee_accept')
));
const empiricalEvidenceReady = objects.filter(({ value }) => (
  value.kind === 'EmpiricalEvidenceGate' && value.status === 'empirical_evidence_gate_ready'
));
const venueEvidenceReady = objects.filter(({ value }) => (
  value.kind === 'VenueEvidenceGate' && value.status === 'venue_evidence_gate_ready'
));

const report = {
  version: 1,
  kind: 'LocalAcademicAcceptReassessment',
  generatedAt: new Date().toISOString(),
  status: acceptanceReceipts.length || freshRefereeAccepts.length
    ? 'prior_local_accepts_invalidated'
    : 'no_prior_local_accepts_found',
  policyEffectiveAt: '2026-07-10',
  policy: {
    deterministicPersonaIsIndependentReview: false,
    preprogrammedSimulatorIsAcademicEvidence: false,
    filenameOnlyEvidenceScanIsAcademicAttestation: false,
    priorLocalAcceptGrantsSubmissionAuthority: false,
  },
  summary: {
    scannedJsonFiles: walkJson(runtimeRoot).length,
    parseErrorCount: parseErrors.length,
    priorAutopilotAcceptanceReceiptCount: acceptanceReceipts.length,
    uniquePriorAutopilotAcceptanceReceiptCount: uniqueFindingCount(acceptanceReceipts),
    priorFreshRefereeAcceptCount: freshRefereeAccepts.length,
    uniquePriorFreshRefereeAcceptCount: uniqueFindingCount(freshRefereeAccepts),
    priorEmpiricalEvidenceReadyCount: empiricalEvidenceReady.length,
    uniquePriorEmpiricalEvidenceReadyCount: uniqueFindingCount(empiricalEvidenceReady),
    priorVenueEvidenceReadyCount: venueEvidenceReady.length,
    uniquePriorVenueEvidenceReadyCount: uniqueFindingCount(venueEvidenceReady),
    validAcademicAcceptCount: 0,
    invalidatedAcademicAcceptCount: uniqueFindingCount(acceptanceReceipts),
  },
  invalidationReasons: [
    'independent_referee_review_not_performed',
    'academic_evidence_attestation_missing',
    'generated_simulator_outcomes_preprogrammed',
  ],
  acceptanceReceipts: acceptanceReceipts.map(compact),
  freshRefereeAccepts: freshRefereeAccepts.map(compact),
  empiricalEvidenceReady: empiricalEvidenceReady.map(compact),
  venueEvidenceReady: venueEvidenceReady.map(compact),
  parseErrors,
  safety: {
    readsRuntimeOnly: true,
    sourceMutation: false,
    sqliteWrites: false,
    externalActionPerformed: false,
  },
};
report.reportHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex')}`;
const outputPath = path.join(runtimeRoot, 'audits', 'LOCAL_ACCEPT_REASSESSMENT.json');
const context = bootstrapPaperExecutionContext({ root: workspaceRoot, runtimeRoot, mode: 'admin-reassessment', writeReport: true });
await withArtifactWriteContext(context.services, () => writeJsonFile(outputPath, report, {
  scopeRoot: runtimeRoot,
  role: 'local_accept_reassessment',
  atomic: true,
}));
process.stdout.write(`${JSON.stringify({ ...report.summary, status: report.status, outputPath }, null, 2)}\n`);
