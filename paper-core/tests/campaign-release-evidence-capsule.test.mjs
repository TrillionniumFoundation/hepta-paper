import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyCampaignReleaseEvidenceCapsuleDirectory } from '../../paper-adapters/build-package/research-evidence-capsule.mjs';
import {
  buildOfflineOperatorDatasetAuthorityEvidence,
  verifyOfflineOperatorDatasetAuthorityEvidence,
} from '../../paper-adapters/build-package/offline-operator-dataset-authority-verifier.mjs';
import { signAuthorityDocument, verifyAuthoritySignatures, verifyAuthorityTimeWindow } from '../../paper-adapters/authority/authority-signatures.mjs';
import {
  buildCampaignReleaseEvidenceCapsuleManifest,
  verifyCampaignReleaseEvidenceCapsuleManifest,
} from '../../paper-domain/automation/campaign-release-evidence-capsule-contract.mjs';
import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import { buildDatasetAuthorizationSet } from '../../paper-domain/automation/experiment-run-contract.mjs';
import { buildCanonicalAnalysisProtocol } from '../../paper-domain/automation/analysis-protocol-contract.mjs';
import { buildEmpiricalEnvironmentBom } from '../../paper-domain/automation/environment-bom-contract.mjs';
import { EXPERIMENT_REPLAY_ASSURANCE_SCOPE } from '../../paper-domain/automation/experiment-environment-bom-binding.mjs';
import { validateOperatorDatasetAuthorityDocument } from '../../paper-domain/automation/operator-dataset-harness-contract.mjs';
import { buildPublicAuthorityTrustSnapshot } from '../../paper-domain/automation/public-authority-trust-snapshot-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildCampaignReleaseExecutionAttestationUnsignedPayload,
  campaignReleaseExecutionAttestationSigningPayloadHash,
  finalizeCampaignReleaseExecutionAttestation,
} from '../../paper-domain/automation/campaign-release-execution-attestation-contract.mjs';
import {
  createResearchExecutionReleaseAttestor,
  inspectResearchExecutionReleaseAttestorConfiguration,
} from '../../paper-adapters/build-package/research-execution-release-attestor.mjs';
import { verifyOfflineResearchExecutionReleaseAttestation } from '../../paper-adapters/build-package/offline-research-execution-release-attestation-verifier.mjs';
import {
  portableResearchEvidenceValue,
  researchEvidencePublicationBlockers,
} from '../../paper-adapters/build-package/research-evidence-capsule-publication-policy.mjs';

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

test('publication policy preserves slash-prefixed base64 signatures without accepting host paths', () => {
  const value = {
    signatures: [{ algorithm: 'ed25519', value: '/slash-prefixed-base64-signature' }],
    signature: '/detached-base64-signature',
    sourceWorkspace: '/private/source',
    retainedPath: '/private/other',
  };
  const portable = portableResearchEvidenceValue(value);
  assert.equal(portable.signatures[0].value, value.signatures[0].value);
  assert.equal(portable.signature, value.signature);
  assert.equal(Object.hasOwn(portable, 'sourceWorkspace'), false);
  assert.equal(portable.retainedPath, 'redacted:host-absolute-path');
  assert.deepEqual(researchEvidencePublicationBlockers({
    signatures: value.signatures,
    signature: value.signature,
  }), []);
  assert.deepEqual(researchEvidencePublicationBlockers({ retainedPath: '/private/other' }), [
    'host_absolute_path:$.retainedPath',
  ]);
});

function entry(role, relative, content, executionRole = 'base', experimentId = null) {
  return {
    role,
    path: relative,
    hash: hashBytes(content),
    bytes: content.length,
    executionRole,
    experimentId,
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-capsule-'));
  const packageDir = path.join(root, 'package');
  fs.mkdirSync(path.join(packageDir, 'evidence', 'experiments', 'experiment-1', 'original'), { recursive: true });
  fs.mkdirSync(path.join(packageDir, 'evidence', 'experiments', 'experiment-1', 'independent-replay'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, packageDir };
}

const RELEASE_TIME = '2026-07-15T00:00:00.000Z';
const VERIFY_TIME = '2026-07-15T01:00:00.000Z';

function releaseAttestorAuthority() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const publicKeySpkiHash = hashBytes(crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }));
  const signer = {
    keyId: 'release-root-key',
    keyVersion: 'legacy-v1',
    subjectId: 'release-attestor',
    organization: 'research-release-office',
  };
  const attest = ({ manifest, manifestFileHash }) => {
    const unsignedPayload = buildCampaignReleaseExecutionAttestationUnsignedPayload({
      manifest,
      manifestFileHash,
      signer,
      signedAt: RELEASE_TIME,
      validFrom: RELEASE_TIME,
      expiresAt: '2026-07-22T00:00:00.000Z',
    });
    const signature = crypto.sign(
      null,
      Buffer.from(campaignReleaseExecutionAttestationSigningPayloadHash(unsignedPayload), 'utf8'),
      pair.privateKey,
    ).toString('base64');
    return finalizeCampaignReleaseExecutionAttestation({ unsignedPayload, signature });
  };
  return {
    attest,
    trustedReleaseRoots: [{
      ...signer,
      algorithm: 'ed25519',
      publicKeyPem,
      publicKeySpkiHash,
      roles: ['research_execution_release_attestor'],
      status: 'active',
      revoked: false,
      effectiveFrom: '2026-07-01T00:00:00.000Z',
      expiresAt: '2027-07-01T00:00:00.000Z',
    }],
  };
}

function fixtureEnvironmentBom(runtimeIdentityHash) {
  const containerImageDigest = hashRecord('ContainerImageFixture', {});
  return buildEmpiricalEnvironmentBom({
    platform: {
      operatingSystem: 'linux', architecture: 'x64', kernelReleaseHash: hashRecord('KernelFixture', {}),
      cpu: { modelHash: hashRecord('CpuModelFixture', {}), flagsHash: hashRecord('CpuFlagsFixture', {}), logicalProcessorCount: 8, observation: 'host_procfs' },
    },
    runtime: {
      type: 'container', identityHash: runtimeIdentityHash, language: 'python', containerImageDigest,
      packageClosure: { basis: 'container_image_digest', identityHash: containerImageDigest, observedPackageCount: 0 },
    },
    gpu: { required: false, status: 'not_required', deviceCount: 0 },
    numericRuntime: {
      threads: { OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1', BLIS_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1' },
      dynamicThreadingDisabled: true, explicitSingleThreadPolicy: true, policyObservation: 'environment_allowlist',
    },
    limits: { timeoutMs: 60_000, memoryBytes: 1024 ** 3, cpuSeconds: 60, maximumPids: 64, maximumOutputBytes: 1024 ** 2, maximumCapturedBytes: 256 * 1024 },
    determinism: { classification: 'unknown' },
    buildReproducibility: {
      status: 'runtime_content_identity_pinned_rebuild_not_verified', runtimeContentIdentityPinned: true,
      bitwiseRebuildVerified: false, blockers: ['bitwise_rebuild_unverified'],
    },
    observedClaims: ['container_content_digest', 'cpu_identity_hashes', 'resource_limits'],
    unobservedClaims: ['bitwise_rebuild', 'blas_implementation'],
  });
}

