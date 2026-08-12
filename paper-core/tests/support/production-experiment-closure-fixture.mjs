import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  signAuthorityDocument,
} from '../../../paper-adapters/authority/authority-signatures.mjs';
import {
  authorizeOperatorDatasetMount,
} from '../../../paper-adapters/automation/operator-dataset-harness-reader.mjs';
import {
  executeSystemBenchmarkHarness,
} from '../../../paper-adapters/automation/system-benchmark-harness.mjs';
import {
  RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT,
} from '../../../paper-adapters/research-verify/independent-system-benchmark-recomputation.mjs';
import {
  readEmpiricalClaimUniverse,
} from '../../../paper-adapters/research-verify/empirical-claim-universe-reader.mjs';
import {
  inspectStrictDatasetManifest,
} from '../../../paper-adapters/runtime/execution-snapshot.mjs';
import {
  runRawEventRecomputationInSandboxTestFixture,
} from './raw-event-recomputation-sandbox-fixture.mjs';
import {
  buildCanonicalAnalysisProtocol,
  empiricalClaimDeclarationsFromAnalysisProtocol,
} from '../../../paper-domain/automation/analysis-protocol-contract.mjs';
import {
  buildCampaignBenchmarkSelector,
} from '../../../paper-domain/automation/campaign-benchmark-selector.mjs';
import {
  buildExperimentIrExecutionAuthorityReceipt,
} from '../../../paper-domain/automation/experiment-ir-execution-authority-contract.mjs';
import {
  buildDatasetAuthorizationSet,
  buildExperimentReplayReceipt,
  buildExperimentRunReceipt,
} from '../../../paper-domain/automation/experiment-run-contract.mjs';
import {
  buildEmpiricalEnvironmentBom,
} from '../../../paper-domain/automation/environment-bom-contract.mjs';
import {
  campaignExperimentArtifactRole,
} from '../../../paper-domain/research/campaign-experiment-artifact-identity.mjs';
import {
  empiricalProtocolBindings,
} from '../../../paper-domain/research/campaign-experiment-claim-lineage.mjs';
import {
  buildExperimentRegistry,
} from '../../../paper-domain/research/experiment-registry.mjs';
import {
  createExperimentRegistryAuthorityVerifier,
} from '../../../paper-domain/research/experiment-registry-authority.mjs';
import {
  resolveReceiptIssuerPolicy,
} from '../../../paper-domain/evidence/receipt-issuer-policy-registry.mjs';
import {
  validateOperatorDatasetHarnessDefinition,
  validateOperatorDatasetResearchSemantics,
  validateOperatorDatasetSplitManifest,
} from '../../../paper-domain/automation/operator-dataset-harness-contract.mjs';
import {
  systemBenchmarkArmBatchChallengeEnvironment,
} from '../../../paper-domain/automation/system-benchmark-challenge.mjs';
import { hashBytes, hashRecord } from '../../../workflow-kernel/record-hash.mjs';

const FAMILY = 'ml_algorithm_benchmark';
const PROCESS_CACHE = new Map();
const RECOMPUTATION_INDEPENDENCE_LEVEL =
  'repository-separate-implementation-same-process-v1';

const RECEIPT_POLICY = Object.freeze({
  ArtifactWriteReceipt: 'artifact-repository',
  ExperimentWorkerExecutionReceipt: 'experiment-worker',
  ExperimentReproducibilityReceipt: 'experiment-reproducibility',
});

function createMemoryReceiptLedger() {
  const rows = new Map();
  let ordinal = 0;
  return Object.freeze({
    add(receipt) {
      const policyId = RECEIPT_POLICY[receipt?.kind];
      const policy = resolveReceiptIssuerPolicy(policyId);
      if (!policy) throw new Error(`production_fixture_receipt_policy_missing:${receipt?.kind}`);
      ordinal += 1;
      const ledgerReceiptId = receipt.kind === 'ArtifactWriteReceipt'
        ? `artifact-writes:production-closure:${ordinal}`
        : `production-closure:${ordinal}:${receipt.kind}`;
      const receiptHash = receipt.writeReceiptHash || receipt.receiptHash;
      rows.set(ledgerReceiptId, Object.freeze({
        receipt_id: ledgerReceiptId,
        receipt_sha256: receiptHash,
        receipt_json: JSON.stringify(receipt),
        kind: receipt.kind,
        status: receipt.status || 'recorded',
        stream: policy.allowedStreams[0],
        paper_id: receipt.paperId || null,
        writer_id: policy.writerId,
        writer_kind: policy.writerKind,
        writer_trusted: 1,
        issuer_policy_id: policyId,
        issuer_policy_hash: policy.issuerPolicyHash,
        issuer_assurance: policy.assurance,
      }));
      return Object.freeze({ ...receipt, ledgerReceiptId });
    },
    get(receiptId) { return rows.get(receiptId) || null; },
  });
}

function sealLedgerReceipt(kind, payload) {
  const versioned = { ...payload, version: payload.version || 1, kind };
  return Object.freeze({
    ...versioned,
    receiptHash: hashRecord(kind, versioned),
  });
}

function verifyFixtureArtifactSource({ receipt } = {}) {
  const {
    ledgerReceiptId: _ledgerReceiptId,
    writeReceiptHash: claimedHash,
    ...payload
  } = receipt || {};
  const valid = receipt?.kind === 'ArtifactWriteReceipt'
    && claimedHash === hashRecord('ArtifactWriteReceipt', payload);
  return Object.freeze({
    status: valid
      ? 'artifact_write_receipt_source_verified'
      : 'artifact_write_receipt_source_blocked',
    blockers: valid ? Object.freeze([]) : Object.freeze([
      'production_fixture_artifact_receipt_invalid',
    ]),
  });
}

