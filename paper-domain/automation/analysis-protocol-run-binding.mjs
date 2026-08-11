import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION } from './system-benchmark-harness-identity.mjs';
import {
  buildAnalysisProtocolReplayBinding,
  buildRepositoryAnalysisObservationAuthority,
  evaluateAnalysisProtocol,
  verifyAnalysisProtocolEvaluation,
  verifyAnalysisProtocolReplayBinding,
} from './analysis-protocol-evaluator.mjs';
import { evaluateSystemBenchmarkArmRawObservation } from './system-benchmark-arm-protocol.mjs';
import {
  autonomousEmpiricalFamilyPluginProfileFor,
} from './autonomous-empirical-family-plugin-registry.mjs';
import {
  buildTypedNumericOracleCertificate,
  buildTypedNumericOracleCertificateSet,
} from '../research/typed-numeric-oracle-certificate.mjs';
import {
  buildTypedNumericOracleProduction,
  verifyTypedNumericOracleProduction,
} from '../research/typed-numeric-oracle-production.mjs';
import {
  verifyIndependentTypedNumericOracleRecomputation,
} from '../research/independent-typed-numeric-oracle-recomputation.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

function processIsolatedRecomputationEvidenceValid(independent) {
  const assurance = independent?.processIsolatedRawEventRecomputationAssurance;
  const worker = assurance?.workerReceipt;
  if (!assurance
    || assurance.version !== 1
    || assurance.kind !== 'ProcessIsolatedRawEventRecomputationAssurance'
    || assurance.status !== 'process_isolated_raw_event_recomputation_verified'
    || assurance.assuranceScope !== 'process-isolated-independent-implementation-v1'
    || assurance.processIndependent !== true
    || assurance.networkActionPerformed !== false
    || assurance.externalActionPerformed !== false
    || !Array.isArray(assurance.blockers) || assurance.blockers.length !== 0
    || !worker
    || worker.status !== 'process_isolated_raw_event_recomputation_verified'
    || worker.processIndependent !== true
    || worker.networkActionPerformed !== false
    || worker.externalActionPerformed !== false
    || worker.workerPid === worker.parentPid
    || assurance.workerPid !== worker.workerPid
    || assurance.parentPid !== worker.parentPid
    || assurance.workerReceiptHash
      !== worker.processIsolatedRawEventRecomputationWorkerReceiptHash
    || assurance.rawEventRecomputationManifestHash
      !== worker.rawEventRecomputationManifestHash
    || assurance.workerImplementationHash !== worker.workerImplementationHash
    || assurance.workerImplementationSourceHash
      !== worker.workerImplementationSourceHash) return false;
  const {
    processIsolatedRawEventRecomputationWorkerReceiptHash: workerHash,
    ...workerPayload
  } = worker;
  const {
    processIsolatedRawEventRecomputationAssuranceHash: assuranceHash,
    ...assurancePayload
  } = assurance;
  return SHA256.test(String(workerHash || ''))
    && hashRecord('ProcessIsolatedRawEventRecomputationWorkerReceipt', workerPayload)
      === workerHash
    && SHA256.test(String(assuranceHash || ''))
    && hashRecord('ProcessIsolatedRawEventRecomputationAssurance', assurancePayload)
      === assuranceHash;
}