function signedOfflineAuthority() {
  const datasetName = 'operator-dataset';
  const benchmarkFamily = 'ml_algorithm_benchmark';
  const repositoryDesign = buildCampaignBenchmarkSelector({ benchmarkId: benchmarkFamily }).experimentDesign;
  const builtProtocol = buildCanonicalAnalysisProtocol({
    benchmarkId: datasetName,
    benchmarkFamily,
    requiredMetrics: repositoryDesign.requiredMetrics,
    metricSpecs: repositoryDesign.metricSpecs,
  });
  const { analysisProtocolHash, ...analysisProtocol } = builtProtocol;
  const datasetManifestHash = hashRecord('DatasetManifestFixture', {});
  const splitManifestHash = hashRecord('DatasetSplitManifestFixture', {});
  const harnessDefinitionHash = hashRecord('HarnessDefinitionFixture', {});
  const harnessDocumentHash = hashRecord('HarnessDocumentFixture', {});
  const keyPair = crypto.generateKeyPairSync('ed25519');
  const signedAuthority = signAuthorityDocument({
    version: 2,
    kind: 'OperatorDatasetHarnessAuthority',
    datasetName,
    datasetManifestHash,
    datasetLicenseId: 'CC-BY-4.0',
    datasetSplitManifestHash: splitManifestHash,
    benchmarkHarnessDefinitionHash: harnessDefinitionHash,
    analysisProtocolHash,
    benchmarkFamily,
    seedSchedule: [17, 23, 31, 43, 59],
    minimumRepetitions: 7,
    workerExposurePolicy: 'signed-complete-dataset-file-manifest-v1',
    signedAt: RELEASE_TIME,
    expiresAt: '2026-08-15T00:00:00.000Z',
  }, {
    privateKeyPem: keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    keyId: 'dataset-harness-key',
    role: 'dataset_harness_operator',
  });
  const validated = validateOperatorDatasetAuthorityDocument(signedAuthority);
  const trustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [{
      keyId: 'dataset-harness-key',
      subjectId: 'dataset-harness-operator',
      algorithm: 'ed25519',
      publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }),
      roles: ['dataset_harness_operator'],
      status: 'active',
    }],
  };
  const datasetMount = {
    name: datasetName,
    readOnly: true,
    manifestHash: datasetManifestHash,
    licenseId: 'CC-BY-4.0',
    operatorAuthorizationHash: validated.operatorDatasetAuthorityDocumentHash,
    operatorDatasetAuthorityDocumentHash: validated.operatorDatasetAuthorityDocumentHash,
    operatorDatasetAuthority: validated.authority,
    splitManifestHash,
    benchmarkHarnessDocumentHash: harnessDocumentHash,
    benchmarkHarnessDefinitionHash: harnessDefinitionHash,
    analysisProtocol,
    analysisProtocolHash,
    benchmarkFamily,
    benchmarkSeedSchedule: [17, 23, 31, 43, 59],
    benchmarkMinimumRepetitions: 7,
  };
  const benchmarkSelector = buildCampaignBenchmarkSelector({ benchmarkId: datasetName, datasetMounts: [datasetMount] });
  const datasetAuthorization = buildDatasetAuthorizationSet([datasetMount]).datasets[0];
  const signatures = verifyAuthoritySignatures({
    document: validated.authority,
    trustStore,
    requiredRoles: ['dataset_harness_operator'],
    minSignatures: 1,
  });
  const time = verifyAuthorityTimeWindow({
    signedAt: validated.authority.signedAt,
    expiresAt: validated.authority.expiresAt,
    now: new Date(VERIFY_TIME),
    maximumLifetimeMs: 31 * 24 * 60 * 60 * 1000,
  });
  const authorityVerification = {
    status: 'operator_dataset_authority_verified',
    cryptographicSignaturesVerified: true,
    verifiedSignatures: signatures.verifiedSignatures,
    verifiedRoles: signatures.verifiedRoles,
    verifiedSubjectIds: signatures.verifiedSubjectIds,
    timeWindowValid: true,
    signedAt: time.signedAt,
    expiresAt: time.expiresAt,
  };
  const receiptPayload = {
    version: 3,
    kind: 'OperatorDatasetHarnessAuthorityReceipt',
    status: 'operator_dataset_harness_authority_verified',
    datasetName,
    datasetManifestHash,
    datasetSplitManifestHash: splitManifestHash,
    datasetLicenseId: 'CC-BY-4.0',
    operatorAuthorizationHash: validated.operatorDatasetAuthorityDocumentHash,
    operatorDatasetAuthorityDocumentHash: validated.operatorDatasetAuthorityDocumentHash,
    benchmarkHarnessDefinitionHash: harnessDefinitionHash,
    benchmarkFamily,
    analysisProtocol,
    analysisProtocolHash,
    authority: validated.authority,
    envelopeDocumentHash: harnessDocumentHash,
    operatorDatasetAuthorityVerificationHash: hashRecord('OperatorDatasetAuthorityVerification', authorityVerification),
    authorityVerification,
    authorizationScheme: 'ed25519-signed-host-only-dataset-harness-v1',
    evidenceAuthority: 'host-owned-hidden-fixture-reader-and-evaluator-v2',
    analysisAuthority: 'operator-signed-preregistered-analysis-protocol-v1',
    workerDatasetExposure: 'signed-complete-dataset-file-manifest-v1',
    hostOnlyHarnessMounted: false,
    rawOraclePublished: false,
    blockers: [],
    externalActionPerformed: false,
  };
  const authorityReceipt = {
    ...receiptPayload,
    operatorDatasetHarnessAuthorityReceiptHash: hashRecord('OperatorDatasetHarnessAuthorityReceipt', receiptPayload),
  };
  const run = (role) => ({
    experimentRunReceiptHash: hashRecord('ExperimentRunReceiptFixture', { role }),
    benchmarkSelector,
    datasetAuthorizations: [datasetAuthorization],
    harnessExecutionReceipt: { operatorDatasetHarnessAuthority: authorityReceipt },
  });
  const evidence = buildOfflineOperatorDatasetAuthorityEvidence({
    originalRunReceipt: run('original'),
    replayRunReceipt: run('independent-replay'),
  });
  const trustSnapshot = buildPublicAuthorityTrustSnapshot({
    trustStore,
    referencedKeyIds: ['dataset-harness-key'],
    capturedAt: RELEASE_TIME,
  });
  const trustedAuthorityRoots = trustStore.keys.map((key) => ({ ...key }));
  return { evidence, trustSnapshot, trustedAuthorityRoots };
}