function digest(label) {
  return hashRecord('ProductionExperimentClosureFixture', { label });
}

export function assertProductionExperimentClosureResult(result = {}) {
  for (const [role, runReceipt, document] of [
    [
      'original',
      result.originalRunReceipt,
      result.originalRawEventDocument,
    ],
    [
      'independent-replay',
      result.replayRunReceipt,
      result.replayRawEventDocument,
    ],
  ]) {
    if (!Buffer.isBuffer(document)
      || hashBytes(document) !== runReceipt?.rawEventArtifactHash
      || document.length !== Number(runReceipt?.rawEventArtifactBytes)) {
      throw new Error(`production_experiment_closure_raw_export_invalid:${role}`);
    }
  }
  return Object.freeze(result);
}

function responseDocument(batch) {
  const cells = batch.challenge.cells.map(({ cellId, challenge }) => ({
    cellId,
    systemBenchmarkCellChallengeHash: challenge.systemBenchmarkCellChallengeHash,
    responses: challenge.cases.map((item) => {
      let prediction = 0;
      if (batch.arm === 'treatment') {
        prediction = item.input.primary + (0.35 * item.input.secondary) >= 0 ? 1 : 0;
      } else if (batch.arm === 'ablation') {
        prediction = item.input.secondary >= 0 ? 1 : 0;
      } else {
        prediction = item.referenceResponse;
      }
      return { caseId: item.caseId, prediction };
    }),
  }));
  return Buffer.from(`${JSON.stringify({
    version: 1,
    kind: 'CampaignBenchmarkArmBatchResponses',
    systemBenchmarkArmBatchChallengeHash:
      batch.challenge.systemBenchmarkArmBatchChallengeHash,
    cells,
  })}\n`);
}

function armAdapterSet(selector) {
  const protocols = selector.experimentDesign.benchmarkHarness.armProtocolSet.protocols;
  const adapters = protocols.map((protocol, index) => Object.freeze({
    version: 1,
    kind: 'SystemBenchmarkArmAdapterIdentity',
    arm: protocol.arm,
    relativePath: `run.${protocol.arm}.py`,
    sourceHash: digest(`arm-adapter:${protocol.arm}`),
    systemBenchmarkArmProtocolHash: protocol.systemBenchmarkArmProtocolHash,
    sourceReadReceiptHash: digest(`arm-adapter-read:${index}`),
  }));
  const payload = {
    version: 1,
    kind: 'SystemBenchmarkArmAdapterSet',
    entrypointConvention: 'sibling-arm-entrypoints-v1',
    adapters,
  };
  return Object.freeze({
    ...payload,
    systemBenchmarkArmAdapterSetHash:
      hashRecord('SystemBenchmarkArmAdapterSet', payload),
  });
}