function rawObservationAuthorityFacts(receipt) {
  const cells = receipt?.cells || [];
  const rawEventManifest = cells.map((cell) => ({
    cellId: cell.cellId,
    rawEventArtifactHash: cell.rawEventArtifactHash,
    rawEventCount: cell.rawEventCount,
    systemBenchmarkCellChallengeHash: cell.systemBenchmarkCellChallengeHash,
    systemBenchmarkCellOracleHash: cell.systemBenchmarkCellOracleHash,
  }));
  const propertyOracleVerified = receipt?.systemBenchmarkHarnessImplementationHash
      === SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash
    && cells.length === receipt?.scheduleCellCount
    && cells.every((cell) => SHA256.test(String(cell.systemBenchmarkCellChallengeHash || ''))
      && SHA256.test(String(cell.systemBenchmarkCellOracleHash || ''))
      && cell.metricComputation === cell.armProtocol?.evaluatorId
      && cell.systemBenchmarkArmProtocolHash === cell.armProtocol?.systemBenchmarkArmProtocolHash);
  const recomputation = receipt?.rawEventRecomputationManifest || null;
  const recomputationPayload = recomputation ? { ...recomputation } : null;
  if (recomputationPayload) delete recomputationPayload.rawEventRecomputationManifestHash;
  const rawObservationRecomputationVerified = propertyOracleVerified
    && receipt.rawEventManifestHash === hashRecord('SystemBenchmarkRawEventManifest', rawEventManifest)
    && SHA256.test(String(receipt?.versionedExperimentIrHash || ''))
    && cells.every((cell) => cell.versionedExperimentIrHash
      === receipt.versionedExperimentIrHash)
    && recomputation?.versionedExperimentIrHash
      === receipt.versionedExperimentIrHash
    && recomputation?.status === 'raw_event_recomputation_verified'
    && SHA256.test(String(recomputation?.rawEventRecomputationManifestHash || ''))
    && hashRecord('RawEventRecomputationManifest', recomputationPayload) === recomputation.rawEventRecomputationManifestHash
    && recomputation.cells?.length === cells.length
    && cells.every((cell) => {
      const recomputed = recomputation.cells.find((candidate) => candidate.cellId === cell.cellId);
      const expected = hashRecord('SystemBenchmarkArmProtocolExecutionReceipt', {
        cellId: cell.cellId,
        systemBenchmarkArmProtocolHash: cell.systemBenchmarkArmProtocolHash,
        systemBenchmarkArmAdapterHash: cell.armAdapter?.sourceHash || null,
        armBatchExecutionReceiptHash: cell.armBatchExecutionReceiptHash,
        systemBenchmarkCellChallengeHash: cell.systemBenchmarkCellChallengeHash,
        systemBenchmarkCellOracleHash: cell.systemBenchmarkCellOracleHash,
        rawEventArtifactHash: cell.rawEventArtifactHash,
        rawEventCount: cell.rawEventCount,
        metrics: cell.metrics,
        versionedExperimentIrHash: receipt.versionedExperimentIrHash,
      });
      return SHA256.test(String(cell.rawEventArtifactHash || ''))
        && Number.isSafeInteger(cell.rawEventCount) && cell.rawEventCount >= 2
        && recomputed?.rawEventArtifactHash === cell.rawEventArtifactHash
        && recomputed?.rawEventCount === cell.rawEventCount
        && hashRecord('RawEventRecomputedMetricsExpected', recomputed?.metrics)
          === hashRecord('RawEventRecomputedMetricsExpected', cell.metrics)
        && cell.systemBenchmarkArmProtocolExecutionReceiptHash === expected;
    });
  const independent = receipt?.independentRawEventRecomputationAssurance || null;
  const independentPayload = independent ? { ...independent } : null;
  if (independentPayload) {
    delete independentPayload.independentRawEventRecomputationAssuranceHash;
  }
  const independentResidualRecomputationVerified = rawObservationRecomputationVerified
    && [1, 2].includes(independent?.version)
    && independent?.kind === 'IndependentRawEventRecomputationAssurance'
    && independent?.status === 'independent_raw_event_recomputation_assurance_verified'
    && independent?.versionedExperimentIrHash
      === receipt.versionedExperimentIrHash
    && independent?.assuranceScope
      === 'process-isolated-independent-implementation-v1'
    && independent?.processIndependent === true
    && processIsolatedRecomputationEvidenceValid(independent)
    && independent?.producerManifestHash
      === recomputation?.rawEventRecomputationManifestHash
    && independent?.independentManifestHash
      === recomputation?.rawEventRecomputationManifestHash
    && independent?.producerImplementationHash
      === receipt?.systemBenchmarkHarnessImplementationHash
    && SHA256.test(String(independent?.verifierImplementationHash || ''))
    && independent.verifierImplementationHash
      !== independent.producerImplementationHash
    && independent?.verifierImplementationHash
      === independent?.processIsolatedRawEventRecomputationAssurance
        ?.workerImplementationHash
    && independent?.independenceContractHash
      === independent?.processIsolatedRawEventRecomputationAssurance
        ?.processIsolatedRawEventRecomputationAssuranceHash
    && Number(independent?.maximumAbsoluteResidual) === 0
    && Array.isArray(independent?.blockers) && independent.blockers.length === 0
    && SHA256.test(String(
      independent?.independentRawEventRecomputationAssuranceHash || '',
    ))
    && hashRecord('IndependentRawEventRecomputationAssurance', independentPayload)
      === independent.independentRawEventRecomputationAssuranceHash;
  return {
    propertyOracleVerified,
    rawObservationRecomputationVerified,
    independentResidualRecomputationVerified,
    rawEventRecomputationManifestHash: recomputation?.rawEventRecomputationManifestHash || null,
    independentRecomputationAssuranceHash:
      independent?.independentRawEventRecomputationAssuranceHash || null,
    independentVerifierImplementationHash:
      independent?.verifierImplementationHash || null,
    independentRecomputationAssuranceScope:
      independent?.assuranceScope || null,
    independentRecomputationProcessIndependent:
      independent?.processIndependent === true,
    aggregateResidual: Number(recomputation?.maximumAbsoluteResidual),
    toleranceSatisfied: rawObservationRecomputationVerified && Number(recomputation?.maximumAbsoluteResidual) === 0,
  };
}