function academicCapsuleFiles() {
  const offlineAuthority = signedOfflineAuthority();
  const releaseAuthority = releaseAttestorAuthority();
  const researchReportHash = hashRecord('ResearchReportFixture', {});
  const experimentRegistryHash = hashRecord('ExperimentRegistryFixture', {});
  const sourceMerkleHash = hashRecord('SourceMerkleFixture', {});
  const sourceManifestHash = hashRecord('SourceManifestFixture', {});
  const sourceLineageHash = hashRecord('SourceLineageFixture', {});
  const raw = Buffer.from('{"version":1,"kind":"PublicRawEvent","value":1}\n');
  const runtimeIdentityHash = hashRecord('RuntimeIdentityFixture', {});
  const environmentBom = fixtureEnvironmentBom(runtimeIdentityHash);
  const recomputationIndependenceLevel = 'repository-separate-implementation-same-process-v1';
  const recomputationIndependenceContractHash = hashRecord(
    'RawEventRecomputationIndependenceContractFixture',
    {},
  );
  const files = new Map([
    ['evidence/RESEARCH_REPORT.json', jsonBytes({
      version: 1, kind: 'PortablePaperResearchVerifyReport', sourceResearchReportHash: researchReportHash,
      document: { paperId: 'paper', researchReportHash, experimentRegistryHash },
    })],
    ['evidence/EXPERIMENT_REGISTRY.json', jsonBytes({
      version: 1, kind: 'PortableExperimentRegistry', sourceExperimentRegistryHash: experimentRegistryHash,
      document: { paperId: 'paper', experimentRegistryHash, experiments: [{ experimentId: 'experiment-1', academicPromotionEligible: true }] },
    })],
    ['evidence/ENVIRONMENT_MANIFEST.json', jsonBytes({
      version: 1, kind: 'CampaignReleaseResearchEnvironmentManifest', campaignId: 'campaign', paperId: 'paper',
      researchReportHash, experimentRegistryHash, verifiedSourceMerkleHash: sourceMerkleHash,
      verifiedSourceWorkspaceManifestHash: sourceManifestHash,
      experiments: [{ experimentId: 'experiment-1', executions: [] }],
    })],
    ['evidence/PUBLIC_AUTHORITY_EVIDENCE.json', jsonBytes({
      version: 1, kind: 'CampaignReleasePublicResearchAuthorityEvidence', campaignId: 'campaign', paperId: 'paper',
      researchReportHash, experimentRegistryHash, experiments: [{ experimentId: 'experiment-1' }],
      privateKeysIncluded: false, hiddenOracleIncluded: false, hostAbsolutePathsIncluded: false,
    })],
    ['evidence/PUBLIC_AUTHORITY_TRUST_SNAPSHOT.json', jsonBytes(offlineAuthority.trustSnapshot)],
    ['evidence/experiments/experiment-1/original/results.json', jsonBytes({ version: 1, kind: 'PublicResult', value: 1 })],
    ['evidence/experiments/experiment-1/original/results.csv', Buffer.from('metric,value\nscore,1\n')],
    ['evidence/experiments/experiment-1/original/raw-events.ndjson', raw],
    ['evidence/experiments/experiment-1/independent-replay/results.json', jsonBytes({ version: 1, kind: 'PublicResult', value: 1 })],
    ['evidence/experiments/experiment-1/independent-replay/results.csv', Buffer.from('metric,value\nscore,1\n')],
    ['evidence/experiments/experiment-1/independent-replay/raw-events.ndjson', raw],
  ]);
  const run = (executionRole) => ({
    executionRole,
    experimentRunReceiptHash: hashRecord('ExperimentRunReceiptFixture', { executionRole }),
    executionReceiptHash: hashRecord('ExecutionReceiptFixture', { executionRole }),
    runtimeIdentityHash,
    environmentBindingHash: hashRecord('EnvironmentBindingFixture', { executionRole }),
    environmentBomHash: environmentBom.environmentBomHash,
    experimentAttemptId: `${executionRole}-attempt`,
    resultJsonHash: hashBytes(files.get(`evidence/experiments/experiment-1/${executionRole}/results.json`)),
    resultCsvHash: hashBytes(files.get(`evidence/experiments/experiment-1/${executionRole}/results.csv`)),
    rawEventArtifactHash: hashBytes(raw),
    rawEventArtifactBytes: raw.length,
    rawArtifactWriteReceiptHash: hashRecord('ArtifactWriteReceiptFixture', { executionRole }),
    rawArtifactLedgerReceiptId: `artifact-writes:${executionRole}`,
  });
  const experiment = {
    experimentId: 'experiment-1',
    academicPromotionEligible: true,
    experimentEvidenceBindingHash: hashRecord('ExperimentEvidenceBindingFixture', {}),
    experimentReplayReceiptHash: hashRecord('ExperimentReplayReceiptFixture', {}),
    sourceLineageHash,
    analysisProtocolHash: offlineAuthority.evidence.executions.original.authorityReceipt.analysisProtocolHash,
    originalAnalysisEvaluationHash: hashRecord('OriginalAnalysisEvaluationFixture', {}),
    replayAnalysisEvaluationHash: hashRecord('ReplayAnalysisEvaluationFixture', {}),
    analysisProtocolReplayBindingHash: hashRecord('AnalysisProtocolReplayBindingFixture', {}),
    originalEnvironmentBomHash: environmentBom.environmentBomHash,
    replayEnvironmentBomHash: environmentBom.environmentBomHash,
    replayAssuranceScope: EXPERIMENT_REPLAY_ASSURANCE_SCOPE,
    independentRecomputationImplementationVerified: true,
    recomputationIndependenceLevel,
    rawEventRecomputationIndependenceContractHash: recomputationIndependenceContractHash,
    recomputationProcessIndependent: false,
    executions: [run('original'), run('independent-replay')],
  };
  files.set('evidence/RESEARCH_REPORT.json', jsonBytes({
    version: 1, kind: 'PortablePaperResearchVerifyReport', sourceResearchReportHash: researchReportHash,
    redactionPolicy: 'public-research-evidence-no-host-paths-no-private-authority-v1',
    document: { paperId: 'paper', researchReportHash, experimentRegistryHash },
  }));
  files.set('evidence/EXPERIMENT_REGISTRY.json', jsonBytes({
    version: 1, kind: 'PortableExperimentRegistry', sourceExperimentRegistryHash: experimentRegistryHash,
    redactionPolicy: 'public-research-evidence-no-host-paths-no-private-authority-v1',
    document: { paperId: 'paper', experimentRegistryHash, experiments: [{
      experimentId: 'experiment-1', academicPromotionEligible: true,
      evidenceBinding: {
        experimentEvidenceBindingHash: experiment.experimentEvidenceBindingHash,
        sourceLineageHash,
        analysisProtocolHash: experiment.analysisProtocolHash,
        originalAnalysisEvaluationHash: experiment.originalAnalysisEvaluationHash,
        replayAnalysisEvaluationHash: experiment.replayAnalysisEvaluationHash,
        analysisProtocolReplayBindingHash: experiment.analysisProtocolReplayBindingHash,
        originalEnvironmentBomHash: experiment.originalEnvironmentBomHash,
        replayEnvironmentBomHash: experiment.replayEnvironmentBomHash,
        replayAssuranceScope: experiment.replayAssuranceScope,
        independentRecomputationImplementationVerified:
          experiment.independentRecomputationImplementationVerified,
        recomputationIndependenceLevel: experiment.recomputationIndependenceLevel,
        rawEventRecomputationIndependenceContractHash:
          experiment.rawEventRecomputationIndependenceContractHash,
        recomputationProcessIndependent: experiment.recomputationProcessIndependent,
      },
    }] },
  }));
  files.set('evidence/ENVIRONMENT_MANIFEST.json', jsonBytes({
    version: 2, kind: 'CampaignReleaseResearchEnvironmentManifest', campaignId: 'campaign', paperId: 'paper',
    researchReportHash, experimentRegistryHash, verifiedSourceMerkleHash: sourceMerkleHash,
    verifiedSourceWorkspaceManifestHash: sourceManifestHash,
    environmentBomEvidenceIncluded: true, environmentBomCount: 2,
    hardwareDisclosure: 'hash-bound-observed-environment-bom-no-independent-hardware-replication-claim-v1',
    experiments: [{ experimentId: 'experiment-1', sourceLineageHash,
      originalEnvironmentBomHash: experiment.originalEnvironmentBomHash,
      replayEnvironmentBomHash: experiment.replayEnvironmentBomHash,
      replayAssuranceScope: experiment.replayAssuranceScope,
      independentRecomputationImplementationVerified:
        experiment.independentRecomputationImplementationVerified,
      recomputationIndependenceLevel: experiment.recomputationIndependenceLevel,
      rawEventRecomputationIndependenceContractHash:
        experiment.rawEventRecomputationIndependenceContractHash,
      recomputationProcessIndependent: experiment.recomputationProcessIndependent,
      executions: experiment.executions.map((execution) => ({
      executionRole: execution.executionRole, experimentRunReceiptHash: execution.experimentRunReceiptHash,
      experimentAttemptId: execution.experimentAttemptId, executionReceiptHash: execution.executionReceiptHash,
      runtimeIdentityHash: execution.runtimeIdentityHash, environmentBindingHash: execution.environmentBindingHash,
      environmentBomHash: execution.environmentBomHash, environmentBom, sourceLineageHash,
    })) }],
  }));
  const artifactAuthority = Object.fromEntries(experiment.executions.map((execution) => [execution.executionRole, {
    contentHash: execution.rawEventArtifactHash, bytes: execution.rawEventArtifactBytes,
    artifactWriteReceiptHash: execution.rawArtifactWriteReceiptHash,
    ledgerReceiptId: execution.rawArtifactLedgerReceiptId,
    ledgerEvidenceAssurance: 'trusted-runtime-row-summary-structural-only-v1',
    ledgerReceiptSummary: { receiptId: execution.rawArtifactLedgerReceiptId, receiptHash: execution.rawArtifactWriteReceiptHash, writerTrusted: true },
  }]));
  const worker = (execution) => ({
    experimentRunReceiptHash: execution.experimentRunReceiptHash,
    rawArtifactWriteReceiptHash: execution.rawArtifactWriteReceiptHash,
    rawArtifactLedgerReceiptId: execution.rawArtifactLedgerReceiptId,
    sourceLineageHash,
  });
  files.set('evidence/PUBLIC_AUTHORITY_EVIDENCE.json', jsonBytes({
    version: 1, kind: 'CampaignReleasePublicResearchAuthorityEvidence', campaignId: 'campaign', paperId: 'paper',
    researchReportHash, experimentRegistryHash,
    publicAuthorityTrustSnapshotHash: offlineAuthority.trustSnapshot.publicAuthorityTrustSnapshotHash,
    publicAuthorityTrustAssurance: 'package-internal-public-key-disclosure-not-trust-anchor-v1',
    sourceAuthenticityRequiresExternalTrustAnchor: true,
    ledgerEvidenceAssurance: 'structural-receipt-summaries-not-cryptographic-inclusion-proof-v1',
    experiments: [{
      experimentId: 'experiment-1', experimentEvidenceBindingHash: experiment.experimentEvidenceBindingHash,
      experimentReplayReceiptHash: experiment.experimentReplayReceiptHash, sourceLineageHash,
      analysisProtocolHash: experiment.analysisProtocolHash,
      originalAnalysisEvaluationHash: experiment.originalAnalysisEvaluationHash,
      replayAnalysisEvaluationHash: experiment.replayAnalysisEvaluationHash,
      analysisProtocolReplayBindingHash: experiment.analysisProtocolReplayBindingHash,
      originalEnvironmentBomHash: experiment.originalEnvironmentBomHash,
      replayEnvironmentBomHash: experiment.replayEnvironmentBomHash,
      replayAssuranceScope: experiment.replayAssuranceScope,
      independentRecomputationImplementationVerified:
        experiment.independentRecomputationImplementationVerified,
      recomputationIndependenceLevel: experiment.recomputationIndependenceLevel,
      rawEventRecomputationIndependenceContractHash:
        experiment.rawEventRecomputationIndependenceContractHash,
      recomputationProcessIndependent: experiment.recomputationProcessIndependent,
      offlineOperatorDatasetAuthorityEvidence: offlineAuthority.evidence,
      workerReceipt: worker(experiment.executions.find((item) => item.executionRole === 'original')),
      replayWorkerReceipt: worker(experiment.executions.find((item) => item.executionRole === 'independent-replay')),
      reproducibilityLedgerReceipt: { experimentReplayReceiptHash: experiment.experimentReplayReceiptHash, sourceLineageHash },
      artifactAuthority,
      ledgerEvidenceAssurance: 'structural-receipt-summaries-not-cryptographic-inclusion-proof-v1',
      trustedLedgerReceiptSummaries: [1, 2, 3].map((index) => ({ receiptId: `receipt:${index}`, receiptHash: hashRecord('TrustedReceiptFixture', { index }), writerTrusted: true })),
    }],
    privateKeysIncluded: false, hiddenOracleIncluded: false, hostAbsolutePathsIncluded: false,
  }));
  return {
    files,
    experiment,
    researchReportHash,
    experimentRegistryHash,
    sourceMerkleHash,
    sourceManifestHash,
    trustedAuthorityRoots: offlineAuthority.trustedAuthorityRoots,
    trustedReleaseRoots: releaseAuthority.trustedReleaseRoots,
    releaseAttest: releaseAuthority.attest,
  };
}

