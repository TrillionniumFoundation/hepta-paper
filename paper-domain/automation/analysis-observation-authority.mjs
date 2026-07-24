import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyTypedNumericOracleCertificateSet } from '../research/typed-numeric-oracle-certificate.mjs';
import { verifyTypedNumericOracleProduction } from '../research/typed-numeric-oracle-production.mjs';
import { verifyIndependentTypedNumericOracleRecomputation } from '../research/independent-typed-numeric-oracle-recomputation.mjs';
import {
  buildTypedNumericOracleTupleManifest,
  verifyProcessIsolatedTypedNumericOracleRecomputationReceiptShape,
  verifyTypedNumericOracleWorkerImplementation,
} from '../research/process-isolated-typed-numeric-oracle-recomputation-contract.mjs';
import { autonomousEmpiricalFamilyPluginProfileFor } from './autonomous-empirical-family-plugin-registry.mjs';
import { verifyVersionedExperimentIr } from './versioned-experiment-ir.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const ARMS = Object.freeze(['treatment', 'baseline', 'ablation']);
const CORE_ORACLE_TYPES = new Set(['property-oracle-v1', 'residual-bound-v1']);

function advancedOracleTypes(certificateSet) {
  return [...new Set([
    ...(certificateSet?.requiredOracleTypes || []),
    ...(certificateSet?.verifiedOracleTypes || []),
    ...(certificateSet?.certificates || []).map((certificate) => certificate?.oracleType),
  ].filter((oracleType) => !CORE_ORACLE_TYPES.has(oracleType)))].sort();
}

function advancedAuthorityOracleTypes(certificateSet, pluginProfile) {
  return [...new Set([
    ...advancedOracleTypes(certificateSet),
    ...(pluginProfile?.typedOracleKinds || []).filter((oracleType) => (
      !CORE_ORACLE_TYPES.has(oracleType)
    )),
  ])].sort();
}

function recordHashMatches(record, hashField, recordKind) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !SHA256.test(String(record[hashField] || ''))) return false;
  const { [hashField]: observedHash, ...payload } = record;
  return hashRecord(recordKind, payload) === observedHash;
}

export function analysisObservationManifestHash(observations) {
  return hashRecord('AnalysisProtocolObservationManifest', observations);
}

