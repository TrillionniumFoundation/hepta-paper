import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { verifyExperimentRunReceipt } from '../../paper-domain/automation/experiment-run-contract.mjs';
import {
  RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT,
  buildIndependentRawEventRecomputationManifest,
  decodeIndependentSystemBenchmarkArmBatchChallenge,
  independentlyEvaluateSystemBenchmarkCellResponses,
  verifyIndependentFixtureBinding,
} from './independent-system-benchmark-recomputation.mjs';
import { SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION } from '../../paper-domain/automation/system-benchmark-harness-identity.mjs';
import { verifyArtifactWriteReceiptSource } from '../artifacts/artifact-write-receipt-verifier.mjs';
import { createSystemBenchmarkPrimitiveFixtureResolver } from './system-benchmark-primitive-fixture-resolver.mjs';

const MAXIMUM_RAW_EVENT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_RAW_EVENT_LINE_BYTES = 1024 * 1024;
const MAXIMUM_RAW_EVENTS_PER_CELL = 64;
const EXECUTION_ROLES = new Set(['original', 'independent-replay']);
const RAW_PRIMITIVE_ROW_KEYS = Object.freeze([
  'version',
  'kind',
  'cellId',
  'seed',
  'repetition',
  'arm',
  'systemBenchmarkCellChallengeHash',
  'systemBenchmarkCellOracleHash',
  'responses',
  'events',
]);

function same(left, right) {
  return hashRecord('IndependentRawPrimitiveRecomputationExpected', left)
    === hashRecord('IndependentRawPrimitiveRecomputationExpected', right);
}

function parseRawPrimitiveRows(bytes, cells, blockers) {
  if (!bytes?.length) {
    blockers.push('raw_primitive_artifact_empty');
    return [];
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) blockers.push('raw_primitive_artifact_utf8_invalid');
  if (!text.endsWith('\n')) blockers.push('raw_primitive_artifact_final_newline_missing');
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (lines.some((line) => line.length === 0)) blockers.push('raw_primitive_artifact_blank_row_forbidden');
  if (lines.length !== cells.length) blockers.push('raw_primitive_artifact_row_count_mismatch');
  const seen = new Set();
  return lines.map((line, index) => {
    if (Buffer.byteLength(line, 'utf8') > MAXIMUM_RAW_EVENT_LINE_BYTES) {
      blockers.push(`raw_primitive_artifact_line_size_limit_exceeded:${index + 1}`);
    }
    let document = null;
    try { document = JSON.parse(line); } catch { blockers.push(`raw_primitive_artifact_json_invalid:${index + 1}`); }
    const cell = cells[index] || null;
    if (!hasExactObjectKeys(document, RAW_PRIMITIVE_ROW_KEYS)
      || document?.version !== 2
      || document?.kind !== 'SystemBenchmarkCellRawPrimitiveArtifact'
      || typeof document?.cellId !== 'string'
      || typeof document?.seed !== 'number' || !Number.isSafeInteger(document.seed)
      || typeof document?.repetition !== 'number' || !Number.isSafeInteger(document.repetition)
      || typeof document?.arm !== 'string'
      || typeof document?.systemBenchmarkCellChallengeHash !== 'string'
      || typeof document?.systemBenchmarkCellOracleHash !== 'string'
      || !Array.isArray(document?.responses) || document.responses.length !== 8
      || !Array.isArray(document?.events) || document.events.length < 2
      || document.events.length > MAXIMUM_RAW_EVENTS_PER_CELL) {
      blockers.push(`raw_primitive_artifact_schema_invalid:${index + 1}`);
    }
    if (document && JSON.stringify(document) !== line) {
      blockers.push(`raw_primitive_artifact_canonical_json_required:${index + 1}`);
    }
    if (!cell || document?.cellId !== cell.cellId
      || document?.seed !== cell.seed
      || document?.repetition !== cell.repetition
      || document?.arm !== cell.arm
      || document?.systemBenchmarkCellChallengeHash !== cell.systemBenchmarkCellChallengeHash
      || document?.systemBenchmarkCellOracleHash !== cell.systemBenchmarkCellOracleHash) {
      blockers.push(`raw_primitive_artifact_cell_binding_invalid:${document?.cellId || index + 1}`);
    }
    if (seen.has(document?.cellId)) blockers.push(`raw_primitive_artifact_cell_duplicate:${document?.cellId || index + 1}`);
    seen.add(document?.cellId);
    return Object.freeze({ cellId: document?.cellId || null, document, line: `${line}\n` });
  });
}