function trustedExpected(data, overrides = {}) {
  return {
    verificationTime: VERIFY_TIME,
    trustedAuthorityRoots: data.trustedAuthorityRoots,
    trustedReleaseRoots: data.trustedReleaseRoots,
    ...overrides,
  };
}

function capsuleEntries(files) {
  return [...files.entries()].map(([relative, content]) => {
    if (relative.endsWith('/results.json')) {
      const executionRole = relative.includes('/independent-replay/') ? 'independent-replay' : 'original';
      return entry('experiment_results_json', relative, content, executionRole, 'experiment-1');
    }
    if (relative.endsWith('/results.csv')) {
      const executionRole = relative.includes('/independent-replay/') ? 'independent-replay' : 'original';
      return entry('experiment_results_csv', relative, content, executionRole, 'experiment-1');
    }
    if (relative.endsWith('/raw-events.ndjson')) {
      const executionRole = relative.includes('/independent-replay/') ? 'independent-replay' : 'original';
      return entry('experiment_raw_events', relative, content, executionRole, 'experiment-1');
    }
    const roles = {
      'evidence/RESEARCH_REPORT.json': 'portable_research_report',
      'evidence/EXPERIMENT_REGISTRY.json': 'portable_experiment_registry',
      'evidence/ENVIRONMENT_MANIFEST.json': 'research_environment_manifest',
      'evidence/PUBLIC_AUTHORITY_EVIDENCE.json': 'research_public_authority_evidence',
      'evidence/PUBLIC_AUTHORITY_TRUST_SNAPSHOT.json': 'public_authority_trust_snapshot',
    };
    return entry(roles[relative], relative, content);
  });
}

function sealCapsule(packageDir, fixtureData) {
  const entries = capsuleEntries(fixtureData.files);
  const manifest = buildCampaignReleaseEvidenceCapsuleManifest({
    campaignId: 'campaign', paperId: 'paper', researchReportHash: fixtureData.researchReportHash,
    experimentRegistryHash: fixtureData.experimentRegistryHash,
    campaignResearchSourceSnapshotHash: hashRecord('CampaignSourceSnapshotFixture', {}),
    verifiedSourceMerkleHash: fixtureData.sourceMerkleHash,
    verifiedSourceWorkspaceManifestHash: fixtureData.sourceManifestHash,
    researchVerifyNodeId: 'campaign:research-verify', researchVerifyAttemptId: 'research-attempt',
    researchVerifyLeaseGeneration: 1, experiments: [fixtureData.experiment], entries,
    publicAuthorityTrustSnapshotHash: JSON.parse(fixtureData.files.get('evidence/PUBLIC_AUTHORITY_TRUST_SNAPSHOT.json')).publicAuthorityTrustSnapshotHash,
    createdAt: RELEASE_TIME,
  });
  for (const [relative, content] of fixtureData.files) {
    const candidate = path.join(packageDir, relative);
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(candidate, content);
  }
  const manifestBytes = jsonBytes(manifest);
  fs.writeFileSync(path.join(packageDir, 'evidence', 'CAPSULE_MANIFEST.json'), manifestBytes);
  const attestation = fixtureData.releaseAttest({ manifest, manifestFileHash: hashBytes(manifestBytes) });
  const attestationBytes = jsonBytes(attestation);
  fs.writeFileSync(path.join(packageDir, 'evidence', 'CAPSULE_MANIFEST.external-attestation.json'), attestationBytes);
  const sums = [
    ...entries,
    entry('research_evidence_capsule_manifest', 'evidence/CAPSULE_MANIFEST.json', manifestBytes),
    entry('research_execution_release_attestation', 'evidence/CAPSULE_MANIFEST.external-attestation.json', attestationBytes),
  ]
    .map((item) => `${item.hash.slice('sha256:'.length)}  ${item.path}`).join('\n');
  fs.writeFileSync(path.join(packageDir, 'SHA256SUMS.txt'), `${sums}\n`);
  return manifest;
}

