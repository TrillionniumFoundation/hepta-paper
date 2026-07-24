import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const signedFixtureProgram = `
import crypto from 'node:crypto';
import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES,
  compileAutonomousEmpiricalFamilyPluginPackage,
  compileAutonomousEmpiricalFamilyPluginRegistry,
} from './paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import { immutableAuthoritySigningPayload } from './workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
const source = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES.find(
  (profile) => profile.benchmarkFamily === 'ml_algorithm_benchmark',
);
const registry = compileAutonomousEmpiricalFamilyPluginRegistry([{
  ...source,
  typedOracleKinds: ['property-oracle-v1', 'residual-bound-v1',
    'condition-number-bound-v1', 'convergence-rate-bound-v1',
    'error-bound-v1', 'optimality-gap-bound-v1'],
}]);
const pluginPackage = compileAutonomousEmpiricalFamilyPluginPackage({
  packageId: 'test.signed.numeric-profile', packageVersion: '1.0.0', registry,
});
const pair = crypto.generateKeyPairSync('ed25519');
const unsigned = {
  version: 1, kind: 'AutonomousEmpiricalFamilyPluginPackageAuthority',
  packageId: pluginPackage.packageId, packageVersion: pluginPackage.packageVersion,
  packageHash: pluginPackage.autonomousEmpiricalFamilyPluginPackageHash,
  pluginAbiHash: pluginPackage.pluginAbiHash,
  evaluatorRegistryHash: pluginPackage.evaluatorRegistryHash,
  signedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};
const authority = { ...unsigned, signatures: [{
  keyId: 'numeric-test-key', role: 'empirical_plugin_authority', algorithm: 'ed25519',
  value: crypto.sign(null, immutableAuthoritySigningPayload(unsigned), pair.privateKey)
    .toString('base64'),
}] };
console.log(JSON.stringify({
  bundle: { version: 1, kind: 'AutonomousEmpiricalFamilyPluginSignedBundle',
    package: pluginPackage, authority },
  trustStore: { version: 1, kind: 'AuthorityTrustStore', keys: [{
    keyId: 'numeric-test-key', subjectId: 'numeric-test-authority', algorithm: 'ed25519',
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    roles: ['empirical_plugin_authority'], status: 'active',
  }] },
}));`;
const signedFixtureResult = spawnSync(process.execPath, [
  '--input-type=module', '--eval', signedFixtureProgram,
], { cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'), encoding: 'utf8' });
if (signedFixtureResult.status !== 0) throw new Error(signedFixtureResult.stderr);
const signedFixture = JSON.parse(signedFixtureResult.stdout);
const signedFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-numeric-signed-'));
const signedBundlePath = path.join(signedFixtureRoot, 'bundle.json');
const signedTrustStorePath = path.join(signedFixtureRoot, 'trust.json');
fs.writeFileSync(signedBundlePath, JSON.stringify(signedFixture.bundle));
fs.writeFileSync(signedTrustStorePath, JSON.stringify(signedFixture.trustStore));
process.env.HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE = signedBundlePath;
process.env.HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE = signedTrustStorePath;
process.on('exit', () => fs.rmSync(signedFixtureRoot, { recursive: true, force: true }));

const {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
  compileAutonomousEmpiricalFamilyPluginRegistry,
} = await import('../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs');
const {
  buildTypedNumericOracleCertificate,
  buildTypedNumericOracleCertificateSet,
  verifyTypedNumericOracleCertificate,
  verifyTypedNumericOracleCertificateSet,
} = await import('../../paper-domain/research/typed-numeric-oracle-certificate.mjs');
const {
  buildTypedNumericOracleProduction,
  verifyTypedNumericOracleProduction,
} = await import('../../paper-domain/research/typed-numeric-oracle-production.mjs');
const {
  buildIndependentTypedNumericOracleRecomputation,
  verifyIndependentTypedNumericOracleRecomputation,
} = await import('../../paper-domain/research/independent-typed-numeric-oracle-recomputation.mjs');
const {
  runProcessIsolatedTypedNumericOracleRecomputation,
  verifyProcessIsolatedTypedNumericOracleRecomputation,
} = await import('../../paper-adapters/research-verify/process-isolated-typed-numeric-oracle-recomputation.mjs');
const {
  installTypedNumericOracleNetworkGuard,
  runIndependentTypedNumericOracleRecomputationWorker,
} = await import('../../paper-adapters/research-verify/independent-typed-numeric-oracle-recomputation-worker.mjs');
const {
  buildProcessIsolatedTypedNumericOracleRequest,
} = await import('../../paper-domain/research/process-isolated-typed-numeric-oracle-recomputation-contract.mjs');
const {
  runSystemBenchmarkTypedNumericProcess,
} = await import('../../paper-adapters/automation/system-benchmark-typed-numeric-process.mjs');
const {
  buildVersionedExperimentIr,
} = await import('../../paper-domain/automation/versioned-experiment-ir.mjs');
const { hashRecord } = await import('../../workflow-kernel/record-hash.mjs');
const {
  buildRepositoryAnalysisObservationAuthority,
  verifyRepositoryAnalysisObservationAuthority,
  verifyTypedNumericOracleProductionEvidenceBinding,
} =
  await import('../../paper-domain/automation/analysis-observation-authority.mjs');

const ADVANCED = Object.freeze([
  'condition-number-bound-v1',
  'convergence-rate-bound-v1',
  'error-bound-v1',
  'optimality-gap-bound-v1',
]);
const ARMS = Object.freeze(['treatment', 'baseline', 'ablation']);

function fixture() {
  const pluginProfile = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY.profiles[0];
  const protocolPayload = {
    benchmarkFamily: pluginProfile.benchmarkFamily,
    requiredMetrics: pluginProfile.requiredMetrics,
    metricSpecs: pluginProfile.metricSpecs,
    hypotheses: Object.freeze([Object.freeze({ metric: pluginProfile.primaryMetric })]),
    estimator: Object.freeze({ estimatorId: 'registered-cell-estimator-v1' }),
    numericValidation: Object.freeze({
      residual: Object.freeze({ maximumAbsoluteResidual: 1e-10 }),
    }),
  };
  const analysisProtocol = Object.freeze({
    ...protocolPayload,
    analysisProtocolHash: hashRecord('TypedNumericOracleTestProtocol', protocolPayload),
  });
  const experimentIr = buildVersionedExperimentIr(pluginProfile);
  const observations = [];
  for (const [seedIndex, seed] of pluginProfile.seedSchedule.entries()) {
    for (let repetition = 1; repetition <= pluginProfile.minimumRepetitions; repetition += 1) {
      for (const [armIndex, arm] of ARMS.entries()) {
        observations.push(Object.freeze({
          seed,
          repetition,
          arm,
          metrics: Object.freeze({
            mean_score: 0.35 + (seedIndex * 0.01) + (repetition * 0.003) + (armIndex * 0.02),
            standard_error: 0.12 + (seedIndex * 0.005) + (repetition * 0.002) + (armIndex * 0.004),
            baseline_gap: -0.25 + (seedIndex * 0.02) + (repetition * 0.004) + (armIndex * 0.03),
            robustness_gap: -0.1 + (seedIndex * 0.015) + (repetition * 0.005) + (armIndex * 0.01),
          }),
        }));
      }
    }
  }
  return { pluginProfile, analysisProtocol, observations, experimentIr };
}

function evidence(fixtureValue) {
  const production = buildTypedNumericOracleProduction(fixtureValue);
  const recomputation = runProcessIsolatedTypedNumericOracleRecomputation({
    ...fixtureValue,
    production,
  });
  const comparisons = new Map(recomputation.comparisons.map((item) => [item.oracleType, item]));
  const certificates = production.outputs.map((output) => buildTypedNumericOracleCertificate({
    version: 3,
    certificateId: `${output.oracleType}:${output.typedNumericOracleAlgorithmOutputHash.slice(7, 39)}`,
    oracleType: output.oracleType,
    subjectHash: output.numericInputManifestHash,
    quantity: output.quantity,
    observedValue: output.observedValue,
    relation: output.relation,
    lowerBound: output.lowerBound,
    upperBound: output.upperBound,
    unit: output.unit,
    verifierId: 'repository-independent-typed-numeric-oracle-v1',
    producerImplementationHash: production.producerImplementationHash,
    verifierImplementationHash: recomputation.verifierImplementationHash,
    verificationReceiptHash:
      comparisons.get(output.oracleType).independentTypedNumericOracleComparisonHash,
    evidenceHashes: [
      output.typedNumericOracleAlgorithmOutputHash,
      recomputation.independentTypedNumericOracleRecomputationHash,
    ],
    assuranceScope: 'process-isolated-independent-implementation-v1',
    algorithmId: output.algorithmId,
    algorithmVersion: output.algorithmVersion,
    algorithmConfigurationHash: output.algorithmConfigurationHash,
    numericInputManifestHash: output.numericInputManifestHash,
    finiteInputCount: output.finiteInputCount,
    finiteInputsVerified: output.finiteInputsVerified,
    boundsAuthorityHash: output.boundsAuthorityHash,
  }));
  const coreImplementationHash = hashRecord('TypedOracleTestCoreImplementation', {});
  const residualVerifierHash = hashRecord('TypedOracleTestResidualVerifier', {});
  for (const [oracleType, quantity] of [
    ['property-oracle-v1', 'property_oracle_verified'],
    ['residual-bound-v1', 'maximum_absolute_residual'],
  ]) {
    certificates.push(buildTypedNumericOracleCertificate({
      certificateId: `${oracleType}:test`,
      oracleType,
      subjectHash: production.numericInputManifestHash,
      quantity,
      observedValue: oracleType === 'property-oracle-v1' ? 1 : 0,
      relation: oracleType === 'property-oracle-v1' ? 'interval' : 'less-than-or-equal',
      lowerBound: oracleType === 'property-oracle-v1' ? 1 : null,
      upperBound: oracleType === 'property-oracle-v1' ? 1 : 0,
      unit: oracleType === 'property-oracle-v1' ? 'boolean-indicator' : 'absolute-metric-unit',
      verifierId: 'typed-oracle-test-core-verifier',
      producerImplementationHash: coreImplementationHash,
      verifierImplementationHash: oracleType === 'property-oracle-v1'
        ? coreImplementationHash : residualVerifierHash,
      verificationReceiptHash: hashRecord('TypedOracleTestCoreReceipt', { oracleType }),
      evidenceHashes: [hashRecord('TypedOracleTestCoreEvidence', { oracleType })],
      assuranceScope: oracleType === 'property-oracle-v1'
        ? 'producer-bound-self-check-v1'
        : 'process-isolated-independent-implementation-v1',
    }));
  }
  const certificateSet = buildTypedNumericOracleCertificateSet({
    analysisProtocolHash: fixtureValue.analysisProtocol.analysisProtocolHash,
    experimentAttemptId: 'typed-oracle-production-test',
    sourceLineageHash: hashRecord('TypedOracleTestLineage', {}),
    requiredOracleTypes: fixtureValue.pluginProfile.typedOracleKinds,
    certificates,
    empiricalPluginProfileHash:
      fixtureValue.pluginProfile.autonomousEmpiricalFamilyPluginProfileHash,
    independentRecomputationReceiptHash:
      recomputation.independentTypedNumericOracleRecomputationHash,
  });
  return { production, recomputation, certificates, certificateSet };
}

function rehashWorkerReceipt(receipt) {
  const { workerReceiptHash, ...payload } = receipt;
  receipt.workerReceiptHash = hashRecord(
    'ProcessIsolatedTypedNumericOracleWorkerReceipt', payload,
  );
  return receipt;
}

function tamperedWorkerSpawn(mutate) {
  return (executable, args, options) => {
    const result = spawnSync(executable, args, options);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    mutate(receipt);
    rehashWorkerReceipt(receipt);
    return { ...result, stdout: `${JSON.stringify(receipt)}\n` };
  };
}

function netConnectionProbe() {
  return net.createConnection({ host: '127.0.0.1', port: 9 });
}

test('registered advanced oracle kinds produce data-bound, independently recomputed certificates', () => {
  const selected = fixture();
  const result = evidence(selected);
  assert.equal(result.production.status, 'typed_numeric_oracle_production_verified');
  assert.deepEqual(result.production.producedOracleTypes, [...ADVANCED].sort());
  assert.equal(verifyTypedNumericOracleProduction(result.production, selected), true);
  assert.equal(result.recomputation.status,
    'independent_typed_numeric_oracle_recomputation_verified');
  assert.equal(verifyIndependentTypedNumericOracleRecomputation(
    result.recomputation, { ...selected, production: result.production },
  ), true);
  assert.equal(verifyProcessIsolatedTypedNumericOracleRecomputation(
    result.recomputation, { ...selected, production: result.production },
  ), true);
  assert.equal(result.recomputation.processIndependent, true);
  assert.notEqual(result.recomputation.workerPid, process.pid);
  assert.equal(result.recomputation.parentPid, process.pid);
  assert.equal(result.recomputation.networkGuardInstalled, true);
  assert.equal(result.recomputation.networkActionPerformed, false);
  assert.equal(result.recomputation.externalActionPerformed, false);
  assert.equal(result.recomputation.numericTupleManifest.tupleCount, ADVANCED.length);
  assert.ok(result.recomputation.numericTupleManifest.tuples.every((tuple) => (
    Object.keys(tuple.produced).sort().join(',')
      === 'lowerBound,observedValue,quantity,relation,unit,upperBound'
      && Object.keys(tuple.independentlyRecomputed).sort().join(',')
        === 'lowerBound,observedValue,quantity,relation,unit,upperBound'
  )));
  assert.ok(result.certificates.filter((certificate) => ADVANCED.includes(certificate.oracleType))
    .every((certificate) => (
    certificate.version === 3 && verifyTypedNumericOracleCertificate(certificate)
    )));
  assert.equal(verifyTypedNumericOracleCertificateSet(result.certificateSet), true);
  assert.equal(verifyTypedNumericOracleProductionEvidenceBinding({
    ...selected,
    certificateSet: result.certificateSet,
    production: result.production,
    recomputation: result.recomputation,
    pluginProfile: selected.pluginProfile,
  }), true);
  assert.equal(result.production.outputs.find((item) => (
    item.oracleType === 'optimality-gap-bound-v1'
  )).quantity, 'maximum_registered_arm_empirical_optimality_gap');
  assert.equal(result.production.candidateAuthoredValuesAccepted, false);
});

test('rehashing altered bounds, algorithm configuration, or input manifest cannot pass release binding', () => {
  const selected = fixture();
  const result = evidence(selected);
  const base = result.certificates.find((item) => (
    item.oracleType === 'optimality-gap-bound-v1'
  ));
  for (const alteration of [
    { upperBound: base.upperBound + 0.25, numericOutputHash: null },
    { algorithmConfigurationHash: `sha256:${'a'.repeat(64)}` },
    { numericInputManifestHash: `sha256:${'b'.repeat(64)}` },
  ]) {
    const forgedCertificate = buildTypedNumericOracleCertificate({ ...base, ...alteration });
    assert.equal(verifyTypedNumericOracleCertificate(forgedCertificate), true);
    const forgedSet = buildTypedNumericOracleCertificateSet({
      ...result.certificateSet,
      certificates: result.certificates.map((item) => (
        item.oracleType === base.oracleType ? forgedCertificate : item
      )),
    });
    assert.equal(verifyTypedNumericOracleCertificateSet(forgedSet), true);
    assert.equal(verifyTypedNumericOracleProductionEvidenceBinding({
      ...selected,
      certificateSet: forgedSet,
      production: result.production,
      recomputation: result.recomputation,
      pluginProfile: selected.pluginProfile,
    }), false);
  }
});

test('outputs change with observations and tampering cannot survive independent verification', () => {
  const selected = fixture();
  const original = evidence(selected);
  const changedObservations = structuredClone(selected.observations);
  changedObservations[0].metrics.mean_score += 0.01;
  const changed = evidence({ ...selected, observations: changedObservations });
  assert.notEqual(changed.production.numericInputManifestHash,
    original.production.numericInputManifestHash);
  assert.notEqual(changed.production.typedNumericOracleProductionHash,
    original.production.typedNumericOracleProductionHash);
  const forged = structuredClone(original.production);
  forged.outputs[0].observedValue += 1;
  forged.typedNumericOracleProductionHash = hashRecord(
    'TypedNumericOracleProduction', (({ typedNumericOracleProductionHash, ...value }) => value)(forged),
  );
  assert.equal(verifyTypedNumericOracleProduction(forged, selected), false);
  const forgedRecomputation = buildIndependentTypedNumericOracleRecomputation({
    ...selected,
    production: forged,
  });
  assert.equal(forgedRecomputation.status,
    'independent_typed_numeric_oracle_recomputation_blocked');
});

test('independent recomputation compares the complete semantic numeric tuple', () => {
  const selected = fixture();
  const original = evidence(selected).production;
  const source = original.outputs.find((item) => (
    item.oracleType === 'optimality-gap-bound-v1'
  ));
  for (const alteration of [
    { quantity: `${source.quantity}-forged` },
    { relation: 'less-than-or-equal' },
    { lowerBound: source.lowerBound + 0.125 },
    { upperBound: source.upperBound + 0.125 },
    { unit: `${source.unit}-forged` },
  ]) {
    const production = structuredClone(original);
    production.outputs = production.outputs.map((item) => item.oracleType === source.oracleType
      ? { ...item, ...alteration }
      : item);
    const recomputation = buildIndependentTypedNumericOracleRecomputation({
      ...selected,
      production,
    });
    const comparison = recomputation.comparisons.find((item) => (
      item.oracleType === source.oracleType
    ));
    assert.equal(recomputation.status,
      'independent_typed_numeric_oracle_recomputation_blocked');
    assert.equal(comparison.match, false);
    assert.equal(Object.values(comparison.fieldMatches).every(Boolean), false);
  }
});

test('process-isolated numeric recomputation rejects rehashed tuple, network, pid, and source tampering', () => {
  const selected = fixture();
  const production = buildTypedNumericOracleProduction(selected);
  const input = { ...selected, production };
  const alterations = [
    (receipt) => {
      receipt.numericTupleManifest.tuples[0].independentlyRecomputed.unit = 'forged-unit';
      const { numericTupleManifestHash, ...payload } = receipt.numericTupleManifest;
      receipt.numericTupleManifest.numericTupleManifestHash = hashRecord(
        'ProcessIsolatedTypedNumericOracleTupleManifest', payload,
      );
      receipt.numericTupleManifestHash = receipt.numericTupleManifest.numericTupleManifestHash;
    },
    (receipt) => { receipt.networkActionPerformed = true; },
    (receipt) => { receipt.workerPid = process.pid; },
    (receipt) => {
      receipt.workerImplementationSourceHash = `sha256:${'f'.repeat(64)}`;
    },
  ];
  for (const alter of alterations) {
    const blocked = runProcessIsolatedTypedNumericOracleRecomputation(input, {
      spawnSyncImpl: tamperedWorkerSpawn(alter),
    });
    assert.equal(blocked.status,
      'independent_typed_numeric_oracle_recomputation_blocked');
    assert.ok(blocked.blockers.includes(
      'process_isolated_typed_numeric_recomputation_receipt_invalid',
    ));
    assert.equal(verifyProcessIsolatedTypedNumericOracleRecomputation(blocked, input), false);
  }
});

test('process-isolated numeric recomputation fails closed on worker failure and timeout', () => {
  const selected = fixture();
  const production = buildTypedNumericOracleProduction(selected);
  const input = { ...selected, production };
  for (const [error, expected] of [
    [null, 'process_isolated_typed_numeric_recomputation_worker_failed'],
    [{ code: 'ETIMEDOUT' }, 'process_isolated_typed_numeric_recomputation_timed_out'],
  ]) {
    const blocked = runProcessIsolatedTypedNumericOracleRecomputation(input, {
      spawnSyncImpl() {
        return { status: 1, signal: null, error, stdout: '', stderr: '', pid: 99 };
      },
    });
    assert.equal(blocked.status,
      'independent_typed_numeric_oracle_recomputation_blocked');
    assert.ok(blocked.blockers.includes(expected));
    assert.equal(blocked.processIndependent, false);
  }
});

test('typed numeric worker validates a bounded request and emits its process receipt', () => {
  const selected = fixture();
  const production = buildTypedNumericOracleProduction(selected);
  const request = buildProcessIsolatedTypedNumericOracleRequest({ ...selected, production });
  let emitted = null;
  const receipt = runIndependentTypedNumericOracleRecomputationWorker({
    readRequestBytes: () => Buffer.from(JSON.stringify(request)),
    writeReceipt: (value) => { emitted = value; },
    workerPid: 222,
    parentPid: 111,
    installNetworkGuard: () => ({
      installed: true,
      policy: 'deny-node-network-client-and-server-apis-v1',
    }),
  });
  assert.equal(receipt.status,
    'process_isolated_typed_numeric_oracle_recomputation_verified');
  assert.equal(receipt.workerPid, 222);
  assert.equal(receipt.parentPid, 111);
  assert.equal(receipt.numericTupleManifest.tupleCount, ADVANCED.length);
  assert.equal(emitted.workerReceiptHash, receipt.workerReceiptHash);
});

test('system benchmark numeric boundary invokes the process verifier for advanced profiles', () => {
  const selected = fixture();
  const result = runSystemBenchmarkTypedNumericProcess({
    benchmarkFamily: selected.pluginProfile.benchmarkFamily,
    observations: selected.observations,
    analysisProtocol: selected.analysisProtocol,
    experimentIr: selected.experimentIr,
    independentRawEventRecomputationAssurance: {
      status: 'independent_raw_event_recomputation_assurance_verified',
    },
  }, {
    pluginProfileFor: () => selected.pluginProfile,
    buildExperimentIr: () => { throw new Error('late_experiment_ir_build_forbidden'); },
  });
  assert.equal(result.blockers.length, 0);
  assert.equal(result.typedNumericOracleProduction.status,
    'typed_numeric_oracle_production_verified');
  assert.equal(result.typedNumericOracleRecomputationReceipt.status,
    'independent_typed_numeric_oracle_recomputation_verified');
  assert.equal(result.typedNumericOracleRecomputationReceipt.processIndependent, true);
});

test('advanced numeric boundary blocks when independent raw-event assurance is absent', () => {
  const selected = fixture();
  const result = runSystemBenchmarkTypedNumericProcess({
    benchmarkFamily: selected.pluginProfile.benchmarkFamily,
    observations: selected.observations,
    analysisProtocol: selected.analysisProtocol,
    experimentIr: selected.experimentIr,
  }, {
    pluginProfileFor: () => selected.pluginProfile,
    buildExperimentIr: () => { throw new Error('late_experiment_ir_build_forbidden'); },
  });
  assert.deepEqual(result.blockers, [
    'typed_numeric_oracle_process:independent_raw_event_recomputation_assurance_required',
  ]);
  assert.equal(result.typedNumericOracleProduction, null);
  assert.equal(result.typedNumericOracleRecomputationReceipt, null);
});

test('Experiment IR tampering and cross-profile replay fail at production and replay boundaries', () => {
  const selected = fixture();
  const production = buildTypedNumericOracleProduction(selected);
  assert.equal(production.versionedExperimentIrHash,
    selected.experimentIr.versionedExperimentIrHash);
  const tamperedIr = structuredClone(selected.experimentIr);
  tamperedIr.experimentId = 'replayed-experiment';
  const { versionedExperimentIrHash, ...payload } = tamperedIr;
  tamperedIr.versionedExperimentIrHash = hashRecord('VersionedExperimentIR', payload);
  assert.throws(() => buildTypedNumericOracleProduction({
    ...selected,
    experimentIr: tamperedIr,
  }), /typed_numeric_oracle_experiment_ir_invalid/);
  assert.equal(verifyIndependentTypedNumericOracleRecomputation(
    evidence(selected).recomputation,
    { ...selected, experimentIr: tamperedIr, production },
  ), false);
});

test('self-consistent custom profile and self-hashed IR cannot cross the production boundary', () => {
  const selected = fixture();
  const source = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES.find(
    (profile) => profile.benchmarkFamily === 'ml_algorithm_benchmark',
  );
  const registry = compileAutonomousEmpiricalFamilyPluginRegistry([{
    ...source,
    profileId: 'self-hashed-untrusted-advanced-profile-v1',
    typedOracleKinds: ['property-oracle-v1', 'residual-bound-v1', ...ADVANCED],
  }]);
  const pluginProfile = registry.profiles[0];
  const experimentIr = buildVersionedExperimentIr(pluginProfile, {
    registry,
    startupInspection: null,
    requireProductionAuthority: false,
  });
  assert.equal(experimentIr.sourceAuthority.productionAuthorized, false);
  assert.throws(() => buildTypedNumericOracleProduction({
    ...selected,
    pluginProfile,
    experimentIr,
  }), /typed_numeric_oracle_experiment_ir_invalid/);
});

test('canonical signed advanced evidence builds v5 authority and self-hashed v3 downgrade fails', () => {
  const selected = fixture();
  const result = evidence(selected);
  const residualCertificate = result.certificates.find((certificate) => (
    certificate.oracleType === 'residual-bound-v1'
  ));
  const sourceLineageHash = hashRecord('TypedOracleTestLineage', {});
  const authority = buildRepositoryAnalysisObservationAuthority({
    observations: selected.observations,
    rawEventManifestHash: hashRecord('TypedOracleTestRawManifest', {}),
    rawEventArtifactHash: hashRecord('TypedOracleTestRawArtifact', {}),
    rawEventRecomputationManifestHash: hashRecord('TypedOracleTestRawRecomputation', {}),
    independentResidualRecomputationVerified: true,
    independentRecomputationAssuranceHash: residualCertificate.verificationReceiptHash,
    independentVerifierImplementationHash: residualCertificate.verifierImplementationHash,
    typedNumericOracleCertificateSet: result.certificateSet,
    typedNumericOracleProduction: result.production,
    typedNumericOracleRecomputationReceipt: result.recomputation,
    empiricalPluginProfileHash:
      selected.pluginProfile.autonomousEmpiricalFamilyPluginProfileHash,
    experimentIr: selected.experimentIr,
    experimentAttemptId: 'typed-oracle-production-test',
    sourceLineageHash,
    analysisProtocol: selected.analysisProtocol,
  });
  assert.equal(authority.version, 5);
  const blockers = [];
  verifyRepositoryAnalysisObservationAuthority(
    authority, selected.observations, selected.analysisProtocol, blockers,
  );
  assert.deepEqual(blockers, []);

  const downgraded = structuredClone(authority);
  delete downgraded.analysisObservationAuthorityHash;
  delete downgraded.typedNumericOracleProduction;
  delete downgraded.typedNumericOracleRecomputationReceipt;
  delete downgraded.empiricalPluginProfileHash;
  delete downgraded.experimentIr;
  downgraded.version = 3;
  downgraded.analysisObservationAuthorityHash = hashRecord(
    'RepositoryAnalysisObservationAuthority', downgraded,
  );
  const downgradeBlockers = [];
  verifyRepositoryAnalysisObservationAuthority(
    downgraded, selected.observations, selected.analysisProtocol, downgradeBlockers,
  );
  assert.ok(downgradeBlockers.includes(
    'analysis_advanced_numeric_authority_downgrade_forbidden',
  ));

  const coreOnlyCertificateSet = buildTypedNumericOracleCertificateSet({
    analysisProtocolHash: selected.analysisProtocol.analysisProtocolHash,
    experimentAttemptId: 'typed-oracle-production-test',
    sourceLineageHash,
    requiredOracleTypes: ['property-oracle-v1', 'residual-bound-v1'],
    certificates: result.certificates.filter((certificate) => (
      ['property-oracle-v1', 'residual-bound-v1'].includes(certificate.oracleType)
    )),
  });
  const omittedAdvanced = structuredClone(downgraded);
  omittedAdvanced.typedNumericOracleCertificateSet = coreOnlyCertificateSet;
  delete omittedAdvanced.analysisObservationAuthorityHash;
  omittedAdvanced.analysisObservationAuthorityHash = hashRecord(
    'RepositoryAnalysisObservationAuthority', omittedAdvanced,
  );
  const omittedBlockers = [];
  verifyRepositoryAnalysisObservationAuthority(
    omittedAdvanced, selected.observations, selected.analysisProtocol, omittedBlockers,
  );
  assert.ok(omittedBlockers.includes(
    'analysis_advanced_numeric_authority_downgrade_forbidden',
  ));
  assert.ok(omittedBlockers.includes(
    'analysis_typed_numeric_oracle_profile_capability_mismatch',
  ));
  assert.throws(() => buildRepositoryAnalysisObservationAuthority({
    observations: selected.observations,
    typedNumericOracleCertificateSet: coreOnlyCertificateSet,
    analysisProtocol: selected.analysisProtocol,
  }), /analysis_observation_canonical_numeric_evidence_required/);

  const hiddenAdvancedSet = structuredClone(result.certificateSet);
  hiddenAdvancedSet.requiredOracleTypes = ['property-oracle-v1', 'residual-bound-v1'];
  delete hiddenAdvancedSet.typedNumericOracleCertificateSetHash;
  hiddenAdvancedSet.typedNumericOracleCertificateSetHash = hashRecord(
    'TypedNumericOracleCertificateSet', hiddenAdvancedSet,
  );
  const hiddenAdvanced = structuredClone(downgraded);
  hiddenAdvanced.typedNumericOracleCertificateSet = hiddenAdvancedSet;
  delete hiddenAdvanced.analysisObservationAuthorityHash;
  hiddenAdvanced.analysisObservationAuthorityHash = hashRecord(
    'RepositoryAnalysisObservationAuthority', hiddenAdvanced,
  );
  const hiddenBlockers = [];
  verifyRepositoryAnalysisObservationAuthority(
    hiddenAdvanced, selected.observations, selected.analysisProtocol, hiddenBlockers,
  );
  assert.ok(hiddenBlockers.includes('analysis_typed_numeric_oracle_certificate_set_invalid'));
  assert.ok(hiddenBlockers.includes('analysis_advanced_numeric_authority_downgrade_forbidden'));
  assert.throws(() => buildTypedNumericOracleCertificateSet({
    ...coreOnlyCertificateSet,
    certificates: result.certificates,
  }), /typed_numeric_oracle_certificate_set_type_bijection_invalid/);

  const legacyV1 = buildRepositoryAnalysisObservationAuthority({
    observations: selected.observations,
    rawEventManifestHash: hashRecord('TypedOracleLegacyRawManifest', {}),
    rawEventArtifactHash: hashRecord('TypedOracleLegacyRawArtifact', {}),
    rawEventRecomputationManifestHash: hashRecord('TypedOracleLegacyRecomputation', {}),
    experimentAttemptId: 'typed-oracle-legacy-v1',
    sourceLineageHash,
    allowLegacyNonProduction: true,
  });
  const legacyBlockers = [];
  verifyRepositoryAnalysisObservationAuthority(
    legacyV1, selected.observations, selected.analysisProtocol, legacyBlockers,
  );
  assert.ok(legacyBlockers.includes('analysis_canonical_numeric_authority_v3_required'));
  assert.ok(legacyBlockers.includes('analysis_advanced_numeric_authority_downgrade_forbidden'));
  assert.throws(() => buildRepositoryAnalysisObservationAuthority({
    observations: selected.observations,
    experimentAttemptId: 'typed-oracle-canonical-omission',
    sourceLineageHash,
    analysisProtocol: selected.analysisProtocol,
  }), /analysis_observation_canonical_numeric_evidence_required/);
});

test('production evidence binding rejects vacuous empty advanced evidence', () => {
  const selected = fixture();
  const receiptHash = hashRecord('VacuousRecomputation', {});
  assert.equal(verifyTypedNumericOracleProductionEvidenceBinding({
    ...selected,
    pluginProfile: selected.pluginProfile,
    certificateSet: {
      requiredOracleTypes: selected.pluginProfile.typedOracleKinds,
      verifiedOracleTypes: [],
      certificates: [],
      empiricalPluginProfileHash:
        selected.pluginProfile.autonomousEmpiricalFamilyPluginProfileHash,
      independentRecomputationReceiptHash: receiptHash,
    },
    production: {
      requestedOracleTypes: [], outputs: [],
      versionedExperimentIrHash: selected.experimentIr.versionedExperimentIrHash,
    },
    recomputation: {
      version: 2,
      status: 'independent_typed_numeric_oracle_recomputation_verified',
      assuranceScope: 'process-isolated-independent-implementation-v1',
      processIndependent: true,
      independentlyRecomputed: true,
      networkGuardInstalled: true,
      networkActionPerformed: false,
      externalActionPerformed: false,
      workerPid: 2,
      parentPid: 1,
      workerImplementationSourceHash: hashRecord('VacuousWorker', {}),
      workerSourceClosureHash: hashRecord('VacuousClosure', {}),
      numericTupleManifestHash: hashRecord('VacuousTuples', {}),
      independentTypedNumericOracleRecomputationHash: receiptHash,
      versionedExperimentIrHash: selected.experimentIr.versionedExperimentIrHash,
      comparisons: [],
    },
  }), false);
});

test('production evidence binding rejects a nonempty arbitrary-digest evidence chain', () => {
  const selected = fixture();
  const result = evidence(selected);
  const arbitraryProductionHash = `sha256:${'8'.repeat(64)}`;
  const arbitraryRecomputationHash = `sha256:${'9'.repeat(64)}`;
  const forgedProduction = structuredClone(result.production);
  forgedProduction.typedNumericOracleProductionHash = arbitraryProductionHash;
  const forgedRecomputation = structuredClone(result.recomputation);
  forgedRecomputation.productionHash = arbitraryProductionHash;
  forgedRecomputation.independentTypedNumericOracleRecomputationHash =
    arbitraryRecomputationHash;
  const forgedCertificates = result.certificates.map((certificate) => (
    ADVANCED.includes(certificate.oracleType)
      ? buildTypedNumericOracleCertificate({
        ...certificate,
        evidenceHashes: certificate.evidenceHashes.map((evidenceHash) => (
          evidenceHash === result.recomputation.independentTypedNumericOracleRecomputationHash
            ? arbitraryRecomputationHash : evidenceHash
        )),
      })
      : certificate
  ));
  const forgedCertificateSet = buildTypedNumericOracleCertificateSet({
    ...result.certificateSet,
    certificates: forgedCertificates,
    independentRecomputationReceiptHash: arbitraryRecomputationHash,
  });
  assert.equal(verifyTypedNumericOracleCertificateSet(forgedCertificateSet), true);
  assert.equal(forgedProduction.outputs.length, ADVANCED.length);
  assert.equal(forgedRecomputation.comparisons.length, ADVANCED.length);
  assert.equal(verifyTypedNumericOracleProductionEvidenceBinding({
    ...selected,
    pluginProfile: selected.pluginProfile,
    certificateSet: forgedCertificateSet,
    production: forgedProduction,
    recomputation: forgedRecomputation,
  }), false);
});

test('production evidence binding rejects a fully rehashed cross-observation replay', () => {
  const selected = fixture();
  const replayObservations = structuredClone(selected.observations);
  replayObservations[0].metrics.mean_score += 0.01;
  const replayInputs = { ...selected, observations: replayObservations };
  const replayEvidence = evidence(replayInputs);
  const binding = {
    certificateSet: replayEvidence.certificateSet,
    production: replayEvidence.production,
    recomputation: replayEvidence.recomputation,
    pluginProfile: selected.pluginProfile,
    analysisProtocol: selected.analysisProtocol,
    experimentIr: selected.experimentIr,
  };
  assert.equal(verifyTypedNumericOracleProductionEvidenceBinding({
    ...binding,
    observations: replayObservations,
  }), true);
  assert.equal(verifyTypedNumericOracleProductionEvidenceBinding({
    ...binding,
    observations: selected.observations,
  }), false);
});

test('numeric worker installs a deny-by-default Node network guard', () => {
  const guard = installTypedNumericOracleNetworkGuard();
  assert.equal(guard.installed, true);
  assert.throws(
    () => netConnectionProbe(),
    /typed_numeric_oracle_worker_network_forbidden/,
  );
});

test('nonfinite, out-of-scope, incomplete, singular, and unknown kinds fail closed', () => {
  const selected = fixture();
  const nonfinite = structuredClone(selected.observations);
  nonfinite[0].metrics.mean_score = Number.NaN;
  assert.throws(() => buildTypedNumericOracleProduction({
    ...selected, observations: nonfinite,
  }), /nonfinite_or_unbounded/);
  assert.throws(() => buildTypedNumericOracleProduction({
    ...selected, observations: selected.observations.slice(1),
  }), /arm_bijection/);
  const singular = selected.observations.map((row) => ({
    ...row,
    metrics: Object.freeze({
      mean_score: 0.5, standard_error: 0.2, baseline_gap: 0, robustness_gap: 0,
    }),
  }));
  const blocked = buildTypedNumericOracleProduction({ ...selected, observations: singular });
  assert.equal(blocked.status, 'typed_numeric_oracle_production_blocked');
  assert.ok(blocked.blockers.some((item) => item.includes('condition_matrix_singular')));
  const source = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES[1];
  assert.throws(() => compileAutonomousEmpiricalFamilyPluginRegistry([{
    ...source,
    typedOracleKinds: [...source.typedOracleKinds, 'invented-oracle-v1'],
  }]), /profile_invalid/);
});