function workerReceipt({
  batch,
  content,
  datasetMount,
  processOrdinal,
  sourceMerkleHash,
  sourceWorkspaceManifestHash,
}) {
  const artifacts = Object.freeze([Object.freeze({
    path: 'observation.json',
    sha256: hashBytes(content),
    bytes: content.length,
  })]);
  const receiptMount = Object.freeze({
    ...datasetMount,
    target: `/datasets/${datasetMount.name}`,
  });
  const authorizationSet = buildDatasetAuthorizationSet([receiptMount]);
  const bindings = Object.freeze({
    HEPTA_BENCHMARK_ID: batch.benchmarkId,
    HEPTA_BENCHMARK_SELECTOR_HASH: batch.selectorHash,
    HEPTA_EXPERIMENT_DESIGN_HASH: batch.designHash,
    HEPTA_BENCHMARK_HARNESS_HASH: batch.harnessHash,
    HEPTA_EXPERIMENT_RUN_ID: batch.experimentAttemptId,
    HEPTA_EXPERIMENT_ATTEMPT_ID: batch.executionAttemptId,
    HEPTA_EXPERIMENT_ARM: batch.arm,
    HEPTA_EXPERIMENT_ARM_PROTOCOL_ID: batch.armProtocol.protocolId,
    HEPTA_EXPERIMENT_ARM_PROTOCOL_HASH: batch.systemBenchmarkArmProtocolHash,
    HEPTA_EXPERIMENT_ARM_PROTOCOL_SET_HASH: batch.armProtocolSetHash,
    HEPTA_EXPERIMENT_ARM_ADAPTER_PATH: batch.armAdapter.relativePath,
    HEPTA_EXPERIMENT_ARM_ADAPTER_HASH: batch.armAdapter.sourceHash,
    HEPTA_EXPERIMENT_ARM_ADAPTER_SET_HASH: batch.armAdapterSetHash,
    HEPTA_PRE_DATA_ACCESS_FREEZE_HASH: batch.empiricalPreDataAccessFreezeHash,
    HEPTA_EXPERIMENT_IR_HASH: batch.versionedExperimentIrHash,
    HEPTA_EXPERIMENT_RESEARCH_BINDING_HASH:
      batch.experimentResearchBindingHash,
    HEPTA_DATASET_RESEARCH_COMPATIBILITY_HASH:
      batch.datasetResearchCompatibilityHash,
    HEPTA_EXPERIMENT_SEED: String(batch.cells[0].seed),
    HEPTA_EXPERIMENT_REPETITION: String(batch.cells[0].repetition),
    HEPTA_HARNESS_CELL_ID: batch.cells[0].cellId,
    HEPTA_SEED: String(batch.cells[0].seed),
    PYTHONHASHSEED: String(batch.cells[0].seed),
    ...systemBenchmarkArmBatchChallengeEnvironment(batch.challenge),
    HEPTA_DATASET_AUTHORIZATION_SET_HASH:
      authorizationSet.datasetAuthorizationSetHash,
  });
  const limits = Object.freeze({
    timeoutMs: batch.resourceBudget.timeoutMs,
    memoryBytes: batch.resourceBudget.memoryBytes,
    cpuSeconds: batch.resourceBudget.cpuSeconds,
    maximumPids: batch.resourceBudget.maximumProcesses,
    maximumOutputBytes: 256 * 1024 * 1024,
    maximumCapturedBytes: 4 * 1024 * 1024,
  });
  const environmentBom = buildEmpiricalEnvironmentBom({
    platform: {
      operatingSystem: 'linux',
      architecture: 'x64',
      kernelReleaseHash: digest('kernel-release'),
      cpu: {
        modelHash: digest('cpu-model'),
        flagsHash: digest('cpu-flags'),
        logicalProcessorCount: 1,
        observation: 'fixture',
      },
    },
    runtime: {
      type: 'host',
      identityHash: digest('runtime-identity'),
      language: 'python',
      hostExecutableHash: digest('python-executable'),
      packageClosure: {
        basis: 'unobserved', identityHash: null, manifestHash: null,
        observedPackageCount: 0,
      },
    },
    gpu: { required: false, status: 'not_required', deviceCount: 0 },
    numericRuntime: {
      threads: {}, dynamicThreadingDisabled: false,
      explicitSingleThreadPolicy: false, policyObservation: 'fixture',
    },
    limits,
    determinism: { classification: 'unknown' },
    buildReproducibility: { status: 'not_assessed' },
    observedClaims: ['fixture-runtime-identity'],
    unobservedClaims: ['package-closure'],
  });
  const executionProcessIdentity = Object.freeze({
    version: 1,
    kind: 'OsSandboxWorkerProcessIdentity',
    processInvocationId: digest(
      `process:${batch.executionAttemptId}:${processOrdinal}`,
    ),
    launcherPid: 10_000 + processOrdinal,
  });
  const datasetAccessPayload = {
    version: 2,
    kind: 'DatasetRuntimeAccessReceipt',
    status: 'dataset_runtime_access_verified',
    tracer: 'host-supervisor-strace-open-read-v2',
    traceAuthority: 'host-supervisor-outside-child-mount-namespace-v1',
    readObservationAssurance:
      'positive-return-byte-observation-not-computational-use-proof-v1',
    traceSha256: digest(`dataset-trace:${batch.executionAttemptId}`),
    datasets: [Object.freeze({
      name: receiptMount.name,
      target: receiptMount.target,
      manifestHash: receiptMount.manifestHash,
      operatorAuthorizationHash: receiptMount.operatorAuthorizationHash,
      workerExposureManifestHash: receiptMount.splitManifestHash,
      hostOnlyHarnessMounted: false,
      forbiddenReadObserved: false,
      readObserved: true,
      positiveReadObservationEventCount: 1,
      positiveReadBytesObserved: 1,
      positiveReadObservationHash:
        digest(`dataset-read:${batch.executionAttemptId}`),
    })],
    blockers: [],
  };
  const payload = {
    version: 4,
    kind: 'OsSandboxWorkerReceipt',
    runnerId: 'fixture-kernel-isolation-worker-v4',
    backend: 'fixture',
    status: 'os_sandbox_worker_passed',
    sourceMerkleHashBefore: sourceMerkleHash,
    sourceMerkleHashAfter: sourceMerkleHash,
    sourceWorkspaceManifestHashBefore: sourceWorkspaceManifestHash,
    sourceWorkspaceManifestHashAfter: sourceWorkspaceManifestHash,
    workSourceMerkleHash: sourceMerkleHash,
    workWorkspaceManifestHash: sourceWorkspaceManifestHash,
    limits,
    runtimeIdentityType: 'host',
    runtimeIdentityHash: digest('runtime-identity'),
    executionProcessIdentity,
    executionProcessIdentityHash:
      hashRecord('OsSandboxWorkerProcessIdentity', executionProcessIdentity),
    environmentBom,
    environmentBomHash: environmentBom.environmentBomHash,
    environmentBindingHash: hashRecord('WorkerEnvironmentBinding', bindings),
    executionBindings: bindings,
    datasetAuthorizationSetHash: authorizationSet.datasetAuthorizationSetHash,
    datasetMounts: [receiptMount],
    datasetAccessReceipt: Object.freeze({
      ...datasetAccessPayload,
      datasetRuntimeAccessReceiptHash:
        hashRecord('DatasetRuntimeAccessReceipt', datasetAccessPayload),
    }),
    artifacts,
    artifactManifestHash: hashRecord('OsSandboxWorkerArtifactManifest', artifacts),
    isolation: Object.freeze({
      kernelNetworkIsolationVerified: true,
      sourceReadOnlyVerified: true,
      ephemeralWorkRootVerified: true,
      separateOutputRootVerified: true,
      gpuAccessRequested: false,
    }),
    externalActionPerformed: false,
  };
  return Object.freeze({
    ok: true,
    ...payload,
    receiptHash: hashRecord('OsSandboxWorkerReceipt', payload),
    blockers: Object.freeze([]),
  });
}