function resealTrustSnapshot(data, mutate) {
  const relative = 'evidence/PUBLIC_AUTHORITY_TRUST_SNAPSHOT.json';
  const snapshot = JSON.parse(data.files.get(relative));
  mutate(snapshot);
  delete snapshot.publicAuthorityTrustSnapshotHash;
  snapshot.publicAuthorityTrustSnapshotHash = hashRecord('CampaignReleasePublicAuthorityTrustSnapshot', snapshot);
  data.files.set(relative, jsonBytes(snapshot));
  const authorityRelative = 'evidence/PUBLIC_AUTHORITY_EVIDENCE.json';
  const authority = JSON.parse(data.files.get(authorityRelative));
  authority.publicAuthorityTrustSnapshotHash = snapshot.publicAuthorityTrustSnapshotHash;
  data.files.set(authorityRelative, jsonBytes(authority));
}

test('academic release capsule verifies after copying and fails closed for missing or changed raw bytes', (t) => {
  const { root, packageDir } = fixture(t);
  const data = academicCapsuleFiles();
  const manifest = sealCapsule(packageDir, data);
  assert.equal(verifyCampaignReleaseEvidenceCapsuleManifest(manifest, { academicEvidenceRequired: true }).valid, true);
  const initialVerification = verifyCampaignReleaseEvidenceCapsuleDirectory({ packageDir, expected: trustedExpected(data) });
  assert.equal(initialVerification.valid, true, JSON.stringify(initialVerification.blockers));

  const copied = path.join(root, 'copied');
  fs.cpSync(packageDir, copied, { recursive: true });
  assert.equal(verifyCampaignReleaseEvidenceCapsuleDirectory({ packageDir: copied, expected: trustedExpected(data) }).valid, true);
  const originalRaw = path.join(copied, 'evidence', 'experiments', 'experiment-1', 'original', 'raw-events.ndjson');
  fs.rmSync(originalRaw);
  let blocked = verifyCampaignReleaseEvidenceCapsuleDirectory({ packageDir: copied, expected: trustedExpected(data) });
  assert.equal(blocked.valid, false);
  assert.ok(blocked.blockers.some((item) => item.includes('research_evidence_capsule_file_missing')));

  fs.cpSync(packageDir, copied, { recursive: true, force: true });
  fs.appendFileSync(originalRaw, '{"tampered":true}\n');
  blocked = verifyCampaignReleaseEvidenceCapsuleDirectory({ packageDir: copied, expected: trustedExpected(data) });
  assert.equal(blocked.valid, false);
  assert.ok(blocked.blockers.some((item) => item.includes('research_evidence_capsule_file_hash_mismatch')));
});

test('academic offline verification requires an independently supplied public-key root', (t) => {
  const { packageDir } = fixture(t);
  const data = academicCapsuleFiles();
  sealCapsule(packageDir, data);
  const unanchored = verifyCampaignReleaseEvidenceCapsuleDirectory({
    packageDir,
    expected: { verificationTime: VERIFY_TIME },
  });
  assert.equal(unanchored.valid, false);
  assert.equal(unanchored.packageInternalCryptographicConsistencyVerified, true, JSON.stringify(unanchored.blockers));
  assert.equal(unanchored.externalAuthorityTrustAnchorVerified, false);
  assert.equal(unanchored.capsuleManifestExternalSignatureVerified, false);
  assert.equal(unanchored.recordedExecutionLineageExternallyAttested, false);
  assert.equal(unanchored.executionAuthenticityExternallyAttested, false);
  assert.equal(unanchored.offlineCryptographicAuthorityVerified, false);
  assert.ok(unanchored.blockers.some((blocker) => blocker.includes('external_trust_anchor_required')));

  const anchored = verifyCampaignReleaseEvidenceCapsuleDirectory({
    packageDir,
    expected: trustedExpected(data),
  });
  assert.equal(anchored.valid, true);
  assert.equal(anchored.packageInternalCryptographicConsistencyVerified, true);
  assert.equal(anchored.externalAuthorityTrustAnchorVerified, true);
  assert.equal(anchored.offlineCryptographicAuthorityVerified, true);
  assert.equal(anchored.capsuleManifestExternalSignatureVerified, true);
  assert.equal(anchored.recordedExecutionLineageExternallyAttested, true);
  assert.equal(anchored.executionAuthenticityExternallyAttested, false);
});

test('academic capsule rejects package-local replacement signing and release-root state or role mismatches', (t) => {
  const { root, packageDir } = fixture(t);
  const victim = academicCapsuleFiles();
  const attacker = releaseAttestorAuthority();
  victim.releaseAttest = attacker.attest;
  sealCapsule(packageDir, victim);
  let verification = verifyCampaignReleaseEvidenceCapsuleDirectory({
    packageDir,
    expected: trustedExpected(victim),
  });
  assert.equal(verification.valid, false);
  assert.equal(verification.executionAuthenticityExternallyAttested, false);
  assert.ok(verification.blockers.some((blocker) => blocker.includes('attestation_signature_invalid')));

  const variants = [
    { label: 'wrong-role', update: (rootKey) => ({ ...rootKey, roles: ['dataset_harness_operator'] }) },
    { label: 'revoked', update: (rootKey) => ({ ...rootKey, status: 'revoked', revoked: true, revokedAt: RELEASE_TIME }) },
    { label: 'expired', update: (rootKey) => ({ ...rootKey, expiresAt: RELEASE_TIME }) },
    { label: 'not-valid-at-signing', update: (rootKey) => ({ ...rootKey, effectiveFrom: '2026-07-15T00:30:00.000Z' }) },
  ];
  for (const variant of variants) {
    const variantPackage = path.join(root, variant.label);
    const data = academicCapsuleFiles();
    fs.mkdirSync(variantPackage, { recursive: true });
    sealCapsule(variantPackage, data);
    verification = verifyCampaignReleaseEvidenceCapsuleDirectory({
      packageDir: variantPackage,
      expected: trustedExpected(data, { trustedReleaseRoots: data.trustedReleaseRoots.map(variant.update) }),
    });
    assert.equal(verification.valid, false, variant.label);
    assert.equal(verification.executionAuthenticityExternallyAttested, false, variant.label);
  }
});