function verifyTypedNumericOracleProductionEvidenceBindingValue({
  certificateSet,
  production,
  recomputation,
  pluginProfile,
  observations,
  analysisProtocol,
  experimentIr,
} = {}) {
  if (!Array.isArray(pluginProfile?.typedOracleKinds)
    || !Array.isArray(certificateSet?.certificates)
    || !Array.isArray(certificateSet?.requiredOracleTypes)
    || !Array.isArray(certificateSet?.verifiedOracleTypes)
    || !Array.isArray(production?.requestedOracleTypes)
    || !Array.isArray(production?.producedOracleTypes)
    || !Array.isArray(production?.outputs)
    || !Array.isArray(recomputation?.comparisons)
    || !Array.isArray(observations)) {
    return false;
  }
  const canonicalProfile = autonomousEmpiricalFamilyPluginProfileFor(
    pluginProfile.benchmarkFamily,
  );
  const profileOracleTypes = [...(pluginProfile?.typedOracleKinds || [])].sort();
  const requestedAdvancedTypes = profileOracleTypes.filter((oracleType) => (
    !CORE_ORACLE_TYPES.has(oracleType)
  ));
  const productionTypes = [...(production?.requestedOracleTypes || [])].sort();
  const producedTypes = [...(production?.producedOracleTypes || [])].sort();
  const outputTypes = [...(production?.outputs || [])]
    .map((output) => output?.oracleType).sort();
  const recomputationTypes = [...(recomputation?.comparisons || [])]
    .map((comparison) => comparison?.oracleType).sort();
  const certificateTypes = [...(certificateSet?.certificates || [])]
    .map((certificate) => certificate?.oracleType).sort();
  const tupleManifest = buildTypedNumericOracleTupleManifest({
    production,
    recomputation: recomputation.recomputation,
  });
  const workerReceipt = recomputation.workerReceipt;
  const productionInputs = {
    observations: canonicalAuthorityObservations(observations),
    analysisProtocol,
    pluginProfile,
    experimentIr,
  };
  if (!certificateSet || !production || !recomputation || !pluginProfile
    || JSON.stringify(canonicalProfile) !== JSON.stringify(pluginProfile)
    || analysisProtocol?.benchmarkFamily !== pluginProfile.benchmarkFamily
    || !verifyVersionedExperimentIr(experimentIr, { profile: pluginProfile })
    || !verifyTypedNumericOracleProduction(production, productionInputs)
    || !verifyIndependentTypedNumericOracleRecomputation(
      recomputation, { ...productionInputs, production },
    )
    || !requestedAdvancedTypes.length
    || production.version !== 2
    || production.kind !== 'TypedNumericOracleProduction'
    || production.status !== 'typed_numeric_oracle_production_verified'
    || production.finiteInputsVerified !== true
    || production.candidateAuthoredValuesAccepted !== false
    || !Array.isArray(production.blockers) || production.blockers.length !== 0
    || !recordHashMatches(
      production, 'typedNumericOracleProductionHash', 'TypedNumericOracleProduction',
    )
    || production.outputs.some((output) => !recordHashMatches(
      output, 'typedNumericOracleAlgorithmOutputHash', 'TypedNumericOracleAlgorithmOutput',
    ))
    || !verifyProcessIsolatedTypedNumericOracleRecomputationReceiptShape(recomputation)
    || recomputation.status !== 'independent_typed_numeric_oracle_recomputation_verified'
    || !Array.isArray(recomputation.blockers) || recomputation.blockers.length !== 0
    || !recordHashMatches(
      recomputation,
      'independentTypedNumericOracleRecomputationHash',
      'IndependentTypedNumericOracleRecomputation',
    )
    || !recordHashMatches(
      recomputation.recomputation,
      'independentTypedNumericOracleRecomputationHash',
      'IndependentTypedNumericOracleRecomputation',
    )
    || recomputation.comparisons.some((comparison) => !recordHashMatches(
      comparison,
      'independentTypedNumericOracleComparisonHash',
      'IndependentTypedNumericOracleComparison',
    ))
    || JSON.stringify(recomputation.comparisons)
      !== JSON.stringify(recomputation.recomputation?.comparisons)
    || JSON.stringify(recomputation.numericTupleManifest) !== JSON.stringify(tupleManifest)
    || recomputation.numericTupleManifestHash !== tupleManifest.numericTupleManifestHash
    || !verifyTypedNumericOracleWorkerImplementation(recomputation.workerImplementation)
    || !recordHashMatches(
      workerReceipt,
      'workerReceiptHash',
      'ProcessIsolatedTypedNumericOracleWorkerReceipt',
    )
    || workerReceipt?.requestHash !== recomputation.requestHash
    || workerReceipt?.recomputationHash
      !== recomputation.recomputation?.independentTypedNumericOracleRecomputationHash
    || JSON.stringify(workerReceipt?.recomputation)
      !== JSON.stringify(recomputation.recomputation)
    || JSON.stringify(workerReceipt?.numericTupleManifest)
      !== JSON.stringify(tupleManifest)
    || workerReceipt?.numericTupleManifestHash !== tupleManifest.numericTupleManifestHash
    || workerReceipt?.workerImplementationHash !== recomputation.workerImplementationHash
    || JSON.stringify(workerReceipt?.workerImplementation)
      !== JSON.stringify(recomputation.workerImplementation)
    || workerReceipt?.workerReceiptHash !== recomputation.workerReceiptHash
    || workerReceipt?.workerPid !== recomputation.workerPid
    || workerReceipt?.parentPid !== recomputation.parentPid
    || !Array.isArray(workerReceipt?.blockers) || workerReceipt.blockers.length !== 0
    || !verifyTypedNumericOracleCertificateSet(certificateSet)
    || productionTypes.join('\0') !== requestedAdvancedTypes.join('\0')
    || producedTypes.join('\0') !== requestedAdvancedTypes.join('\0')
    || outputTypes.join('\0') !== requestedAdvancedTypes.join('\0')
    || recomputationTypes.join('\0') !== requestedAdvancedTypes.join('\0')
    || certificateTypes.join('\0') !== profileOracleTypes.join('\0')
    || certificateSet.requiredOracleTypes.join('\0') !== profileOracleTypes.join('\0')
    || certificateSet.verifiedOracleTypes.join('\0') !== profileOracleTypes.join('\0')
    || production.empiricalPluginProfileHash
      !== pluginProfile.autonomousEmpiricalFamilyPluginProfileHash
    || recomputation.empiricalPluginProfileHash
      !== pluginProfile.autonomousEmpiricalFamilyPluginProfileHash
    || production.analysisProtocolHash !== recomputation.analysisProtocolHash
    || recomputation.version !== 2
    || recomputation.assuranceScope
      !== 'process-isolated-independent-implementation-v1'
    || recomputation.processIndependent !== true
    || recomputation.independentlyRecomputed !== true
    || recomputation.networkGuardInstalled !== true
    || recomputation.networkActionPerformed !== false
    || recomputation.externalActionPerformed !== false
    || recomputation.workerPid === recomputation.parentPid
    || !SHA256.test(String(recomputation.requestHash || ''))
    || !SHA256.test(String(recomputation.workerImplementationSourceHash || ''))
    || !SHA256.test(String(recomputation.workerSourceClosureHash || ''))
    || !SHA256.test(String(recomputation.numericTupleManifestHash || ''))
    || certificateSet.empiricalPluginProfileHash
      !== pluginProfile.autonomousEmpiricalFamilyPluginProfileHash
    || certificateSet.independentRecomputationReceiptHash
      !== recomputation.independentTypedNumericOracleRecomputationHash
    || recomputation.productionHash !== production.typedNumericOracleProductionHash
    || recomputation.numericInputManifestHash !== production.numericInputManifestHash
    || certificateSet.analysisProtocolHash !== production.analysisProtocolHash
    || certificateSet.requiredOracleTypes.join('\0')
      !== [...pluginProfile.typedOracleKinds].sort().join('\0')
    || !SHA256.test(String(production.versionedExperimentIrHash || ''))
    || production.versionedExperimentIrHash !== recomputation.versionedExperimentIrHash) {
    return false;
  }
  const comparisons = new Map(recomputation.comparisons.map((item) => [item.oracleType, item]));
  const outputs = new Map(production.outputs.map((item) => [item.oracleType, item]));
  return production.requestedOracleTypes.every((oracleType) => {
    const certificate = certificateSet.certificates.find((item) => (
      item.oracleType === oracleType
    ));
    const comparison = comparisons.get(oracleType);
    const output = outputs.get(oracleType);
    return Boolean(certificate && certificate.version === 3 && comparison?.match && output
      && comparison.producerOutputHash === output.typedNumericOracleAlgorithmOutputHash
      && certificate.quantity === output.quantity
      && certificate.observedValue === output.observedValue
      && certificate.relation === output.relation
      && certificate.lowerBound === output.lowerBound
      && certificate.upperBound === output.upperBound
      && certificate.unit === output.unit
      && certificate.assuranceScope === recomputation.assuranceScope
      && certificate.processIndependent === true
      && certificate.producerImplementationHash === production.producerImplementationHash
      && certificate.verifierImplementationHash === recomputation.verifierImplementationHash
      && certificate.verificationReceiptHash
        === comparison.independentTypedNumericOracleComparisonHash
      && certificate.evidenceHashes.includes(output.typedNumericOracleAlgorithmOutputHash)
      && certificate.evidenceHashes.includes(
        recomputation.independentTypedNumericOracleRecomputationHash,
      )
      && certificate.algorithmId === output.algorithmId
      && certificate.algorithmVersion === output.algorithmVersion
      && certificate.algorithmConfigurationHash === output.algorithmConfigurationHash
      && certificate.numericInputManifestHash === output.numericInputManifestHash
      && certificate.finiteInputCount === output.finiteInputCount
      && certificate.finiteInputsVerified === output.finiteInputsVerified
      && certificate.boundsAuthorityHash === output.boundsAuthorityHash);
  });
}