function buildDatasetFixture({
  root,
  researchAgendaIr,
  proposal,
  empiricalManuscriptClaimText = null,
}) {
  const datasetRoot = path.join(root, 'dataset');
  const runtimeRoot = path.join(root, 'runtime');
  const outputRoot = path.join(root, 'output');
  fs.mkdirSync(datasetRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(datasetRoot, 'train.csv'),
    'outcome,treatment_assignment,covariate\n1,1,0\n',
    { mode: 0o600 },
  );
  const inspection = inspectStrictDatasetManifest(datasetRoot, datasetRoot);
  if (inspection.blockers.length) {
    throw new Error(`production_fixture_dataset_manifest:${inspection.blockers.join(',')}`);
  }
  const benchmarkId = 'production-closure-benchmark';
  const seedSchedule = Object.freeze([17, 23, 31, 43]);
  const minimumRepetitions = 8;
  const cells = seedSchedule.flatMap((seed) => Array.from(
    { length: minimumRepetitions },
    (_, repetitionIndex) => ({
      seed,
      repetition: repetitionIndex + 1,
      cases: Array.from({ length: 8 }, (_, caseIndex) => {
        const primary = caseIndex < 4 ? -1 : 1;
        const secondary = repetitionIndex % 2 ? -0.2 : 0.2;
        const label = primary + (0.35 * secondary) >= 0 ? 1 : 0;
        return {
          caseId: digest(`case:${seed}:${repetitionIndex + 1}:${caseIndex}`),
          input: { primary, secondary },
          ablationInput: { secondary },
          referenceResponse: 0,
          oracle: { label, robustLabel: label },
        };
      }),
    }),
  ));
  const definition = Object.freeze({
    version: 1,
    kind: 'OperatorAuthorizedDatasetBenchmarkHarness',
    benchmarkId,
    benchmarkFamily: FAMILY,
    seedSchedule,
    minimumRepetitions,
    cells,
  });
  const definitionHash = validateOperatorDatasetHarnessDefinition(
    definition, { benchmarkId },
  ).operatorDatasetHarnessDefinitionHash;
  const splitManifest = Object.freeze({
    version: 1,
    kind: 'OperatorDatasetSplitManifest',
    datasetName: benchmarkId,
    datasetManifestHash: inspection.hash,
    entries: inspection.entries
      .filter((entry) => entry.type === 'file')
      .map((entry) => Object.freeze({
        path: entry.relative, sha256: entry.hash, split: 'train',
      })),
  });
  const splitManifestHash = validateOperatorDatasetSplitManifest(
    splitManifest,
    { datasetName: benchmarkId, datasetManifestHash: inspection.hash },
  ).operatorDatasetSplitManifestHash;
  const familyDesign = buildCampaignBenchmarkSelector({ benchmarkId: FAMILY })
    .experimentDesign;
  const builtAnalysisProtocol = buildCanonicalAnalysisProtocol({
    benchmarkId,
    benchmarkFamily: FAMILY,
    requiredMetrics: familyDesign.requiredMetrics,
    metricSpecs: familyDesign.metricSpecs,
  });
  const { analysisProtocolHash, ...analysisProtocol } = builtAnalysisProtocol;
  const semantics = validateOperatorDatasetResearchSemantics({
    version: 1,
    kind: 'OperatorDatasetResearchSemantics',
    population: researchAgendaIr.dataRequirements.population,
    variables: ['outcome', 'treatment_assignment', 'covariate'],
    intervention: researchAgendaIr.dataRequirements.intervention,
    comparator: researchAgendaIr.dataRequirements.comparator,
    estimands: [researchAgendaIr.dataRequirements.estimand],
    datasetConstraints: [...researchAgendaIr.dataRequirements.datasetConstraints],
    eligibleSplits: ['train'],
  }).researchSemantics;
  const pair = crypto.generateKeyPairSync('ed25519');
  const now = new Date();
  const authority = signAuthorityDocument({
    version: 3,
    kind: 'OperatorDatasetHarnessAuthority',
    datasetName: benchmarkId,
    datasetManifestHash: inspection.hash,
    datasetLicenseId: 'CC-BY-4.0',
    datasetSplitManifestHash: splitManifestHash,
    benchmarkHarnessDefinitionHash: definitionHash,
    analysisProtocolHash,
    researchSemantics: semantics,
    benchmarkFamily: FAMILY,
    seedSchedule,
    minimumRepetitions,
    workerExposurePolicy: 'signed-complete-dataset-file-manifest-v1',
    signedAt: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  }, {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    keyId: 'production-closure-dataset-key',
    role: 'dataset_harness_operator',
  });
  const trustStore = Object.freeze({
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [Object.freeze({
      keyId: 'production-closure-dataset-key',
      subjectId: 'production-closure-dataset-operator',
      algorithm: 'ed25519',
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
      roles: ['dataset_harness_operator'],
      status: 'active',
    })],
  });
  const envelopePath = path.join(root, 'operator-dataset-envelope.json');
  fs.writeFileSync(envelopePath, `${JSON.stringify({
    version: 3,
    kind: 'OperatorDatasetHarnessEnvelope',
    authority,
    splitManifest,
    harnessDefinition: definition,
    analysisProtocol,
  })}\n`, { mode: 0o600 });
  const mount = authorizeOperatorDatasetMount({
    name: benchmarkId,
    source: datasetRoot,
    readOnly: true,
    manifestHash: inspection.hash,
    licenseId: 'CC-BY-4.0',
  }, {
    envelopePath,
    authorityTrustStore: trustStore,
    runtimeRoot,
    persistPrivateEnvelope: true,
    now,
  });
  const templateSelector = buildCampaignBenchmarkSelector({
    benchmarkId,
    datasetMounts: [mount],
  });
  const templateProtocol = Object.freeze({
    ...templateSelector.experimentDesign.analysisProtocol,
    analysisProtocolHash: templateSelector.experimentDesign.analysisProtocolHash,
  });
  const empiricalProposalClaimIndex = proposal?.claims?.findIndex((claim) => (
    ['empirical_replay', 'empirical_protocol'].includes(claim?.verificationMode)
  ));
  const empiricalProposalClaim = empiricalProposalClaimIndex >= 0
    ? proposal.claims[empiricalProposalClaimIndex] : null;
  const proposalClaimRecordHash = empiricalProposalClaim
    ? hashRecord('AutonomousResearchClaimRecord',
      empiricalProposalClaim.verificationMode === 'empirical_protocol'
        ? {
          id: `${proposal.paperId}:autonomous_claim:${empiricalProposalClaimIndex + 1}`,
          kind: 'machine_proposed_claim_seed',
          status: 'machine_proposed_policy_authorized_for_bounded_execution',
          text: empiricalProposalClaim.statement,
          scientificClaimKey: empiricalProposalClaim.claimKey,
          verificationMode: empiricalProposalClaim.verificationMode,
          assumptions: empiricalProposalClaim.assumptions,
          quantifiers: empiricalProposalClaim.quantifiers,
          negativeBoundaries: empiricalProposalClaim.negativeBoundaries,
          proofObligations: empiricalProposalClaim.proofObligations,
          empiricalObligations: empiricalProposalClaim.empiricalObligations,
          machineProposedScientificClaimSetHash:
            proposal.machineProposedScientificClaimSetHash,
        }
        : empiricalProposalClaim)
    : null;
  const claimText = empiricalProposalClaim?.statement
    || researchAgendaIr.primaryClaim;
  const empiricalClaimSource = empiricalClaimDeclarationsFromAnalysisProtocol(
    templateProtocol,
  ).map((declaration, index) => [
    `% HEPTA_EMPIRICAL_CLAIM_BEGIN ${JSON.stringify({
      ...declaration,
      proposalClaimRecordHash,
    })}`,
    empiricalManuscriptClaimText
      || `${claimText} Confirmatory comparison ${index + 1} is evaluated exactly as registered.`,
    `% HEPTA_EMPIRICAL_CLAIM_END ${declaration.claimId}`,
  ].join('\n')).join('\n\n');
  fs.writeFileSync(path.join(root, 'main.tex'), `${empiricalClaimSource}\n`, {
    mode: 0o600,
  });
  const empiricalClaimUniverse = readEmpiricalClaimUniverse({
    sourceRoot: root,
    manuscriptPath: 'main.tex',
  });
  if (empiricalClaimUniverse.status !== 'empirical_claim_universe_verified') {
    throw new Error(
      `production_fixture_empirical_claim_universe:${JSON.stringify(empiricalClaimUniverse.blockers)}`,
    );
  }
  return Object.freeze({
    mount,
    selector: buildCampaignBenchmarkSelector({
      benchmarkId,
      datasetMounts: [mount],
      empiricalClaimUniverse,
    }),
    empiricalClaimUniverse,
    outputRoot,
    runtimeRoot,
    trustStore,
  });
}