test('release attestation verifier enforces the complete external-root identity and time policy', (t) => {
  const { packageDir } = fixture(t);
  const data = academicCapsuleFiles();
  const manifest = sealCapsule(packageDir, data);
  const attestation = JSON.parse(fs.readFileSync(
    path.join(packageDir, 'evidence', 'CAPSULE_MANIFEST.external-attestation.json'),
    'utf8',
  ));
  const manifestFileHash = hashBytes(jsonBytes(manifest));
  const verify = (trustedReleaseRoots, verificationTime = VERIFY_TIME) => (
    verifyOfflineResearchExecutionReleaseAttestation({
      attestation,
      manifest,
      manifestFileHash,
      trustedReleaseRoots,
      verificationTime,
    })
  );
  const [root] = data.trustedReleaseRoots;
  const valid = verify([root]);
  assert.equal(valid.valid, true);
  assert.equal(valid.capsuleManifestExternalSignatureVerified, true);
  assert.equal(valid.recordedExecutionLineageExternallyAttested, true);
  assert.equal(valid.executionAuthenticityExternallyAttested, false);
  assert.equal(verify([{ ...root, status: 'retiring' }]).valid, true);

  const cases = [
    ['wrong-version', [{ ...root, keyVersion: 'wrong-version' }], 'external_trust_root_missing'],
    ['wrong-subject', [{ ...root, subjectId: 'different-release-attestor' }], 'identity_mismatch'],
    ['wrong-organization', [{ ...root, organization: 'different-release-office' }], 'identity_mismatch'],
    ['wrong-spki', [{ ...root, publicKeySpkiHash: hashRecord('WrongReleaseSpki', {}) }], 'external_trust_root_invalid'],
    ['duplicate-key-id', [root, { ...root }], 'external_trust_root_invalid'],
    ['future-effective', [{ ...root, effectiveFrom: '2026-07-15T02:00:00.000Z' }], 'outside_time_window'],
    ['invalid-at-signature-time', [{ ...root, effectiveFrom: '2026-07-15T00:30:00.000Z' }], 'invalid_at_signature_time'],
    ['expired-after-signature', [{ ...root, expiresAt: '2026-07-15T00:30:00.000Z' }], 'outside_time_window'],
    ['revoked-after-signature', [{ ...root, revokedAt: '2026-07-15T00:30:00.000Z' }], 'revoked'],
  ];
  for (const [label, roots, blocker] of cases) {
    const result = verify(roots);
    assert.equal(result.valid, false, label);
    assert.equal(result.capsuleManifestExternalSignatureVerified, false, label);
    assert.equal(result.recordedExecutionLineageExternallyAttested, false, label);
    assert.equal(result.executionAuthenticityExternallyAttested, false, label);
    assert.ok(result.blockers.some((item) => item.includes(blocker)), `${label}:${result.blockers.join(',')}`);
  }
});

test('academic capsule rejects missing, extra, wrong-manifest, and fully resealed raw-result attestations', (t) => {
  const { root, packageDir } = fixture(t);
  const clean = academicCapsuleFiles();
  sealCapsule(packageDir, clean);
  const attestationPath = path.join(packageDir, 'evidence', 'CAPSULE_MANIFEST.external-attestation.json');
  fs.rmSync(attestationPath);
  let verification = verifyCampaignReleaseEvidenceCapsuleDirectory({ packageDir, expected: trustedExpected(clean) });
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.some((blocker) => blocker.includes('attestation_file_missing')));

  const wrongManifestPackage = path.join(root, 'wrong-manifest');
  const wrongManifest = academicCapsuleFiles();
  fs.mkdirSync(wrongManifestPackage, { recursive: true });
  sealCapsule(wrongManifestPackage, wrongManifest);
  const manifestPath = path.join(wrongManifestPackage, 'evidence', 'CAPSULE_MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.researchVerifyAttemptId = 'attacker-attempt';
  delete manifest.researchEvidenceCapsuleManifestHash;
  manifest.researchEvidenceCapsuleManifestHash = hashRecord('CampaignReleaseResearchEvidenceCapsuleManifest', manifest);
  fs.writeFileSync(manifestPath, jsonBytes(manifest));
  verification = verifyCampaignReleaseEvidenceCapsuleDirectory({
    packageDir: wrongManifestPackage,
    expected: trustedExpected(wrongManifest),
  });
  assert.equal(verification.valid, false);
  assert.equal(verification.capsuleManifestExternalSignatureVerified, false);

  const resealedPackage = path.join(root, 'resealed-raw');
  const resealed = academicCapsuleFiles();
  const attacker = releaseAttestorAuthority();
  const rawRelative = 'evidence/experiments/experiment-1/original/raw-events.ndjson';
  resealed.files.set(rawRelative, Buffer.from('{"version":1,"kind":"PublicRawEvent","value":999}\n'));
  const originalDescriptor = resealed.experiment.executions.find((item) => item.executionRole === 'original');
  originalDescriptor.rawEventArtifactHash = hashBytes(resealed.files.get(rawRelative));
  originalDescriptor.rawEventArtifactBytes = resealed.files.get(rawRelative).length;
  resealed.releaseAttest = attacker.attest;
  fs.mkdirSync(resealedPackage, { recursive: true });
  sealCapsule(resealedPackage, resealed);
  verification = verifyCampaignReleaseEvidenceCapsuleDirectory({
    packageDir: resealedPackage,
    expected: trustedExpected(resealed),
  });
  assert.equal(verification.valid, false);
  assert.equal(verification.executionAuthenticityExternallyAttested, false);
  assert.ok(verification.blockers.some((blocker) => blocker.includes('attestation_signature_invalid')));

  const extraPackage = path.join(root, 'extra-attestation');
  const extra = academicCapsuleFiles();
  fs.mkdirSync(extraPackage, { recursive: true });
  sealCapsule(extraPackage, extra);
  fs.copyFileSync(
    path.join(extraPackage, 'evidence', 'CAPSULE_MANIFEST.external-attestation.json'),
    path.join(extraPackage, 'evidence', 'CAPSULE_MANIFEST.external-attestation-copy.json'),
  );
  verification = verifyCampaignReleaseEvidenceCapsuleDirectory({ packageDir: extraPackage, expected: trustedExpected(extra) });
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.includes('research_evidence_capsule_unbound_or_missing_file'));
});