export function buildRawEventRecomputationManifest({
  cells = [],
  rawEventRows = [],
  requiredMetrics = [],
  metricSpecs = {},
  versionedExperimentIrHash = null,
} = {}) {
  const rows = new Map(rawEventRows.map((row) => [row?.cellId, row]));
  const blockers = [];
  let maximumAbsoluteResidual = 0;
  const recomputedCells = cells.map((cell) => {
    const row = rows.get(cell.cellId);
    const line = String(row?.line || '');
    const evaluated = evaluateSystemBenchmarkArmRawObservation({
      protocol: cell.armProtocol,
      document: row?.document ? { version: 1, kind: 'CampaignBenchmarkCellRawEvents', events: row.document.events } : null,
      requiredMetrics,
      metricSpecs,
    });
    const rowHash = line ? hashBytes(line) : null;
    if (versionedExperimentIrHash
      && cell?.versionedExperimentIrHash !== versionedExperimentIrHash) {
      blockers.push(`raw_event_recomputation_experiment_ir_mismatch:${cell.cellId}`);
    }
    if (rowHash !== cell.rawEventArtifactHash) blockers.push(`raw_event_recomputation_artifact_mismatch:${cell.cellId}`);
    if (evaluated.status !== 'system_benchmark_arm_observation_computed') blockers.push(...evaluated.blockers.map((item) => `${item}:${cell.cellId}`));
    for (const metric of requiredMetrics) {
      const residual = Math.abs(Number(evaluated.metrics?.[metric]) - Number(cell.metrics?.[metric]));
      if (Number.isFinite(residual)) maximumAbsoluteResidual = Math.max(maximumAbsoluteResidual, residual);
      else blockers.push(`raw_event_recomputation_metric_invalid:${cell.cellId}:${metric}`);
    }
    if (evaluated.eventCount !== cell.rawEventCount) blockers.push(`raw_event_recomputation_count_mismatch:${cell.cellId}`);
    return Object.freeze({
      cellId: cell.cellId,
      rawEventArtifactHash: rowHash,
      rawEventCount: evaluated.eventCount,
      metrics: evaluated.metrics,
    });
  });
  if (rows.size !== cells.length) blockers.push('raw_event_recomputation_row_bijection_invalid');
  if (maximumAbsoluteResidual !== 0) blockers.push('raw_event_recomputation_residual_nonzero');
  const payload = {
    version: versionedExperimentIrHash ? 2 : 1,
    kind: 'RawEventRecomputationManifest',
    status: blockers.length ? 'raw_event_recomputation_blocked' : 'raw_event_recomputation_verified',
    cells: Object.freeze(recomputedCells),
    maximumAbsoluteResidual,
    blockers: Object.freeze([...new Set(blockers)]),
    ...(versionedExperimentIrHash ? { versionedExperimentIrHash } : {}),
  };
  return Object.freeze({ ...payload, rawEventRecomputationManifestHash: hashRecord('RawEventRecomputationManifest', payload) });
}