function artifactWriteReceipt(harness, {
  paperId,
  campaignId,
  nodeId,
  attemptId,
  executionRole,
}) {
  const payload = {
    version: 2,
    kind: 'ArtifactWriteReceipt',
    role: campaignExperimentArtifactRole({
      paperId,
      campaignId,
      nodeId,
      attemptId,
      executionRole,
    }),
    path: `raw-events-${harness.rawEventArtifactHash.slice('sha256:'.length)}.ndjson`,
    hash: harness.rawEventArtifactHash,
    bytes: harness.rawEventArtifactBytes,
    contentType: 'application/octet-stream',
    contentAddress: harness.rawEventArtifactHash,
    immutableObject: true,
    atomic: true,
  };
  return Object.freeze({
    ...payload,
    writeReceiptHash: hashRecord('ArtifactWriteReceipt', payload),
  });
}

function experimentRunReceipt(harness, dataset, receiptLedger, {
  paperId,
  campaignId,
  nodeId,
  attemptId,
  executionRole,
  sourceLineageHash,
}) {
  const rawArtifactWriteReceipt = receiptLedger.add(artifactWriteReceipt(harness, {
    paperId,
    campaignId,
    nodeId,
    attemptId,
    executionRole,
  }));
  return buildExperimentRunReceipt({
    resultDocument: harness.resultDocument,
    csvDocument: harness.csvDocument,
    benchmarkSelector: dataset.selector,
    datasetMounts: [dataset.mount],
    executionReceiptHash: harness.systemBenchmarkHarnessExecutionReceiptHash,
    runtimeIdentityHash: harness.runtimeIdentityHash,
    sourceMerkleHash: harness.sourceMerkleHash,
    sourceWorkspaceManifestHash: harness.sourceWorkspaceManifestHash,
    cacheHit: false,
    resultJsonHash: harness.resultJsonHash,
    resultCsvHash: harness.resultCsvHash,
    experimentAttemptId: attemptId,
    harnessExecutionReceipt: harness,
    sourceLineageHash,
    rawArtifactWriteReceipt,
  });
}

function fixtureRawEventRecomputation({
  experimentRunReceipt,
  executionRole,
} = {}) {
  const operatorDatasetAuthorityVerificationHash = experimentRunReceipt
    ?.harnessExecutionReceipt?.operatorDatasetHarnessAuthority
    ?.operatorDatasetAuthorityVerificationHash || null;
  const payload = {
    version: 2,
    kind: 'IndependentRawEventArtifactRecomputationVerification',
    status: 'independent_raw_event_recomputation_verified',
    dataSourceIndependent: true,
    implementationIndependent: true,
    independentExecutionClaimed: false,
    recomputationIndependenceLevel: RECOMPUTATION_INDEPENDENCE_LEVEL,
    rawEventRecomputationIndependenceContractHash:
      RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT
        .rawEventRecomputationIndependenceContractHash,
    recomputationIndependenceContract:
      RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT,
    executionRole,
    primitiveRecomputationStatus: 'raw_primitive_recomputation_verified',
    rawPrimitiveRecomputationManifestHash: digest(
      `raw-primitive-recomputation:${executionRole}:${experimentRunReceipt?.experimentRunReceiptHash}`,
    ),
    operatorDatasetAuthorityVerificationHash,
    promotionTcbImplementationHash:
      experimentRunReceipt?.systemBenchmarkHarnessImplementationHash || null,
    blockers: Object.freeze([]),
  };
  return Object.freeze({
    ...payload,
    independentRawEventArtifactRecomputationVerificationHash: hashRecord(
      'IndependentRawEventArtifactRecomputationVerification',
      payload,
    ),
  });
}

