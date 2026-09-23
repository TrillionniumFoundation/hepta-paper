import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { rereadOperatorDatasetHarnessPrivateDefinition } from '../automation/operator-dataset-harness-reader.mjs';
import { buildIndependentSystemBenchmarkCellFixture } from './independent-system-benchmark-recomputation.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

function validTime(clock) {
  try {
    const candidate = clock?.now?.();
    const value = candidate instanceof Date ? candidate : new Date(candidate);
    return Number.isFinite(value.getTime()) ? value : null;
  } catch { return null; }
}

export function createSystemBenchmarkPrimitiveFixtureResolver({
  runtimeRoot = null,
  trustStoreProvider = null,
  clock = null,
} = {}) {
  return ({ experimentRunReceipt, cell, resolutionContext = null } = {}) => {
    const blockers = [];
    const harnessReceipt = experimentRunReceipt?.harnessExecutionReceipt || null;
    const selector = harnessReceipt?.benchmarkSelector || null;
    const academic = experimentRunReceipt?.academicPromotionEligible === true
      || selector?.selectorType === 'authorized_dataset_mount';
    let privateResolution = null;
    let operatorDatasetHarnessDefinition = null;
    let primitiveFixture = null;
    if (academic) {
      const now = validTime(clock);
      let trustStore = null;
      try { trustStore = typeof trustStoreProvider === 'function' ? trustStoreProvider() : null; }
      catch { blockers.push('primitive_fixture_trust_store_unreadable'); }
      if (!runtimeRoot || !now || !trustStore) blockers.push('primitive_fixture_private_resolver_context_required');
      const dataset = (harnessReceipt?.datasetAuthorizations || [])
        .find((candidate) => candidate?.name === selector?.datasetMountName) || null;
      if (!dataset) blockers.push('primitive_fixture_dataset_authorization_missing');
      if (!blockers.length) {
        privateResolution = resolutionContext?.privateResolution || null;
        if (!privateResolution) {
          privateResolution = rereadOperatorDatasetHarnessPrivateDefinition(dataset, {
            authorityTrustStore: trustStore,
            now,
            runtimeRoot,
            selector,
          });
          if (resolutionContext && typeof resolutionContext === 'object') {
            resolutionContext.privateResolution = privateResolution;
          }
        }
        blockers.push(...(privateResolution.receipt?.blockers || [])
          .map((blocker) => `primitive_fixture_private_definition:${blocker}`));
        const currentAuthorityHash = privateResolution.receipt?.operatorDatasetAuthorityVerificationHash || null;
        const executedAuthority = harnessReceipt?.operatorDatasetHarnessAuthority || null;
        if (privateResolution.receipt?.status !== 'operator_dataset_private_definition_resolved'
          || currentAuthorityHash !== executedAuthority?.operatorDatasetAuthorityVerificationHash
          || privateResolution.receipt?.operatorDatasetAuthorityDocumentHash
            !== executedAuthority?.operatorDatasetAuthorityDocumentHash
          || privateResolution.receipt?.operatorDatasetHarnessDefinitionHash
            !== executedAuthority?.benchmarkHarnessDefinitionHash
          || privateResolution.receipt?.envelopeDocumentHash !== executedAuthority?.envelopeDocumentHash) {
          blockers.push('primitive_fixture_executed_authority_mismatch');
        }
        operatorDatasetHarnessDefinition = privateResolution.privateDefinition;
      }
    } else if (selector?.selectorType !== 'builtin_benchmark_suite') {
      blockers.push('primitive_fixture_selector_scope_invalid');
    }
    if (!blockers.length) {
      try {
        primitiveFixture = buildIndependentSystemBenchmarkCellFixture({
          protocol: cell?.armProtocol,
          seed: cell?.seed,
          repetition: cell?.repetition,
          operatorDatasetHarnessDefinition,
        });
      } catch {
        blockers.push('primitive_fixture_construction_failed');
      }
      blockers.push(...(primitiveFixture?.blockers || [])
        .map((blocker) => `primitive_fixture_source:${blocker}`));
      if (primitiveFixture?.status !== 'independent_fixture_built'
        || !SHA256.test(String(primitiveFixture?.challenge?.systemBenchmarkCellChallengeHash || ''))
        || !SHA256.test(String(primitiveFixture?.oracle?.systemBenchmarkCellOracleHash || ''))) {
        blockers.push('primitive_fixture_source_unavailable');
      }
    }
    const uniqueBlockers = [...new Set(blockers)];
    const payload = {
      version: 1,
      kind: 'SystemBenchmarkPrimitiveFixtureResolution',
      status: uniqueBlockers.length
        ? 'system_benchmark_primitive_fixture_blocked'
        : 'system_benchmark_primitive_fixture_resolved',
      fixtureAuthority: academic
        ? 'current-signed-private-operator-dataset-definition-v1'
        : 'deterministic-repository-builtin-fixture-v1',
      academic,
      cellId: cell?.cellId || null,
      systemBenchmarkCellChallengeHash: uniqueBlockers.length
        ? null
        : primitiveFixture.challenge.systemBenchmarkCellChallengeHash,
      systemBenchmarkCellOracleHash: uniqueBlockers.length
        ? null
        : primitiveFixture.oracle.systemBenchmarkCellOracleHash,
      operatorDatasetAuthorityVerificationHash: privateResolution?.receipt
        ?.operatorDatasetAuthorityVerificationHash || null,
      operatorDatasetPrivateDefinitionResolutionHash: privateResolution?.receipt
        ?.operatorDatasetPrivateDefinitionResolutionHash || null,
      operatorDatasetHarnessDefinitionHash: privateResolution?.receipt
        ?.operatorDatasetHarnessDefinitionHash || null,
      rawOraclePublished: false,
      blockers: uniqueBlockers,
    };
    const result = {
      ...payload,
      systemBenchmarkPrimitiveFixtureResolutionHash: hashRecord(
        'SystemBenchmarkPrimitiveFixtureResolution',
        payload,
      ),
    };
    Object.defineProperties(result, {
      operatorDatasetHarnessDefinition: { value: operatorDatasetHarnessDefinition, enumerable: false },
    });
    return Object.freeze(result);
  };
}