export function buildHarnessAnalysisObservationAuthority(receipt) {
  const observations = (receipt?.cells || []).map((cell) => ({
    seed: cell.seed, repetition: cell.repetition, arm: cell.arm, metrics: cell.metrics,
  }));
  const facts = rawObservationAuthorityFacts(receipt);
  const pluginProfile = autonomousEmpiricalFamilyPluginProfileFor(
    receipt?.benchmarkFamily
      || receipt?.benchmarkSelector?.experimentDesign?.benchmarkFamily,
  );
  let typedNumericOracleCertificateSet = null;
  let typedNumericOracleProduction = null;
  let typedNumericOracleRecomputationReceipt = null;
  if (pluginProfile && facts.propertyOracleVerified
    && facts.rawObservationRecomputationVerified
    && facts.independentResidualRecomputationVerified
    && SHA256.test(String(receipt?.analysisProtocolHash || ''))
    && SHA256.test(String(receipt?.rawEventManifestHash || ''))
    && SHA256.test(String(receipt?.rawEventArtifactHash || ''))
    && SHA256.test(String(facts.rawEventRecomputationManifestHash || ''))
    && SHA256.test(String(receipt?.sourceLineageHash || ''))
    && Number.isFinite(facts.aggregateResidual)) {
    const propertyEvidenceHash = hashRecord('SystemBenchmarkPropertyOracleEvidence', {
      rawEventManifestHash: receipt.rawEventManifestHash,
      cells: (receipt.cells || []).map((cell) => ({
        cellId: cell.cellId,
        systemBenchmarkCellChallengeHash: cell.systemBenchmarkCellChallengeHash,
        systemBenchmarkCellOracleHash: cell.systemBenchmarkCellOracleHash,
      })),
    });
    const certificates = [
      buildTypedNumericOracleCertificate({
        certificateId: `property-oracle:${propertyEvidenceHash.slice('sha256:'.length, 39)}`,
        oracleType: 'property-oracle-v1',
        subjectHash: receipt.rawEventManifestHash,
        quantity: 'property_oracle_verified',
        observedValue: 1,
        relation: 'interval',
        lowerBound: 1,
        upperBound: 1,
        unit: 'boolean-indicator',
        verifierId: 'repository-system-benchmark-property-oracle-v1',
        producerImplementationHash:
          SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash,
        verifierImplementationHash:
          SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash,
        verificationReceiptHash: propertyEvidenceHash,
        evidenceHashes: [receipt.rawEventManifestHash, propertyEvidenceHash],
        assuranceScope: 'producer-bound-self-check-v1',
      }),
      buildTypedNumericOracleCertificate({
        certificateId: `residual-bound:${facts.rawEventRecomputationManifestHash
          .slice('sha256:'.length, 39)}`,
        oracleType: 'residual-bound-v1',
        subjectHash: facts.rawEventRecomputationManifestHash,
        quantity: 'maximum_absolute_residual',
        observedValue: facts.aggregateResidual,
        relation: 'less-than-or-equal',
        upperBound: Number(receipt?.numericResidualMaximum
          ?? receipt?.analysisProtocol?.numericValidation?.residual?.maximumAbsoluteResidual
          ?? 1e-10),
        unit: 'absolute-metric-unit',
        verifierId: 'repository-independent-raw-event-recomputation-v1',
        producerImplementationHash:
          SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION.systemBenchmarkHarnessImplementationHash,
        verifierImplementationHash: facts.independentVerifierImplementationHash,
        verificationReceiptHash: facts.independentRecomputationAssuranceHash,
        evidenceHashes: [
          receipt.rawEventArtifactHash,
          facts.rawEventRecomputationManifestHash,
          facts.independentRecomputationAssuranceHash,
        ],
        assuranceScope: facts.independentRecomputationAssuranceScope,
      }),
    ];
    const advancedOracleTypes = pluginProfile.typedOracleKinds.filter((type) => (
      !['property-oracle-v1', 'residual-bound-v1'].includes(type)
    ));
    let processRecomputationVerified = false;
    if (advancedOracleTypes.length && receipt?.analysisProtocol) {
      const productionInputs = {
        observations,
        analysisProtocol: receipt.analysisProtocol,
        pluginProfile,
        experimentIr: receipt?.experimentIr
          || receipt?.analysisObservationAuthority?.experimentIr
          || null,
      };
      const expectedProduction = buildTypedNumericOracleProduction(productionInputs);
      const suppliedProduction = receipt?.typedNumericOracleProduction
        || receipt?.analysisObservationAuthority?.typedNumericOracleProduction
        || null;
      const suppliedRecomputation = receipt?.typedNumericOracleRecomputationReceipt
        || receipt?.analysisObservationAuthority?.typedNumericOracleRecomputationReceipt
        || null;
      typedNumericOracleProduction = verifyTypedNumericOracleProduction(
        suppliedProduction, productionInputs,
      ) ? suppliedProduction : expectedProduction;
      const recomputationInputs = {
        ...productionInputs,
        production: typedNumericOracleProduction,
      };
      processRecomputationVerified = Boolean(
        suppliedRecomputation?.version === 2
        && suppliedRecomputation?.assuranceScope
          === 'process-isolated-independent-implementation-v1'
        && suppliedRecomputation?.processIndependent === true
        && suppliedRecomputation?.networkGuardInstalled === true
        && suppliedRecomputation?.networkActionPerformed === false
        && suppliedRecomputation?.externalActionPerformed === false
        && verifyIndependentTypedNumericOracleRecomputation(
          suppliedRecomputation, recomputationInputs,
        ),
      );
      typedNumericOracleRecomputationReceipt = suppliedRecomputation;
      const comparisons = new Map(
        (processRecomputationVerified
          ? typedNumericOracleRecomputationReceipt.comparisons : [])
          .map((item) => [item.oracleType, item]),
      );
      for (const produced of typedNumericOracleProduction.outputs) {
        const comparison = comparisons.get(produced.oracleType);
        if (!comparison?.match) continue;
        certificates.push(buildTypedNumericOracleCertificate({
          version: 3,
          certificateId: `${produced.oracleType}:${produced
            .typedNumericOracleAlgorithmOutputHash.slice('sha256:'.length, 39)}`,
          oracleType: produced.oracleType,
          subjectHash: produced.numericInputManifestHash,
          quantity: produced.quantity,
          observedValue: produced.observedValue,
          relation: produced.relation,
          lowerBound: produced.lowerBound,
          upperBound: produced.upperBound,
          unit: produced.unit,
          verifierId: 'repository-independent-typed-numeric-oracle-v1',
          producerImplementationHash: typedNumericOracleProduction.producerImplementationHash,
          verifierImplementationHash:
            typedNumericOracleRecomputationReceipt.verifierImplementationHash,
          verificationReceiptHash:
            comparison.independentTypedNumericOracleComparisonHash,
          evidenceHashes: [
            receipt.rawEventArtifactHash,
            facts.independentRecomputationAssuranceHash,
            produced.typedNumericOracleAlgorithmOutputHash,
            typedNumericOracleRecomputationReceipt
              .independentTypedNumericOracleRecomputationHash,
          ],
          assuranceScope: 'process-isolated-independent-implementation-v1',
          algorithmId: produced.algorithmId,
          algorithmVersion: produced.algorithmVersion,
          algorithmConfigurationHash: produced.algorithmConfigurationHash,
          numericInputManifestHash: produced.numericInputManifestHash,
          finiteInputCount: produced.finiteInputCount,
          finiteInputsVerified: produced.finiteInputsVerified,
          boundsAuthorityHash: produced.boundsAuthorityHash,
        }));
      }
    }
    typedNumericOracleCertificateSet = buildTypedNumericOracleCertificateSet({
      analysisProtocolHash: receipt.analysisProtocolHash,
      experimentAttemptId: receipt.experimentAttemptId,
      sourceLineageHash: receipt.sourceLineageHash,
      requiredOracleTypes: pluginProfile.typedOracleKinds,
      certificates,
      ...(advancedOracleTypes.length ? {
        empiricalPluginProfileHash:
          pluginProfile.autonomousEmpiricalFamilyPluginProfileHash,
        independentRecomputationReceiptHash:
          processRecomputationVerified
            ? typedNumericOracleRecomputationReceipt
            ?.independentTypedNumericOracleRecomputationHash
            : hashRecord('TypedNumericOracleMissingRecomputation', {
              analysisProtocolHash: receipt.analysisProtocolHash,
            }),
      } : {}),
    });
  }
  return buildRepositoryAnalysisObservationAuthority({
    observations,
    rawEventManifestHash: receipt?.rawEventManifestHash,
    rawEventArtifactHash: receipt?.rawEventArtifactHash,
    ...facts,
    typedNumericOracleCertificateSet,
    typedNumericOracleProduction,
    typedNumericOracleRecomputationReceipt,
    empiricalPluginProfileHash:
      typedNumericOracleProduction
        ? pluginProfile?.autonomousEmpiricalFamilyPluginProfileHash : null,
    experimentIr: typedNumericOracleProduction
      ? (receipt?.experimentIr || receipt?.analysisObservationAuthority?.experimentIr || null)
      : null,
    experimentAttemptId: receipt?.experimentAttemptId,
    sourceLineageHash: receipt?.sourceLineageHash,
    analysisProtocol: receipt?.analysisProtocol || null,
    allowLegacyNonProduction: !receipt?.analysisProtocol,
  });
}