function verifyFixtureOperatorDatasetAuthority(authorityReceipt) {
  return Object.freeze({
    verified: true,
    status: 'operator_dataset_harness_authority_receipt_verified',
    operatorDatasetHarnessAuthorityReceiptHash:
      authorityReceipt?.operatorDatasetHarnessAuthorityReceiptHash || null,
    operatorDatasetAuthorityDocumentHash:
      authorityReceipt?.operatorDatasetAuthorityDocumentHash || null,
    analysisProtocolHash: authorityReceipt?.analysisProtocolHash || null,
    blockers: Object.freeze([]),
  });
}

function experimentLineageReceiptPayload({
  paperId,
  campaignId,
  runReceipt,
  campaignNodeId,
  campaignNodeAttemptId,
  campaignNodeResultHash,
  sourceLineageHash,
} = {}) {
  const empiricalClaimBindings = empiricalProtocolBindings(runReceipt);
  return {
    paperId,
    campaignId,
    analysisProtocolHash: runReceipt.analysisProtocolHash,
    empiricalClaimUniverseHash:
      runReceipt.analysisProtocol.empiricalClaimUniverseHash,
    manuscriptCorpusHash: runReceipt.analysisProtocol.manuscriptCorpusHash,
    claimIds: empiricalClaimBindings.map((binding) => binding.claimId),
    empiricalClaimBindings,
    campaignNodeId,
    campaignNodeAttemptId,
    campaignNodeLeaseGeneration: 1,
    campaignNodeResultHash,
    sourceLineageHash,
    assuranceProfile: runReceipt.assuranceProfile,
    assuranceScope: runReceipt.assuranceScope,
    evidenceClass: runReceipt.evidenceClass,
    promotionScope: runReceipt.promotionScope,
    academicPromotionEligible: runReceipt.academicPromotionEligible,
  };
}