export function verifyTypedNumericOracleProductionEvidenceBinding(inputs = {}) {
  try { return verifyTypedNumericOracleProductionEvidenceBindingValue(inputs); }
  catch { return false; }
}

function canonicalAuthorityObservations(observations) {
  return (Array.isArray(observations) ? observations : []).map((observation) => ({
    seed: Number(observation?.seed),
    repetition: Number(observation?.repetition),
    arm: String(observation?.arm || ''),
    metrics: Object.fromEntries(Object.entries(observation?.metrics || {}).map(
      ([key, value]) => [key, Number(value)],
    )),
  })).sort((left, right) => (
    left.seed - right.seed
      || left.repetition - right.repetition
      || ARMS.indexOf(left.arm) - ARMS.indexOf(right.arm)
  ));
}

export function buildRepositoryAnalysisObservationAuthority({
  observations = [],
  rawEventManifestHash,
  rawEventArtifactHash,
  propertyOracleVerified = true,
  rawObservationRecomputationVerified = true,
  rawEventRecomputationManifestHash = null,
  independentResidualRecomputationVerified = false,
  independentRecomputationAssuranceHash = null,
  independentVerifierImplementationHash = null,
  aggregateResidual = 0,
  toleranceSatisfied = true,
  candidateConvergenceClaim = null,
  candidateConditionNumber = null,
  typedNumericOracleCertificateSet = null,
  typedNumericOracleProduction = null,
  typedNumericOracleRecomputationReceipt = null,
  empiricalPluginProfileHash = null,
  experimentIr = null,
  experimentAttemptId = null,
  sourceLineageHash = null,
  analysisProtocol = null,
  allowLegacyNonProduction = false,
} = {}) {
  const pluginProfile = autonomousEmpiricalFamilyPluginProfileFor(
    analysisProtocol?.benchmarkFamily,
  );
  if (!pluginProfile && !typedNumericOracleCertificateSet && allowLegacyNonProduction !== true) {
    throw new Error('analysis_observation_legacy_nonproduction_opt_in_required');
  }
  if (pluginProfile) {
    const expectedOracleTypes = [...pluginProfile.typedOracleKinds].sort().join('\0');
    const residualCertificate = typedNumericOracleCertificateSet?.certificates?.find(
      (certificate) => certificate?.oracleType === 'residual-bound-v1',
    );
    if (!verifyTypedNumericOracleCertificateSet(
      typedNumericOracleCertificateSet,
      {
        analysisProtocolHash: analysisProtocol?.analysisProtocolHash,
        experimentAttemptId,
        sourceLineageHash,
      },
    )
      || typedNumericOracleCertificateSet?.requiredOracleTypes?.join('\0')
        !== expectedOracleTypes
      || typedNumericOracleCertificateSet?.verifiedOracleTypes?.join('\0')
        !== expectedOracleTypes
      || independentResidualRecomputationVerified !== true
      || !SHA256.test(String(independentRecomputationAssuranceHash || ''))
      || !SHA256.test(String(independentVerifierImplementationHash || ''))
      || residualCertificate?.assuranceScope
        !== 'process-isolated-independent-implementation-v1'
      || residualCertificate?.processIndependent !== true
      || residualCertificate?.verificationReceiptHash
        !== independentRecomputationAssuranceHash
      || residualCertificate?.verifierImplementationHash
        !== independentVerifierImplementationHash) {
      throw new Error('analysis_observation_canonical_numeric_evidence_required');
    }
  }
  const advancedTypes = advancedAuthorityOracleTypes(
    typedNumericOracleCertificateSet, pluginProfile,
  );
  if (advancedTypes.length) {
    const productionInputs = {
      observations: canonicalAuthorityObservations(observations),
      analysisProtocol,
      pluginProfile,
      experimentIr,
    };
    if (!pluginProfile
      || !verifyTypedNumericOracleCertificateSet(
        typedNumericOracleCertificateSet,
        {
          analysisProtocolHash: analysisProtocol?.analysisProtocolHash,
          experimentAttemptId,
          sourceLineageHash,
        },
      )
      || typedNumericOracleProduction?.version !== 2
      || typedNumericOracleRecomputationReceipt?.version !== 2
      || !verifyVersionedExperimentIr(experimentIr, { profile: pluginProfile })
      || empiricalPluginProfileHash
        !== pluginProfile.autonomousEmpiricalFamilyPluginProfileHash
      || typedNumericOracleCertificateSet?.empiricalPluginProfileHash
        !== empiricalPluginProfileHash
      || typedNumericOracleCertificateSet?.analysisProtocolHash
        !== analysisProtocol?.analysisProtocolHash
      || typedNumericOracleProduction?.analysisProtocolHash
        !== analysisProtocol?.analysisProtocolHash
      || typedNumericOracleRecomputationReceipt?.analysisProtocolHash
        !== analysisProtocol?.analysisProtocolHash
      || experimentIr?.versionedExperimentIrHash
        !== typedNumericOracleProduction?.versionedExperimentIrHash
      || experimentIr?.versionedExperimentIrHash
        !== typedNumericOracleRecomputationReceipt?.versionedExperimentIrHash
      || !verifyTypedNumericOracleProduction(
        typedNumericOracleProduction, productionInputs,
      )
      || !verifyIndependentTypedNumericOracleRecomputation(
        typedNumericOracleRecomputationReceipt,
        { ...productionInputs, production: typedNumericOracleProduction },
      )
      || !verifyTypedNumericOracleProductionEvidenceBinding({
        certificateSet: typedNumericOracleCertificateSet,
        production: typedNumericOracleProduction,
        recomputation: typedNumericOracleRecomputationReceipt,
        pluginProfile,
        observations,
        analysisProtocol,
        experimentIr,
      })) {
      throw new Error('analysis_observation_advanced_numeric_evidence_required');
    }
  }
  const payload = {
    version: typedNumericOracleProduction ? 5 : (typedNumericOracleCertificateSet ? 3 : 1),
    kind: 'RepositoryAnalysisObservationAuthority',
    observationManifestHash: analysisObservationManifestHash(
      canonicalAuthorityObservations(observations),
    ),
    rawEventManifestHash: rawEventManifestHash || null,
    rawEventArtifactHash: rawEventArtifactHash || null,
    propertyOracleVerified,
    rawObservationRecomputationVerified,
    rawEventRecomputationManifestHash,
    ...(typedNumericOracleCertificateSet ? {
      independentResidualRecomputationVerified,
      independentRecomputationAssuranceHash,
      independentVerifierImplementationHash,
    } : {}),
    aggregateResidual: Number(aggregateResidual),
    toleranceSatisfied,
    candidateConvergenceClaim,
    candidateConditionNumber,
    ...(typedNumericOracleCertificateSet ? { typedNumericOracleCertificateSet } : {}),
    ...(typedNumericOracleProduction ? {
      typedNumericOracleProduction,
      typedNumericOracleRecomputationReceipt,
      empiricalPluginProfileHash,
      experimentIr,
    } : {}),
    experimentAttemptId: experimentAttemptId || null,
    sourceLineageHash: sourceLineageHash || null,
    agentAggregatesAccepted: false,
  };
  return Object.freeze({
    ...payload,
    analysisObservationAuthorityHash: hashRecord('RepositoryAnalysisObservationAuthority', payload),
  });
}