function expectedInputs(receipt, design) {
  const observations = (receipt?.cells || []).map((cell) => ({
    seed: cell.seed,
    repetition: cell.repetition,
    arm: cell.arm,
    metrics: cell.metrics,
  }));
  const analysisProtocol = {
    ...design.analysisProtocol,
    analysisProtocolHash: design.analysisProtocolHash,
  };
  const observationAuthority = buildHarnessAnalysisObservationAuthority(receipt);
  return {
    analysisProtocol,
    observations,
    observationAuthority,
    benchmarkId: receipt?.benchmarkId,
    benchmarkFamily: design.benchmarkFamily,
    requiredMetrics: design.requiredMetrics,
    metricSpecs: design.metricSpecs,
  };
}

function same(left, right) {
  return hashRecord('AnalysisProtocolBindingExpected', left)
    === hashRecord('AnalysisProtocolBindingExpected', right);
}

export function verifyHarnessOperatorAnalysisProtocolAuthority(receipt, design) {
  if (!design?.analysisProtocol || !design.analysisProtocolHash) return false;
  const datasetBacked = receipt?.benchmarkSelector?.selectorType
    === 'authorized_dataset_mount';
  const operatorAuthority = receipt?.operatorDatasetHarnessAuthority;
  if (!datasetBacked) return operatorAuthority === null;
  const operatorTemplateHash = design.analysisProtocolTemplateHash
    || design.analysisProtocolHash;
  const operatorTemplate = design.analysisProtocolTemplate
    || design.analysisProtocol;
  return operatorAuthority?.analysisProtocolHash === operatorTemplateHash
    && same(operatorAuthority?.analysisProtocol, operatorTemplate);
}