function boundChallenge(harnessReceipt, cell) {
  const batches = (harnessReceipt?.armBatchExecutions || [])
    .filter((candidate) => candidate?.cellIds?.includes(cell?.cellId));
  if (batches.length !== 1) return null;
  const challenge = decodeIndependentSystemBenchmarkArmBatchChallenge(
    batches[0]?.runnerReceipt?.executionBindings || {},
  );
  return challenge?.cells?.find((candidate) => candidate.cellId === cell?.cellId)?.challenge || null;
}

function canonicalPrimitiveLine(document, cell, fixture) {
  const responseField = fixture?.challenge?.responseField;
  const eventFields = cell?.armProtocol?.rawEventFields || [];
  const normalized = {
    version: 2,
    kind: 'SystemBenchmarkCellRawPrimitiveArtifact',
    cellId: document?.cellId,
    seed: document?.seed,
    repetition: document?.repetition,
    arm: document?.arm,
    systemBenchmarkCellChallengeHash: document?.systemBenchmarkCellChallengeHash,
    systemBenchmarkCellOracleHash: document?.systemBenchmarkCellOracleHash,
    responses: (document?.responses || []).map((response) => ({
      caseId: response?.caseId,
      [responseField]: response?.[responseField],
    })),
    events: (document?.events || []).map((event) => Object.fromEntries(
      eventFields.map((field) => [field, event?.[field]]),
    )),
  };
  return `${JSON.stringify(normalized)}\n`;
}

function primitiveRecomputation({ rows, cells, harnessReceipt, experimentRunReceipt, resolver, blockers }) {
  const initialBlockerCount = blockers.length;
  const resolutionContext = {};
  const rowById = new Map(rows.map((row) => [row.cellId, row]));
  const recomputedRows = [];
  const primitiveCells = [];
  for (const cell of cells) {
    const row = rowById.get(cell.cellId) || null;
    let resolution = null;
    try { resolution = resolver({ experimentRunReceipt, cell, resolutionContext }); }
    catch { blockers.push(`primitive_fixture_resolution_failed:${cell.cellId}`); }
    blockers.push(...(resolution?.blockers || []).map((item) => `primitive_fixture:${cell.cellId}:${item}`));
    const executedChallenge = boundChallenge(harnessReceipt, cell);
    const fixture = verifyIndependentFixtureBinding({
      protocol: cell.armProtocol,
      seed: cell.seed,
      repetition: cell.repetition,
      executedChallenge,
      executedOracleHash: row?.document?.systemBenchmarkCellOracleHash,
      operatorDatasetHarnessDefinition: resolution?.operatorDatasetHarnessDefinition || null,
    });
    blockers.push(...fixture.blockers.map((item) => `independent_fixture:${cell.cellId}:${item}`));
    if (resolution?.status !== 'system_benchmark_primitive_fixture_resolved'
      || fixture.valid !== true
      || fixture.challenge?.systemBenchmarkCellChallengeHash !== row?.document?.systemBenchmarkCellChallengeHash
      || fixture.challenge?.systemBenchmarkCellChallengeHash !== cell.systemBenchmarkCellChallengeHash
      || fixture.oracle?.systemBenchmarkCellOracleHash !== row?.document?.systemBenchmarkCellOracleHash
      || fixture.oracle?.systemBenchmarkCellOracleHash !== cell.systemBenchmarkCellOracleHash) {
      blockers.push(`primitive_fixture_binding_invalid:${cell.cellId}`);
    }
    if (row?.line && fixture && row.line !== canonicalPrimitiveLine(row.document, cell, fixture)) {
      blockers.push(`raw_primitive_artifact_canonical_json_required:${cell.cellId}`);
    }
    if (fixture && (row?.document?.responses || []).some((response, index) => (
      response?.caseId !== fixture.challenge.cases[index]?.caseId
    ))) blockers.push(`primitive_response_order_invalid:${cell.cellId}`);
    const evaluated = fixture.valid ? independentlyEvaluateSystemBenchmarkCellResponses({
      protocol: cell.armProtocol,
      challenge: fixture.challenge,
      oracle: fixture.oracle,
      responses: row?.document?.responses,
    }) : null;
    blockers.push(...(evaluated?.blockers || []).map((item) => `primitive_response:${cell.cellId}:${item}`));
    if (evaluated?.status !== 'independent_response_evaluation_verified'
      || !same(evaluated?.events, row?.document?.events)) {
      blockers.push(`primitive_event_response_mismatch:${cell.cellId}`);
    }
    const recomputedDocument = row?.document ? {
      ...row.document,
      events: evaluated?.events || [],
    } : null;
    recomputedRows.push(Object.freeze({ cellId: cell.cellId, document: recomputedDocument, line: row?.line || '' }));
    primitiveCells.push(Object.freeze({
      cellId: cell.cellId,
      fixtureAuthority: resolution?.fixtureAuthority || null,
      systemBenchmarkCellChallengeHash: fixture?.challenge?.systemBenchmarkCellChallengeHash || null,
      systemBenchmarkCellOracleHash: fixture?.oracle?.systemBenchmarkCellOracleHash || null,
      candidateResponsesHash: hashRecord('SystemBenchmarkCandidateResponses', row?.document?.responses || null),
      persistedDerivedEventsHash: hashRecord('SystemBenchmarkDerivedEvents', row?.document?.events || null),
      recomputedDerivedEventsHash: hashRecord('SystemBenchmarkDerivedEvents', evaluated?.events || null),
      operatorDatasetAuthorityVerificationHash: resolution?.operatorDatasetAuthorityVerificationHash || null,
      operatorDatasetPrivateDefinitionResolutionHash:
        resolution?.operatorDatasetPrivateDefinitionResolutionHash || null,
      systemBenchmarkPrimitiveFixtureResolutionHash:
        resolution?.systemBenchmarkPrimitiveFixtureResolutionHash || null,
      recomputationIndependenceContractHash:
        RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT.rawEventRecomputationIndependenceContractHash,
    }));
  }
  if (rowById.size !== cells.length) blockers.push('raw_primitive_artifact_row_bijection_invalid');
  const primitiveBlockers = [...new Set(blockers.slice(initialBlockerCount))];
  const payload = {
    version: 1,
    kind: 'RawPrimitiveRecomputationManifest',
    status: primitiveBlockers.length
      ? 'raw_primitive_recomputation_blocked'
      : 'raw_primitive_recomputation_verified',
    cells: Object.freeze(primitiveCells),
    blockers: Object.freeze(primitiveBlockers),
  };
  return Object.freeze({
    recomputedRows: Object.freeze(recomputedRows),
    manifest: Object.freeze({
      ...payload,
      rawPrimitiveRecomputationManifestHash: hashRecord('RawPrimitiveRecomputationManifest', payload),
    }),
  });
}