function buildAcademicExperimentRegistryFixture({
  paperId,
  campaignId,
  selector,
  receiptLedger,
  originalRunReceipt,
  replayRunReceipt,
  experimentReplayReceipt,
  sourceLineageHash,
  originalNodeId,
  originalAttemptId,
  replayNodeId,
  replayAttemptId,
} = {}) {
  const originalCampaignNodeResultHash = digest(
    `${campaignId}:${originalNodeId}:${originalAttemptId}:result`,
  );
  const replayCampaignNodeResultHash = digest(
    `${campaignId}:${replayNodeId}:${replayAttemptId}:result`,
  );
  const originalLineage = experimentLineageReceiptPayload({
    paperId,
    campaignId,
    runReceipt: originalRunReceipt,
    campaignNodeId: originalNodeId,
    campaignNodeAttemptId: originalAttemptId,
    campaignNodeResultHash: originalCampaignNodeResultHash,
    sourceLineageHash,
  });
  const replayLineage = experimentLineageReceiptPayload({
    paperId,
    campaignId,
    runReceipt: replayRunReceipt,
    campaignNodeId: replayNodeId,
    campaignNodeAttemptId: replayAttemptId,
    campaignNodeResultHash: replayCampaignNodeResultHash,
    sourceLineageHash,
  });
  const originalRawReceipt = originalRunReceipt.rawArtifactWriteReceipt;
  const replayRawReceipt = replayRunReceipt.rawArtifactWriteReceipt;
  const workerReceipt = receiptLedger.add(sealLedgerReceipt(
    'ExperimentWorkerExecutionReceipt',
    {
      status: 'worker_execution_completed',
      experimentRunReceiptHash: originalRunReceipt.experimentRunReceiptHash,
      ...originalLineage,
      rawArtifactWriteReceiptHash: originalRawReceipt.writeReceiptHash,
      rawArtifactLedgerReceiptId: originalRawReceipt.ledgerReceiptId,
      rawArtifactRole: originalRawReceipt.role,
    },
  ));
  const replayWorkerReceipt = receiptLedger.add(sealLedgerReceipt(
    'ExperimentWorkerExecutionReceipt',
    {
      status: 'worker_execution_completed',
      experimentRunReceiptHash:
        experimentReplayReceipt.replayExperimentRunReceiptHash,
      ...replayLineage,
      rawArtifactWriteReceiptHash: replayRawReceipt.writeReceiptHash,
      rawArtifactLedgerReceiptId: replayRawReceipt.ledgerReceiptId,
      rawArtifactRole: replayRawReceipt.role,
    },
  ));
  const reproducibilityLedgerReceipt = receiptLedger.add(sealLedgerReceipt(
    'ExperimentReproducibilityReceipt',
    {
      status: 'experiment_reproducibility_verified',
      paperId,
      campaignId,
      workerReceiptHash: workerReceipt.receiptHash,
      replayWorkerReceiptHash: replayWorkerReceipt.receiptHash,
      experimentReplayReceiptHash:
        experimentReplayReceipt.experimentReplayReceiptHash,
      sourceLineageHash,
      originalCampaignNodeResultHash,
      replayCampaignNodeResultHash,
      originalRawArtifactWriteReceiptHash: originalRawReceipt.writeReceiptHash,
      originalRawArtifactLedgerReceiptId: originalRawReceipt.ledgerReceiptId,
      replayRawArtifactWriteReceiptHash: replayRawReceipt.writeReceiptHash,
      replayRawArtifactLedgerReceiptId: replayRawReceipt.ledgerReceiptId,
      analysisProtocolHash: originalLineage.analysisProtocolHash,
      empiricalClaimUniverseHash: originalLineage.empiricalClaimUniverseHash,
      manuscriptCorpusHash: originalLineage.manuscriptCorpusHash,
      claimIds: originalLineage.claimIds,
      empiricalClaimBindings: originalLineage.empiricalClaimBindings,
      assuranceProfile: originalRunReceipt.assuranceProfile,
      assuranceScope: originalRunReceipt.assuranceScope,
      evidenceClass: originalRunReceipt.evidenceClass,
      promotionScope: originalRunReceipt.promotionScope,
      academicPromotionEligible: originalRunReceipt.academicPromotionEligible,
    },
  ));
  const artifact = Object.freeze({
    kind: 'experiment',
    paperId,
    campaignId,
    experimentId: selector.benchmarkId,
    experimentRunReceipt: originalRunReceipt,
    reproducibilityReceipt: experimentReplayReceipt,
    workerReceipt,
    replayWorkerReceipt,
    reproducibilityLedgerReceipt,
    sourceLineageHash,
    originalCampaignNodeId: originalNodeId,
    originalCampaignNodeAttemptId: originalAttemptId,
    originalCampaignNodeLeaseGeneration: 1,
    originalCampaignNodeResultHash,
    campaignNodeId: replayNodeId,
    campaignNodeAttemptId: replayAttemptId,
    campaignNodeLeaseGeneration: 1,
    campaignNodeResultHash: replayCampaignNodeResultHash,
  });
  const empiricalClaimUniverse = selector.empiricalClaimUniverse;
  const rawEventRecomputationVerifier = (input) =>
    fixtureRawEventRecomputation(input);
  const experimentRegistry = buildExperimentRegistry({
    paperTask: { paperId },
    artifacts: [artifact],
    receiptLedger,
    artifactVerifier: verifyFixtureArtifactSource,
    rawEventRecomputationVerifier,
    operatorDatasetHarnessAuthorityVerifier:
      verifyFixtureOperatorDatasetAuthority,
    campaignEvidenceContext: { paperId, campaignId },
    empiricalClaimUniverse,
  });
  const experimentRegistryAuthorityVerifier =
    createExperimentRegistryAuthorityVerifier({
      receiptLedger,
      artifactVerifier: verifyFixtureArtifactSource,
      rawEventRecomputationVerifier,
      operatorDatasetHarnessAuthorityVerifier:
        verifyFixtureOperatorDatasetAuthority,
      expectedCampaignId: campaignId,
    });
  if (experimentRegistry.status !== 'experiment_registry_ready') {
    throw new Error(
      `production_fixture_experiment_registry_invalid:${JSON.stringify(experimentRegistry)}`,
    );
  }
  return Object.freeze({
    experimentRegistry,
    experimentRegistryAuthorityVerifier,
    workerReceipt,
    replayWorkerReceipt,
    reproducibilityLedgerReceipt,
  });
}

function executeHarness({
  dataset,
  attemptId,
  researchContext,
  processOrdinalBase,
}) {
  const sourceLineageHash = digest('source-lineage');
  const sourceMerkleHash = digest('source-merkle');
  const sourceWorkspaceManifestHash = digest('source-workspace-manifest');
  const nowEpochMs = 1_800_000_000_000;
  const outputDirectory = path.join(
    dataset.outputRoot,
    digest(attemptId).slice('sha256:'.length),
  );
  const adapterSet = armAdapterSet(dataset.selector);
  let invocationCount = 0;
  const harness = executeSystemBenchmarkHarness({
    benchmarkSelector: dataset.selector,
    datasetMounts: [dataset.mount],
    experimentAttemptId: attemptId,
    sourceLineageHash,
    sourceMerkleHash,
    sourceWorkspaceManifestHash,
    outputDirectory,
    armAdapterSet: adapterSet,
    runRawEventRecomputation: runRawEventRecomputationInSandboxTestFixture,
    operatorDatasetAuthorityTrustStore: dataset.trustStore,
    runtimeRoot: dataset.runtimeRoot,
    absoluteDeadlineEpochMs: nowEpochMs + 1_200_000,
    aggregateCpuSeconds: 1_200,
    memoryBytes: 1_073_741_824,
    maximumProcesses: 128,
    maximumWallTimeMs: 1_200_000,
    cpuCount: 1,
    executionEnvironment: 'signed-docker-runtime-v1',
    researchContext,
    nowEpochMs: () => nowEpochMs,
    runArmBatch({ batch, outputDirectory: batchOutput }) {
      invocationCount += 1;
      const content = responseDocument(batch);
      fs.mkdirSync(batchOutput, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(batchOutput, 'observation.json'), content, {
        mode: 0o600,
      });
      return workerReceipt({
        batch: {
          ...batch,
          benchmarkId: dataset.selector.benchmarkId,
          selectorHash: dataset.selector.campaignBenchmarkSelectorHash,
          designHash: dataset.selector.experimentDesignHash,
          harnessHash: dataset.selector.experimentDesign.benchmarkHarnessHash,
        },
        content,
        datasetMount: dataset.mount,
        processOrdinal: processOrdinalBase + invocationCount,
        sourceMerkleHash,
        sourceWorkspaceManifestHash,
      });
    },
  });
  if (harness.status !== 'system_benchmark_harness_verified') {
    throw new Error(`production_fixture_harness_invalid:${JSON.stringify(harness.blockers)}`);
  }
  const rawEventDocument = fs.readFileSync(
    path.join(outputDirectory, 'raw-events.ndjson'),
  );
  if (hashBytes(rawEventDocument) !== harness.rawEventArtifactHash
    || rawEventDocument.length !== harness.rawEventArtifactBytes) {
    throw new Error('production_fixture_raw_event_artifact_invalid');
  }
  return Object.freeze({ harness, rawEventDocument, sourceLineageHash });
}