export function verifyHarnessAnalysisProtocolBinding(receipt, design) {
  if (!receipt || !design?.analysisProtocol || !design.analysisProtocolHash) return false;
  let inputs;
  let expected;
  try {
    inputs = expectedInputs(receipt, design);
    expected = evaluateAnalysisProtocol(inputs);
  } catch { return false; }
  if (expected.status !== 'academic_analysis_protocol_verified'
    || !verifyAnalysisProtocolEvaluation(receipt.analysisProtocolEvaluation, inputs)
    || !same(receipt.analysisProtocol, inputs.analysisProtocol)
    || receipt.analysisProtocolHash !== design.analysisProtocolHash
    || !same(receipt.analysisObservationAuthority, inputs.observationAuthority)
    || !same(receipt.analysisProtocolEvaluation, expected)) return false;
  return verifyHarnessOperatorAnalysisProtocolAuthority(receipt, design);
}

export function analysisProtocolResultDocumentFields(receipt) {
  return Object.freeze({
    analysisProtocol: receipt?.analysisProtocol || null,
    analysisProtocolHash: receipt?.analysisProtocolHash || null,
    analysisObservationAuthority: receipt?.analysisObservationAuthority || null,
    analysisProtocolEvaluation: receipt?.analysisProtocolEvaluation || null,
  });
}