export function verifyRepositoryAnalysisObservationAuthority(
  authority,
  observations,
  protocol,
  blockers,
) {
  if (!authority || ![1, 3, 4, 5].includes(authority.version)
    || authority.kind !== 'RepositoryAnalysisObservationAuthority') {
    blockers.push('analysis_observation_authority_required');
    return;
  }
  const { analysisObservationAuthorityHash, ...payload } = authority;
  if (!SHA256.test(String(analysisObservationAuthorityHash || ''))
    || hashRecord('RepositoryAnalysisObservationAuthority', payload)
      !== analysisObservationAuthorityHash) {
    blockers.push('analysis_observation_authority_hash_invalid');
  }
  if (authority.observationManifestHash !== analysisObservationManifestHash(observations)) {
    blockers.push('analysis_observation_authority_manifest_mismatch');
  }
  if (!SHA256.test(String(authority.rawEventManifestHash || ''))
    || !SHA256.test(String(authority.rawEventArtifactHash || ''))) {
    blockers.push('analysis_observation_raw_event_authority_missing');
  }
  if (!String(authority.experimentAttemptId || '')
    || !SHA256.test(String(authority.sourceLineageHash || ''))) {
    blockers.push('analysis_observation_execution_lineage_missing');
  }
  if (authority.propertyOracleVerified !== true) {
    blockers.push('analysis_property_oracle_unverified');
  }
  if (authority.rawObservationRecomputationVerified !== true) {
    blockers.push('analysis_raw_observation_recomputation_unverified');
  }
  if (!SHA256.test(String(authority.rawEventRecomputationManifestHash || ''))) {
    blockers.push('analysis_raw_event_recomputation_manifest_missing');
  }
  if (!Number.isFinite(Number(authority.aggregateResidual))
    || Math.abs(Number(authority.aggregateResidual))
      > protocol.numericValidation.residual.maximumAbsoluteResidual) {
    blockers.push('analysis_numeric_residual_tolerance_exceeded');
  }
  if (authority.toleranceSatisfied !== true) blockers.push('analysis_numeric_tolerance_unsatisfied');
  if (authority.candidateConvergenceClaim !== null) {
    blockers.push('analysis_candidate_convergence_claim_not_authoritative');
  }
  if (authority.candidateConditionNumber !== null) {
    blockers.push('analysis_candidate_condition_claim_not_authoritative');
  }
  if (authority.version >= 3 && (authority.independentResidualRecomputationVerified !== true
    || !SHA256.test(String(authority.independentRecomputationAssuranceHash || ''))
    || !SHA256.test(String(authority.independentVerifierImplementationHash || '')))) {
    blockers.push('analysis_independent_numeric_recomputation_unverified');
  }
  if (authority.version >= 3 && !verifyTypedNumericOracleCertificateSet(
    authority.typedNumericOracleCertificateSet,
    {
      analysisProtocolHash: protocol.analysisProtocolHash,
      experimentAttemptId: authority.experimentAttemptId,
      sourceLineageHash: authority.sourceLineageHash,
    },
  )) blockers.push('analysis_typed_numeric_oracle_certificate_set_invalid');
  const canonicalPluginProfile = autonomousEmpiricalFamilyPluginProfileFor(
    protocol?.benchmarkFamily,
  );
  const advancedTypes = advancedAuthorityOracleTypes(
    authority.typedNumericOracleCertificateSet, canonicalPluginProfile,
  );
  if (canonicalPluginProfile
    && [
      authority.typedNumericOracleCertificateSet?.requiredOracleTypes,
      authority.typedNumericOracleCertificateSet?.verifiedOracleTypes,
      [...new Set((authority.typedNumericOracleCertificateSet?.certificates || [])
        .map((certificate) => certificate?.oracleType))].sort(),
    ].some((oracleTypes) => oracleTypes?.join('\0')
      !== [...canonicalPluginProfile.typedOracleKinds].sort().join('\0'))) {
    blockers.push('analysis_typed_numeric_oracle_profile_capability_mismatch');
  }
  if (canonicalPluginProfile && authority.version >= 3) {
    const residualCertificate = authority.typedNumericOracleCertificateSet?.certificates?.find(
      (certificate) => certificate?.oracleType === 'residual-bound-v1',
    );
    if (residualCertificate?.assuranceScope
        !== 'process-isolated-independent-implementation-v1'
      || residualCertificate?.processIndependent !== true
      || residualCertificate?.verificationReceiptHash
        !== authority.independentRecomputationAssuranceHash
      || residualCertificate?.verifierImplementationHash
        !== authority.independentVerifierImplementationHash) {
      blockers.push('analysis_canonical_residual_evidence_binding_invalid');
    }
  }
  if (canonicalPluginProfile && authority.version < 3) {
    blockers.push('analysis_canonical_numeric_authority_v3_required');
  }
  if (advancedTypes.length && authority.version !== 5) {
    blockers.push('analysis_advanced_numeric_authority_downgrade_forbidden');
  }
  if (authority.version >= 4) {
    const pluginProfile = autonomousEmpiricalFamilyPluginProfileFor(protocol.benchmarkFamily);
    const productionInputs = {
      observations,
      analysisProtocol: protocol,
      pluginProfile,
      experimentIr: authority.experimentIr,
    };
    const recomputationInputs = {
      ...productionInputs,
      production: authority.typedNumericOracleProduction,
    };
    if (!pluginProfile
      || authority.empiricalPluginProfileHash
        !== pluginProfile.autonomousEmpiricalFamilyPluginProfileHash
      || authority.typedNumericOracleCertificateSet?.empiricalPluginProfileHash
        !== authority.empiricalPluginProfileHash
      || (advancedTypes.length && !verifyVersionedExperimentIr(
        authority.experimentIr, { profile: pluginProfile },
      ))
      || (advancedTypes.length && authority.typedNumericOracleProduction?.version !== 2)
      || (advancedTypes.length
        && authority.typedNumericOracleRecomputationReceipt?.version !== 2)
      || (advancedTypes.length && authority.typedNumericOracleProduction?.analysisProtocolHash
        !== protocol.analysisProtocolHash)
      || (advancedTypes.length
        && authority.typedNumericOracleRecomputationReceipt?.analysisProtocolHash
          !== protocol.analysisProtocolHash)
      || authority.experimentIr?.versionedExperimentIrHash
        !== authority.typedNumericOracleProduction?.versionedExperimentIrHash
      || authority.experimentIr?.versionedExperimentIrHash
        !== authority.typedNumericOracleRecomputationReceipt?.versionedExperimentIrHash
      || !verifyTypedNumericOracleProduction(
        authority.typedNumericOracleProduction, productionInputs,
      )
      || !verifyIndependentTypedNumericOracleRecomputation(
        authority.typedNumericOracleRecomputationReceipt, recomputationInputs,
      )
      || authority.typedNumericOracleCertificateSet?.independentRecomputationReceiptHash
        !== authority.typedNumericOracleRecomputationReceipt
          ?.independentTypedNumericOracleRecomputationHash) {
      blockers.push('analysis_typed_numeric_oracle_production_authority_invalid');
    } else if (!verifyTypedNumericOracleProductionEvidenceBinding({
      certificateSet: authority.typedNumericOracleCertificateSet,
      production: authority.typedNumericOracleProduction,
      recomputation: authority.typedNumericOracleRecomputationReceipt,
      pluginProfile,
      observations,
      analysisProtocol: protocol,
      experimentIr: authority.experimentIr,
    })) blockers.push('analysis_typed_numeric_oracle_evidence_binding_invalid');
  }
  if (authority.agentAggregatesAccepted !== false) {
    blockers.push('analysis_agent_aggregate_authority_forbidden');
  }
}