export function productionExperimentClosureFixture({
  campaignId,
  paperId,
  campaignPlanHash,
  researchAgendaIr,
  researchAgendaProducerReceipt,
  proposal,
  researchAgendaClaimBindingReceipt,
  nodeId = `${campaignId}:empirical-reproduce`,
  nodeKind = 'empirical-reproduce',
  empiricalManuscriptClaimText = null,
} = {}) {
  const cacheKey = JSON.stringify({
    campaignId,
    paperId,
    campaignPlanHash,
    researchAgendaIrHash: researchAgendaIr?.researchAgendaIrHash,
    proposalHash: proposal?.machineProposedScientificClaimSetHash,
    researchAgendaClaimBindingReceiptHash:
      researchAgendaClaimBindingReceipt?.researchAgendaClaimBindingReceiptHash,
    empiricalManuscriptClaimText,
    nodeId,
    nodeKind,
  });
  if (PROCESS_CACHE.has(cacheKey)) return PROCESS_CACHE.get(cacheKey);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-production-closure-'));
  try {
    const dataset = buildDatasetFixture({
      root,
      researchAgendaIr,
      proposal,
      empiricalManuscriptClaimText,
    });
    const receiptLedger = createMemoryReceiptLedger();
    const researchContext = Object.freeze({
      researchAgendaIr,
      proposal,
      researchAgendaClaimBindingReceipt,
    });
    const originalNodeId = `${campaignId}:empirical`;
    const replayNodeId = nodeId;
    const originalAttemptId = `${campaignId}:empirical:attempt-1`;
    const replayAttemptId = `${campaignId}:${replayNodeId}:attempt-1`;
    const original = executeHarness({
      dataset,
      attemptId: originalAttemptId,
      researchContext,
      processOrdinalBase: 0,
    });
    const replay = executeHarness({
      dataset,
      attemptId: replayAttemptId,
      researchContext,
      processOrdinalBase: 1_000,
    });
    const originalRunReceipt = experimentRunReceipt(
      original.harness, dataset, receiptLedger, {
        paperId,
        campaignId,
        nodeId: originalNodeId,
        attemptId: originalAttemptId,
        executionRole: 'original',
        sourceLineageHash: original.sourceLineageHash,
      },
    );
    const replayRunReceipt = experimentRunReceipt(
      replay.harness, dataset, receiptLedger, {
        paperId,
        campaignId,
        nodeId: replayNodeId,
        attemptId: replayAttemptId,
        executionRole: 'independent-replay',
        sourceLineageHash: replay.sourceLineageHash,
      },
    );
    if (originalRunReceipt.status !== 'experiment_run_receipt_verified'
      || replayRunReceipt.status !== 'experiment_run_receipt_verified') {
      throw new Error('production_fixture_experiment_run_invalid');
    }
    const experimentReplayReceipt = buildExperimentReplayReceipt({
      originalRunReceipt,
      replayRunReceipt,
    });
    if (experimentReplayReceipt.status !== 'experiment_replay_verified') {
      throw new Error(
        `production_fixture_replay_invalid:${JSON.stringify(experimentReplayReceipt.blockers)}`,
      );
    }
    const authorityInput = {
      campaignId,
      paperId,
      campaignPlanHash,
      nodeId,
      nodeKind,
      researchAgendaIr,
      researchAgendaProducerReceipt,
      proposal,
      researchAgendaClaimBindingReceipt,
      experimentReplayReceipt,
    };
    const experimentIrExecutionAuthorityReceipt =
      buildExperimentIrExecutionAuthorityReceipt(authorityInput);
    const registry = buildAcademicExperimentRegistryFixture({
      paperId,
      campaignId,
      selector: dataset.selector,
      receiptLedger,
      originalRunReceipt,
      replayRunReceipt,
      originalRawEventDocument: Buffer.from(original.rawEventDocument),
      replayRawEventDocument: Buffer.from(replay.rawEventDocument),
      experimentReplayReceipt,
      sourceLineageHash: original.sourceLineageHash,
      originalNodeId,
      originalAttemptId,
      replayNodeId,
      replayAttemptId,
    });
    const result = assertProductionExperimentClosureResult({
      datasetMount: dataset.mount,
      benchmarkSelector: dataset.selector,
      originalRunReceipt,
      replayRunReceipt,
      originalRawEventDocument: Buffer.from(original.rawEventDocument),
      replayRawEventDocument: Buffer.from(replay.rawEventDocument),
      experimentReplayReceipt,
      experimentIrExecutionAuthorityReceipt,
      experimentRegistry: registry.experimentRegistry,
      experimentRegistryAuthorityVerifier:
        registry.experimentRegistryAuthorityVerifier,
      workerReceipt: registry.workerReceipt,
      replayWorkerReceipt: registry.replayWorkerReceipt,
      reproducibilityLedgerReceipt:
        registry.reproducibilityLedgerReceipt,
    });
    PROCESS_CACHE.set(cacheKey, result);
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