export function buildExperimentRunAnalysisProtocolBinding({
  harnessExecutionReceipt,
  design,
  resultDocument,
} = {}) {
  const blockers = [];
  if (!verifyHarnessAnalysisProtocolBinding(harnessExecutionReceipt, design)) {
    blockers.push('experiment_analysis_protocol_harness_binding_invalid');
  }
  const fields = analysisProtocolResultDocumentFields(harnessExecutionReceipt);
  if (!same(fields, analysisProtocolResultDocumentFields(resultDocument))) {
    blockers.push('experiment_analysis_protocol_result_document_binding_invalid');
  }
  return Object.freeze({ blockers, fields });
}

export function verifyExperimentRunAnalysisProtocolBinding(receipt, design) {
  if (!verifyHarnessAnalysisProtocolBinding(receipt?.harnessExecutionReceipt, design)) return false;
  const expected = analysisProtocolResultDocumentFields(receipt.harnessExecutionReceipt);
  const actual = Object.freeze({
    analysisProtocol: receipt.analysisProtocol,
    analysisProtocolHash: receipt.analysisProtocolHash,
    analysisObservationAuthority: receipt.analysisObservationAuthority,
    analysisProtocolEvaluation: receipt.analysisProtocolEvaluation,
  });
  return same(actual, expected)
    && receipt.analysisProtocolHash === design.analysisProtocolHash
    && receipt.analysisProtocolEvaluation?.status === 'academic_analysis_protocol_verified';
}

export function buildExperimentReplayAnalysisProtocolBinding({ originalRunReceipt, replayRunReceipt } = {}) {
  return buildAnalysisProtocolReplayBinding({
    originalEvaluation: originalRunReceipt?.analysisProtocolEvaluation,
    replayEvaluation: replayRunReceipt?.analysisProtocolEvaluation,
  });
}

export function verifyExperimentReplayAnalysisProtocolBinding(receipt) {
  const rebuilt = buildExperimentReplayAnalysisProtocolBinding({
    originalRunReceipt: receipt?.originalRunReceipt,
    replayRunReceipt: receipt?.replayRunReceipt,
  });
  return verifyAnalysisProtocolReplayBinding(receipt?.analysisProtocolReplayBinding)
    && rebuilt.status === 'academic_analysis_protocol_replay_verified'
    && rebuilt.academicAnalysisProtocolReplayBindingHash
      === receipt.analysisProtocolReplayBinding.academicAnalysisProtocolReplayBindingHash;
}