test('provisioned release attestor requires private regular files and never discloses key material', (t) => {
  const { root } = fixture(t);
  const pair = crypto.generateKeyPairSync('ed25519');
  const keyPath = path.join(root, 'release-key.pem');
  const configPath = path.join(root, 'attestor.json');
  fs.writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const configuration = {
    version: 1,
    kind: 'ResearchExecutionReleaseAttestorConfiguration',
    keyId: 'provisioned-release-key',
    subjectId: 'provisioned-release-attestor',
    organization: 'research-release-office',
    algorithm: 'ed25519',
    role: 'research_execution_release_attestor',
    status: 'active',
    revoked: false,
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-07-01T00:00:00.000Z',
    attestationLifetimeSeconds: 7 * 24 * 60 * 60,
    privateKeyPath: keyPath,
  };
  fs.writeFileSync(configPath, JSON.stringify(configuration), { mode: 0o600 });
  const inspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath,
    now: new Date(VERIFY_TIME),
  });
  const expectedPublicKeySpkiHash = hashBytes(pair.publicKey.export({ type: 'spki', format: 'der' }));
  assert.equal(inspection.ready, true);
  assert.equal(inspection.inspectedAt, VERIFY_TIME);
  assert.equal(inspection.keyId, configuration.keyId);
  assert.equal(inspection.subjectId, configuration.subjectId);
  assert.equal(inspection.organization, configuration.organization);
  assert.equal(inspection.role, configuration.role);
  assert.equal(inspection.algorithm, configuration.algorithm);
  assert.equal(inspection.publicKeySpkiHash, expectedPublicKeySpkiHash);
  assert.equal(inspection.privateKeyDisclosed, false);
  const {
    researchExecutionReleaseAttestorConfigurationInspectionHash: inspectionHash,
    ...inspectionPayload
  } = inspection;
  assert.equal(inspectionHash, hashRecord(
    'ResearchExecutionReleaseAttestorConfigurationInspection',
    inspectionPayload,
  ));
  const serializedInspection = JSON.stringify(inspection);
  assert.equal(serializedInspection.includes(configPath), false);
  assert.equal(serializedInspection.includes(keyPath), false);
  assert.equal(serializedInspection.includes('PRIVATE KEY'), false);
  assert.equal(Object.hasOwn(inspection, 'privateKeyPath'), false);

  const replacementPair = crypto.generateKeyPairSync('ed25519');
  const replacementKeyPath = path.join(root, 'replacement-release-key.pem');
  const replacementConfigPath = path.join(root, 'replacement-attestor.json');
  fs.writeFileSync(
    replacementKeyPath,
    replacementPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  fs.writeFileSync(replacementConfigPath, JSON.stringify({
    ...configuration,
    privateKeyPath: replacementKeyPath,
  }), { mode: 0o600 });
  const replacementInspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: replacementConfigPath,
    now: new Date(VERIFY_TIME),
  });
  assert.equal(replacementInspection.ready, true);
  assert.equal(replacementInspection.keyId, inspection.keyId);
  assert.notEqual(replacementInspection.publicKeySpkiHash, inspection.publicKeySpkiHash);
  assert.notEqual(
    replacementInspection.researchExecutionReleaseAttestorConfigurationInspectionHash,
    inspection.researchExecutionReleaseAttestorConfigurationInspectionHash,
  );
  const {
    researchExecutionReleaseAttestorConfigurationInspectionHash: replacementInspectionHash,
    ...replacementInspectionPayload
  } = replacementInspection;
  assert.equal(replacementInspectionHash, hashRecord(
    'ResearchExecutionReleaseAttestorConfigurationInspection',
    replacementInspectionPayload,
  ));

  const expiredInspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath,
    now: new Date(configuration.expiresAt),
  });
  assert.equal(expiredInspection.ready, false);
  assert.ok(expiredInspection.blockers.includes('research_execution_release_attestor_key_not_currently_valid'));
  const {
    researchExecutionReleaseAttestorConfigurationInspectionHash: expiredInspectionHash,
    ...expiredInspectionPayload
  } = expiredInspection;
  assert.equal(expiredInspectionHash, hashRecord(
    'ResearchExecutionReleaseAttestorConfigurationInspection',
    expiredInspectionPayload,
  ));
  const attestor = createResearchExecutionReleaseAttestor({
    configPath,
    clock: { now: () => new Date(RELEASE_TIME) },
  });
  const data = academicCapsuleFiles();
  const manifest = buildCampaignReleaseEvidenceCapsuleManifest({
    campaignId: 'campaign', paperId: 'paper', researchReportHash: data.researchReportHash,
    experimentRegistryHash: data.experimentRegistryHash,
    campaignResearchSourceSnapshotHash: hashRecord('CampaignSourceSnapshotFixture', {}),
    verifiedSourceMerkleHash: data.sourceMerkleHash,
    verifiedSourceWorkspaceManifestHash: data.sourceManifestHash,
    researchVerifyNodeId: 'campaign:research-verify', researchVerifyAttemptId: 'research-attempt',
    researchVerifyLeaseGeneration: 1, experiments: [data.experiment], entries: capsuleEntries(data.files),
    publicAuthorityTrustSnapshotHash: JSON.parse(data.files.get('evidence/PUBLIC_AUTHORITY_TRUST_SNAPSHOT.json')).publicAuthorityTrustSnapshotHash,
    createdAt: RELEASE_TIME,
  });
  const attestation = attestor.attestCapsuleManifest({
    manifest,
    manifestFileHash: hashBytes(jsonBytes(manifest)),
    signedAt: RELEASE_TIME,
  });
  assert.equal(attestation.role, 'research_execution_release_attestor');
  assert.equal(attestation.recordedExecutionLineageAttested, true);
  assert.equal(attestation.executionAuthenticityAttested, false);
  assert.equal(attestation.privateKeyIncluded, false);
  assert.equal(attestation.publicKeyIncluded, false);
  assert.doesNotMatch(JSON.stringify(attestation), /PRIVATE KEY/);
  assert.equal(JSON.stringify(attestation).includes(keyPath), false);
  assert.equal(attestor.verifyAttestation({
    attestation,
    manifest,
    manifestFileHash: hashBytes(jsonBytes(manifest)),
  }), true);
  const detachedPayloadHash = hashRecord('DetachedQualificationFixture', { manifestHash: manifest.researchEvidenceCapsuleManifestHash });
  const detachedSignature = crypto.sign(null, Buffer.from(detachedPayloadHash, 'utf8'), pair.privateKey).toString('base64');
  assert.equal(attestor.verifyDetachedSignature({
    signingPayloadHash: detachedPayloadHash,
    signature: detachedSignature,
    signedAt: RELEASE_TIME,
    signer: {
      keyId: 'provisioned-release-key',
      keyVersion: 'legacy-v1',
      subjectId: 'provisioned-release-attestor',
      organization: 'research-release-office',
      role: 'research_execution_release_attestor',
      algorithm: 'ed25519',
    },
  }), true);
  assert.equal(attestor.verifyDetachedSignature({
    signingPayloadHash: hashRecord('DetachedQualificationFixture', { manifestHash: 'attacker' }),
    signature: detachedSignature,
    signedAt: RELEASE_TIME,
    signer: {
      keyId: 'provisioned-release-key',
      keyVersion: 'legacy-v1',
      subjectId: 'provisioned-release-attestor',
      organization: 'research-release-office',
      role: 'research_execution_release_attestor',
      algorithm: 'ed25519',
    },
  }), false);
  fs.chmodSync(configPath, 0o644);
  const permissionBlockedInspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath,
    now: new Date(VERIFY_TIME),
  });
  assert.equal(permissionBlockedInspection.ready, false);
  assert.ok(permissionBlockedInspection.blockers.includes(
    'research_execution_release_attestor_config_not_private_regular_file',
  ));
  assert.equal(permissionBlockedInspection.privateKeyDisclosed, false);
  assert.equal(permissionBlockedInspection.publicKeySpkiHash, null);
  const {
    researchExecutionReleaseAttestorConfigurationInspectionHash: permissionBlockedInspectionHash,
    ...permissionBlockedInspectionPayload
  } = permissionBlockedInspection;
  assert.equal(permissionBlockedInspectionHash, hashRecord(
    'ResearchExecutionReleaseAttestorConfigurationInspection',
    permissionBlockedInspectionPayload,
  ));
  assert.equal(JSON.stringify(permissionBlockedInspection).includes(configPath), false);
  assert.equal(JSON.stringify(permissionBlockedInspection).includes(keyPath), false);
});

test('a fully self-signed attacker authority remains internally consistent but fails the external root pin', () => {
  const victim = signedOfflineAuthority();
  const attacker = signedOfflineAuthority();
  const attackerInternal = verifyOfflineOperatorDatasetAuthorityEvidence({
    evidence: attacker.evidence,
    trustSnapshot: attacker.trustSnapshot,
    trustedAuthorityRoots: attacker.trustedAuthorityRoots,
    verificationTime: VERIFY_TIME,
  });
  assert.equal(attackerInternal.valid, true);
  const externallyChecked = verifyOfflineOperatorDatasetAuthorityEvidence({
    evidence: attacker.evidence,
    trustSnapshot: attacker.trustSnapshot,
    trustedAuthorityRoots: victim.trustedAuthorityRoots,
    verificationTime: VERIFY_TIME,
  });
  assert.equal(externallyChecked.valid, false);
  assert.equal(externallyChecked.packageInternalCryptographicConsistencyVerified, true);
  assert.equal(externallyChecked.externalTrustAnchorVerified, false);
  assert.ok(externallyChecked.blockers.some((blocker) => blocker.includes('external_trust_anchor_mismatch')));

  const externallyRevoked = verifyOfflineOperatorDatasetAuthorityEvidence({
    evidence: victim.evidence,
    trustSnapshot: victim.trustSnapshot,
    trustedAuthorityRoots: victim.trustedAuthorityRoots.map((root) => ({
      ...root, status: 'revoked', revoked: true, revokedAt: RELEASE_TIME,
    })),
    verificationTime: VERIFY_TIME,
  });
  assert.equal(externallyRevoked.valid, false);
  assert.equal(externallyRevoked.packageInternalCryptographicConsistencyVerified, true);
  assert.ok(externallyRevoked.blockers.some((blocker) => blocker.includes('external_trust_anchor_mismatch')));
});