export function verifyIndependentRawEventArtifactRecomputation({
  receipt,
  experimentRunReceipt,
  executionRole,
  primitiveFixtureResolver = null,
} = {}) {
  const blockers = [];
  if (!EXECUTION_ROLES.has(executionRole)) blockers.push('raw_event_recomputation_execution_role_invalid');
  if (!verifyExperimentRunReceipt(experimentRunReceipt)) blockers.push('raw_event_recomputation_run_receipt_invalid');
  const sourceVerification = verifyArtifactWriteReceiptSource({ receipt });
  blockers.push(...sourceVerification.blockers.map((item) => `raw_event_source:${item}`));
  if (receipt?.writeReceiptHash !== experimentRunReceipt?.rawArtifactWriteReceipt?.writeReceiptHash
    || receipt?.ledgerReceiptId !== experimentRunReceipt?.rawArtifactWriteReceipt?.ledgerReceiptId
    || receipt?.hash !== experimentRunReceipt?.rawEventArtifactHash
    || receipt?.bytes !== experimentRunReceipt?.rawEventArtifactBytes) {
    blockers.push('raw_event_recomputation_receipt_binding_invalid');
  }
  const readReceipt = readScopedFileSync({
    scopeRoot: receipt?.scopeRoot,
    candidate: path.resolve(String(receipt?.scopeRoot || ''), String(receipt?.path || '')),
    maximumBytes: MAXIMUM_RAW_EVENT_BYTES,
  });
  blockers.push(...readReceipt.blockers.map((item) => `raw_event_read:${item}`));
  if (readReceipt.hash !== receipt?.hash || readReceipt.bytes !== receipt?.bytes) {
    blockers.push('raw_event_recomputation_read_binding_invalid');
  }
  const harnessReceipt = experimentRunReceipt?.harnessExecutionReceipt || null;
  const cells = Array.isArray(harnessReceipt?.cells) ? harnessReceipt.cells : [];
  const design = harnessReceipt?.benchmarkSelector?.experimentDesign || null;
  const rows = readReceipt.content ? parseRawPrimitiveRows(readReceipt.content, cells, blockers) : [];
  const resolver = primitiveFixtureResolver || createSystemBenchmarkPrimitiveFixtureResolver();
  const primitive = primitiveRecomputation({
    rows,
    cells,
    harnessReceipt,
    experimentRunReceipt,
    resolver,
    blockers,
  });
  blockers.push(...primitive.manifest.blockers);
  const recomputationManifest = buildIndependentRawEventRecomputationManifest({
    cells,
    rawEventRows: primitive.recomputedRows,
    requiredMetrics: design?.requiredMetrics || [],
    metricSpecs: design?.metricSpecs || {},
  });
  blockers.push(...recomputationManifest.blockers.map((item) => `raw_event_recomputation:${item}`));
  if (!same(recomputationManifest, harnessReceipt?.rawEventRecomputationManifest)) {
    blockers.push('raw_event_recomputation_manifest_mismatch');
  }
  const privateAuthorityHashes = [...new Set(primitive.manifest.cells
    .map((cell) => cell.operatorDatasetAuthorityVerificationHash)
    .filter(Boolean))];
  const academic = experimentRunReceipt?.academicPromotionEligible === true;
  if (academic && (privateAuthorityHashes.length !== 1
    || privateAuthorityHashes[0] !== harnessReceipt?.operatorDatasetHarnessAuthority
      ?.operatorDatasetAuthorityVerificationHash)) {
    blockers.push('raw_primitive_private_authority_verification_invalid');
  }
  const uniqueBlockers = [...new Set(blockers)];
  const payload = {
    version: 2,
    kind: 'IndependentRawEventArtifactRecomputationVerification',
    status: uniqueBlockers.length
      ? 'independent_raw_event_recomputation_blocked'
      : 'independent_raw_event_recomputation_verified',
    assuranceScope: 'persisted-cas-repository-separate-recomputation-same-process-v3',
    dataSourceIndependent: true,
    implementationIndependent: true,
    independentExecutionClaimed: false,
    recomputationIndependenceLevel: RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT.level,
    rawEventRecomputationIndependenceContractHash:
      RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT.rawEventRecomputationIndependenceContractHash,
    recomputationIndependenceContract: RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT,
    executionRole: EXECUTION_ROLES.has(executionRole) ? executionRole : null,
    experimentRunReceiptHash: experimentRunReceipt?.experimentRunReceiptHash || null,
    artifactWriteReceiptHash: receipt?.writeReceiptHash || null,
    artifactLedgerReceiptId: receipt?.ledgerReceiptId || null,
    rawEventArtifactHash: receipt?.hash || null,
    rawEventArtifactBytes: Number.isSafeInteger(receipt?.bytes) ? receipt.bytes : null,
    artifactSourceVerificationHash: sourceVerification.artifactWriteReceiptSourceVerificationHash,
    scopedFileReadReceiptHash: readReceipt.scopedFileReadReceiptHash,
    primitiveRecomputationStatus: primitive.manifest.status,
    rawPrimitiveRecomputationManifestHash: primitive.manifest.rawPrimitiveRecomputationManifestHash,
    primitiveRecomputationManifest: primitive.manifest,
    rawEventRecomputationManifestHash: recomputationManifest.rawEventRecomputationManifestHash,
    recomputationManifest,
    operatorDatasetAuthorityVerificationHash: privateAuthorityHashes[0] || null,
    promotionTcbImplementationHash:
      SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash,
    assurance: Object.freeze({
      scope: 'post-persistence-raw-primitive-artifact-recomputation-v3',
      dataSource: 'independent-cas-reread-of-persisted-candidate-responses-and-derived-events',
      implementation: 'repository-separate-fixture-response-and-metric-recomputation-implementation-v1',
      execution: 'not-independently-executed',
      dataSourceIndependent: true,
      implementationShared: false,
      implementationIndependent: true,
      processIndependent: false,
      independentExecutionClaimed: false,
      rawOraclePublished: false,
    }),
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    independentRawEventArtifactRecomputationVerificationHash: hashRecord(
      'IndependentRawEventArtifactRecomputationVerification',
      payload,
    ),
  });
}

export function createIndependentRawEventArtifactRecomputationVerifier({
  runtimeRoot = null,
  trustStoreProvider = null,
  clock = null,
} = {}) {
  const primitiveFixtureResolver = createSystemBenchmarkPrimitiveFixtureResolver({
    runtimeRoot,
    trustStoreProvider,
    clock,
  });
  return (input = {}) => verifyIndependentRawEventArtifactRecomputation({
    ...input,
    primitiveFixtureResolver,
  });
}