test('offline verifier rejects a correctly resealed public capsule containing host paths', (t) => {
  const { packageDir } = fixture(t);
  const data = academicCapsuleFiles();
  const authorityPath = 'evidence/PUBLIC_AUTHORITY_EVIDENCE.json';
  const authority = JSON.parse(data.files.get(authorityPath));
  authority.experiments[0].hostEvidencePath = '/home/operator/private/runtime/evidence.json';
  data.files.set(authorityPath, jsonBytes(authority));
  sealCapsule(packageDir, data);
  const verification = verifyCampaignReleaseEvidenceCapsuleDirectory({ packageDir, expected: trustedExpected(data) });
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.some((item) => item.includes('host_absolute_path')));
});

test('academic capsule contract rejects an incomplete exact role set', () => {
  const data = academicCapsuleFiles();
  assert.throws(() => buildCampaignReleaseEvidenceCapsuleManifest({
    campaignId: 'campaign', paperId: 'paper', researchReportHash: data.researchReportHash,
    experimentRegistryHash: data.experimentRegistryHash,
    verifiedSourceMerkleHash: data.sourceMerkleHash,
    verifiedSourceWorkspaceManifestHash: data.sourceManifestHash,
    researchVerifyNodeId: 'campaign:research-verify', researchVerifyAttemptId: 'research-attempt',
    researchVerifyLeaseGeneration: 1, experiments: [data.experiment],
    publicAuthorityTrustSnapshotHash: JSON.parse(data.files.get('evidence/PUBLIC_AUTHORITY_TRUST_SNAPSHOT.json')).publicAuthorityTrustSnapshotHash,
    entries: capsuleEntries(data.files).filter((item) => !(item.role === 'experiment_raw_events' && item.executionRole === 'independent-replay')),
    createdAt: '2026-07-15T00:00:00.000Z',
  }), /research_evidence_capsule_exact_role_binding_invalid/);
});

test('offline signature verification rejects a correctly resealed capsule with a substituted public key', (t) => {
  const { packageDir } = fixture(t);
  const data = academicCapsuleFiles();
  const replacement = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  resealTrustSnapshot(data, (snapshot) => { snapshot.keys[0].publicKeyPem = replacement; });
  sealCapsule(packageDir, data);
  const verification = verifyCampaignReleaseEvidenceCapsuleDirectory({ packageDir, expected: trustedExpected(data) });
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.some((blocker) => blocker.includes('authority_signature_invalid')));
});

test('offline verification rejects revoked keys and expired authority at verification time', (t) => {
  const { root, packageDir } = fixture(t);
  const revoked = academicCapsuleFiles();
  resealTrustSnapshot(revoked, (snapshot) => {
    snapshot.keys[0].status = 'revoked';
    snapshot.keys[0].revoked = true;
    snapshot.keys[0].revokedAt = RELEASE_TIME;
  });
  sealCapsule(packageDir, revoked);
  let verification = verifyCampaignReleaseEvidenceCapsuleDirectory({ packageDir, expected: trustedExpected(revoked) });
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.some((blocker) => blocker.includes('offline_authority_key_revoked')));

  const expiredPackage = path.join(root, 'expired');
  const expired = academicCapsuleFiles();
  fs.mkdirSync(expiredPackage, { recursive: true });
  sealCapsule(expiredPackage, expired);
  verification = verifyCampaignReleaseEvidenceCapsuleDirectory({
    packageDir: expiredPackage,
    expected: trustedExpected(expired, { verificationTime: '2026-08-15T00:00:00.000Z' }),
  });
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.some((blocker) => blocker.includes('authority_expired')));
});

test('offline verification rejects resealed AnalysisProtocol binding changes and unbound extra files', (t) => {
  const { root, packageDir } = fixture(t);
  const data = academicCapsuleFiles();
  const relative = 'evidence/PUBLIC_AUTHORITY_EVIDENCE.json';
  const authority = JSON.parse(data.files.get(relative));
  const evidence = authority.experiments[0].offlineOperatorDatasetAuthorityEvidence;
  evidence.executions.original.authorityReceipt.analysisProtocolHash = hashRecord('TamperedAnalysisProtocol', {});
  const receipt = evidence.executions.original.authorityReceipt;
  delete receipt.operatorDatasetHarnessAuthorityReceiptHash;
  receipt.operatorDatasetHarnessAuthorityReceiptHash = hashRecord('OperatorDatasetHarnessAuthorityReceipt', receipt);
  delete evidence.offlineOperatorDatasetAuthorityEvidenceHash;
  evidence.offlineOperatorDatasetAuthorityEvidenceHash = hashRecord('OfflineOperatorDatasetAuthorityEvidence', evidence);
  data.files.set(relative, jsonBytes(authority));
  sealCapsule(packageDir, data);
  let verification = verifyCampaignReleaseEvidenceCapsuleDirectory({ packageDir, expected: trustedExpected(data) });
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.some((blocker) => blocker.includes('authority_receipt_structure_invalid')));

  const extraPackage = path.join(root, 'extra');
  const clean = academicCapsuleFiles();
  fs.mkdirSync(extraPackage, { recursive: true });
  sealCapsule(extraPackage, clean);
  fs.writeFileSync(path.join(extraPackage, 'evidence', 'UNBOUND.json'), '{}\n');
  verification = verifyCampaignReleaseEvidenceCapsuleDirectory({ packageDir: extraPackage, expected: trustedExpected(clean) });
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.includes('research_evidence_capsule_unbound_or_missing_file'));
});

test('offline verification rejects a canonically rehashed EnvironmentBOM detached from the registry and release descriptor', (t) => {
  const { packageDir } = fixture(t);
  const data = academicCapsuleFiles();
  const relative = 'evidence/ENVIRONMENT_MANIFEST.json';
  const environment = JSON.parse(data.files.get(relative));
  const original = environment.experiments[0].executions.find((item) => item.executionRole === 'original');
  const bom = original.environmentBom;
  const replacement = buildEmpiricalEnvironmentBom({
    platform: bom.platform,
    runtime: bom.runtime,
    gpu: bom.gpu,
    numericRuntime: bom.numericRuntime,
    limits: { ...bom.limits, maximumPids: bom.limits.maximumPids + 1 },
    determinism: bom.determinism,
    buildReproducibility: bom.buildReproducibility,
    observedClaims: bom.observedClaims,
    unobservedClaims: bom.unobservedClaims,
  });
  original.environmentBom = replacement;
  original.environmentBomHash = replacement.environmentBomHash;
  environment.experiments[0].originalEnvironmentBomHash = replacement.environmentBomHash;
  data.files.set(relative, jsonBytes(environment));
  sealCapsule(packageDir, data);
  const verification = verifyCampaignReleaseEvidenceCapsuleDirectory({ packageDir, expected: trustedExpected(data) });
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.includes('research_evidence_capsule_experiment_public_lineage_invalid'));
});
