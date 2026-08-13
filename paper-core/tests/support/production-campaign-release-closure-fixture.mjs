import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  importCampaignReleaseContractsForTest,
} from './production-experiment-closure-test-seam.mjs';
import {
  createPaperArtifactPackage,
} from '../../../paper-domain/contracts/workflow-contracts.mjs';
import {
  hashPaperRecord,
} from '../../../paper-domain/contracts/primitives.mjs';
import {
  sealReceiptHash,
} from '../../../paper-domain/evidence/receipt-hash-policy.mjs';
import {
  nativeFormalClosureBindingFromExecution,
} from '../../../paper-domain/research/formal-certificate-intake.mjs';
import {
  buildCampaignResearchSourceSnapshot,
} from '../../../paper-domain/automation/campaign-research-contract.mjs';
import {
  sourceRowsMerkleHash,
} from '../../../paper-domain/automation/campaign-release-contract-helpers.mjs';
import {
  buildCampaignReleaseEvidenceCapsuleManifest,
} from '../../../paper-domain/automation/campaign-release-evidence-capsule-contract.mjs';
import {
  buildCampaignReleaseExecutionAttestationUnsignedPayload,
  campaignReleaseExecutionAttestationDocumentFileHash,
  campaignReleaseExecutionAttestationSigningPayloadHash,
  finalizeCampaignReleaseExecutionAttestation,
  RESEARCH_EXECUTION_RELEASE_ATTESTATION_PATH,
} from '../../../paper-domain/automation/campaign-release-execution-attestation-contract.mjs';
import {
  buildIndependentPdfRebuildCommand,
  buildIndependentPdfRebuildToolIdentity,
  buildIndependentPdfRebuildVerificationReceipt,
} from '../../../paper-domain/automation/independent-pdf-rebuild-contract.mjs';
import {
  inspectDeterministicPdfPageTree,
} from '../../../paper-domain/automation/deterministic-pdf-page-tree-parser.mjs';
import {
  researchEvidenceRecomputationIndependenceSummary,
} from '../../../paper-adapters/build-package/research-evidence-recomputation-binding.mjs';
import {
  persistCampaignReleaseBundleSync,
} from '../../../paper-adapters/automation/campaign-release-repository.mjs';
import {
  workspaceExecutionManifestHash,
} from '../../../workflow-kernel/runtime/workspace-execution-identity.mjs';
import { hashBytes, hashRecord } from '../../../workflow-kernel/record-hash.mjs';

const {
  createCampaignReleasePromotionReceipt,
  createAutomationPromotionCandidate,
  createCampaignReleaseBundle,
  verifyCampaignReleaseAuthorityRecord,
  verifyCampaignReleaseBundle,
} = await importCampaignReleaseContractsForTest();

const releaseAttestorPair = crypto.generateKeyPairSync('ed25519');

function requiredFile(packageFiles, role) {
  const matches = (packageFiles || []).filter((file) => file?.role === role);
  if (matches.length !== 1) {
    throw new Error(`production_campaign_release_file_required:${role}`);
  }
  const file = matches[0];
  if (!file.path || !/^sha256:[0-9a-f]{64}$/.test(String(file.hash || ''))
    || !Number.isSafeInteger(Number(file.bytes)) || Number(file.bytes) < 1) {
    throw new Error(`production_campaign_release_file_invalid:${role}`);
  }
  return Object.freeze({
    role,
    path: String(file.path),
    hash: String(file.hash),
    bytes: Number(file.bytes),
  });
}

function documentFile(role, filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return Object.freeze({
    role,
    path: filePath,
    hash: hashBytes(bytes),
    bytes: bytes.length,
  });
}

function jsonDocumentBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function boundFixturePath(root, relative) {
  const normalized = String(relative || '').replace(/\\/g, '/');
  if (!normalized || path.posix.isAbsolute(normalized)
    || normalized.split('/').some((segment) => !segment
      || segment === '.' || segment === '..')) {
    throw new Error(`production_campaign_release_path_invalid:${normalized}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalized);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`production_campaign_release_path_escape:${normalized}`);
  }
  return resolved;
}

function writeBoundFixtureFile(root, file, content, { existing = false } = {}) {
  const destination = boundFixturePath(root, file.path);
  if (!existing) {
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, content, { mode: 0o600 });
  }
  const bytes = fs.readFileSync(destination);
  if (hashBytes(bytes) !== file.hash || bytes.length !== Number(file.bytes)) {
    throw new Error(`production_campaign_release_file_identity_mismatch:${file.role}`);
  }
}

function sourceIdentity(sourceTreeManifest) {
  const fileRecords = Object.freeze((sourceTreeManifest?.rows || []).map((row) => (
    Object.freeze({
      path: String(row.path),
      mode: Number.isInteger(Number(row.mode)) ? Number(row.mode) : 0o600,
      hash: String(row.hash),
      bytes: Number(row.bytes),
    })
  )).sort((left, right) => left.path.localeCompare(right.path)));
  const verifiedSourceMerkleHash = sourceRowsMerkleHash(sourceTreeManifest);
  const verifiedSourceWorkspaceManifestHash = workspaceExecutionManifestHash(
    fileRecords,
    [],
  );
  return Object.freeze({
    fileRecords,
    verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash,
  });
}

function updateResearchLineage({
  manuscript,
  campaignId,
  paperId,
  sourceTreeManifest,
} = {}) {
  const researchNodeId = `${campaignId}:2:research-verify`;
  const researchAttemptId = `${campaignId}:research-attempt-1`;
  const researchLeaseGeneration = 1;
  const source = sourceIdentity(sourceTreeManifest);
  const campaignResearchSourceSnapshot = buildCampaignResearchSourceSnapshot({
    campaignId,
    paperId,
    researchNodeId,
    researchAttemptId,
    researchLeaseGeneration,
    verifiedSourceMerkleHash: source.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash:
      source.verifiedSourceWorkspaceManifestHash,
    fileRecords: source.fileRecords,
    directoryRecords: [],
  });
  const { researchReportHash: _oldReportHash, ...reportPayload } =
    manuscript.researchReport;
  const currentFormalIntake =
    reportPayload.capabilities?.formalCertificateIntakes?.[0] || null;
  const {
    genericFormalCertificateIntakeHash: _oldFormalIntakeHash,
    ...formalIntakePayload
  } = currentFormalIntake || {};
  const formalSource = source.fileRecords.find((record) => (
    record.path === 'Formal.lean'
  ));
  if (!formalSource) {
    throw new Error('production_campaign_release_formal_source_required');
  }
  const currentNativeExecution = reportPayload.nativeResearchWorkerExecution;
  const currentFormalWorker = currentNativeExecution?.workerReceipts?.[0];
  const {
    nativeResearchWorkerExecutionReceiptHash: _oldWorkerHash,
    ledgerReceiptId: formalWorkerLedgerReceiptId,
    ...formalWorkerPayload
  } = currentFormalWorker || {};
  const updatedFormalResult = Object.freeze({
    ...formalWorkerPayload.result,
    projectFiles: Object.freeze([Object.freeze({
      projectPath: formalSource.path,
      hash: formalSource.hash,
      bytes: formalSource.bytes,
    })]),
  });
  const updatedFormalWorkerPayload = {
    ...formalWorkerPayload,
    inputs: Object.freeze([Object.freeze({
      ...(formalWorkerPayload.inputs?.[0] || {}),
      path: formalSource.path,
      hash: formalSource.hash,
      expectedHash: formalSource.hash,
      sizeBytes: formalSource.bytes,
    })]),
    sourceSnapshotHash:
      campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
    sourceMerkleHashBefore: source.verifiedSourceMerkleHash,
    sourceMerkleHashAfter: source.verifiedSourceMerkleHash,
    result: updatedFormalResult,
    resultHash: hashPaperRecord(
      'NativeResearchWorkerResult',
      updatedFormalResult,
    ),
  };
  const sealedFormalWorker = sealReceiptHash(updatedFormalWorkerPayload, {
    hashField: 'nativeResearchWorkerExecutionReceiptHash',
  });
  const updatedFormalWorker = Object.freeze({
    ...sealedFormalWorker,
    ledgerReceiptId: formalWorkerLedgerReceiptId,
  });
  const {
    nativeResearchWorkerExecutionReportHash: _oldNativeReportHash,
    ...nativeExecutionPayload
  } = currentNativeExecution || {};
  const updatedNativeExecutionPayload = {
    ...nativeExecutionPayload,
    workerReceipts: Object.freeze([updatedFormalWorker]),
    workerReceiptHashes: Object.freeze([
      updatedFormalWorker.nativeResearchWorkerExecutionReceiptHash,
    ]),
  };
  const updatedNativeExecution = Object.freeze({
    ...updatedNativeExecutionPayload,
    nativeResearchWorkerExecutionReportHash: hashPaperRecord(
      'NativeResearchWorkerExecutionReport',
      updatedNativeExecutionPayload,
    ),
  });
  const nativeFormalClosureBinding = nativeFormalClosureBindingFromExecution(
    updatedNativeExecution,
    {
      paperId,
      campaignId,
      researchSourceSnapshotHash:
        campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
    },
  );
  const currentFormalNode = formalIntakePayload.authoritativeFormalNode;
  const campaignFormalSourceSnapshot = buildCampaignResearchSourceSnapshot({
    campaignId,
    paperId,
    researchNodeId: currentFormalNode.nodeId,
    researchAttemptId: currentFormalNode.attemptId,
    researchLeaseGeneration: currentFormalNode.leaseGeneration,
    verifiedSourceMerkleHash: source.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash:
      source.verifiedSourceWorkspaceManifestHash,
    fileRecords: source.fileRecords,
    directoryRecords: [],
  });
  const {
    campaignFormalVerificationReceiptHash: _oldFormalReceiptHash,
    ...formalReceiptPayload
  } = formalIntakePayload.authoritativeFormalReceipt || {};
  const updatedFormalReceiptPayload = {
    ...formalReceiptPayload,
    verifiedSourceMerkleHash: source.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash:
      source.verifiedSourceWorkspaceManifestHash,
    campaignFormalSourceSnapshotHash:
      campaignFormalSourceSnapshot.campaignResearchSourceSnapshotHash,
    campaignFormalSourceSnapshot,
    nativeResearchWorkerExecutionReportHash:
      updatedNativeExecution.nativeResearchWorkerExecutionReportHash,
    nativeResearchWorkerExecution: updatedNativeExecution,
  };
  const updatedFormalReceipt = Object.freeze({
    ...updatedFormalReceiptPayload,
    campaignFormalVerificationReceiptHash: hashRecord(
      'CampaignFormalVerificationReceipt',
      updatedFormalReceiptPayload,
    ),
  });
  const updatedFormalNode = Object.freeze({
    ...currentFormalNode,
    resultSha256: hashRecord(
      'PaperCampaignNodeResult',
      updatedFormalReceipt,
    ),
    result: updatedFormalReceipt,
  });
  const updatedFormalIntakePayload = {
    ...formalIntakePayload,
    researchSourceSnapshotHash:
      campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
    campaignFormalVerificationReceiptHash:
      updatedFormalReceipt.campaignFormalVerificationReceiptHash,
    authoritativeFormalNode: updatedFormalNode,
    authoritativeFormalNodeResultHash: updatedFormalNode.resultSha256,
    authoritativeFormalReceipt: updatedFormalReceipt,
    nativeResearchWorkerExecutionReportHash:
      updatedNativeExecution.nativeResearchWorkerExecutionReportHash,
    nativeResearchWorkerExecutionReceiptHash:
      updatedFormalWorker.nativeResearchWorkerExecutionReceiptHash,
    authoritativeSource: Object.freeze({
      ...formalIntakePayload.authoritativeSource,
      path: formalSource.path,
      hash: formalSource.hash,
      bytes: formalSource.bytes,
    }),
    nativeFormalClosureBinding,
    nativeFormalClosureBindingHash:
      nativeFormalClosureBinding.nativeFormalClosureBindingHash,
  };
  const updatedFormalIntake = Object.freeze({
    ...updatedFormalIntakePayload,
    genericFormalCertificateIntakeHash: hashRecord(
      'GenericFormalCertificateIntake',
      updatedFormalIntakePayload,
    ),
  });
  const trustedFormalEvidence = Object.freeze([
    ...((reportPayload.capabilities?.trustedFormalEvidence || []).map((
      item,
    ) => Object.freeze({
      ...item,
      nativeProjectionRequest: Object.freeze({
        ...(item.nativeProjectionRequest || {}),
        authoritativeFormalNode: updatedFormalNode,
      }),
    }))),
  ]);
  const currentEvidenceQualityGate =
    reportPayload.capabilities?.evidenceQualityGate || {};
  const {
    evidenceQualityGateHash: _oldEvidenceQualityGateHash,
    ...evidenceQualityGatePayload
  } = currentEvidenceQualityGate;
  const updatedEvidenceQualityGatePayload = {
    ...evidenceQualityGatePayload,
    workerLedgerVerifications: Object.freeze(
      (evidenceQualityGatePayload.workerLedgerVerifications || []).map((
        verification,
      ) => Object.freeze({
        ...verification,
        receiptHash:
          updatedFormalWorker.nativeResearchWorkerExecutionReceiptHash,
      })),
    ),
  };
  const evidenceQualityGate = Object.freeze({
    ...updatedEvidenceQualityGatePayload,
    evidenceQualityGateHash: hashRecord(
      'EvidenceQualityGate',
      updatedEvidenceQualityGatePayload,
    ),
  });
  const updatedReportPayload = {
    ...reportPayload,
    researchNodeId,
    researchAttemptId,
    researchLeaseGeneration,
    verifiedSourceMerkleHash: source.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash:
      source.verifiedSourceWorkspaceManifestHash,
    campaignResearchSourceSnapshotHash:
      campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
    campaignResearchSourceSnapshot,
    nativeResearchWorkerExecution: updatedNativeExecution,
    capabilities: Object.freeze({
      ...reportPayload.capabilities,
      formalCertificateIntakes: Object.freeze([updatedFormalIntake]),
      trustedFormalEvidence,
      evidenceQualityGate,
    }),
  };
  const researchReport = Object.freeze({
    ...updatedReportPayload,
    researchReportHash: hashPaperRecord(
      'PaperResearchVerifyReport',
      updatedReportPayload,
    ),
  });
  const {
    autonomousResearchReleaseBindingHash: _oldBindingHash,
    ...releaseBindingPayload
  } = manuscript.releaseBinding;
  const updatedReleaseBindingPayload = {
    ...releaseBindingPayload,
    researchReportHash: researchReport.researchReportHash,
    proposalClaimToTheoremBindingHash:
      researchReport.proposalClaimToTheoremBindingHash,
    experimentRegistryHash: researchReport.experimentRegistryHash,
  };
  const releaseBinding = Object.freeze({
    ...updatedReleaseBindingPayload,
    autonomousResearchReleaseBindingHash: hashRecord(
      'AutonomousResearchReleaseBinding',
      updatedReleaseBindingPayload,
    ),
  });
  return Object.freeze({
    ...source,
    researchNodeId,
    researchAttemptId,
    researchLeaseGeneration,
    campaignResearchSourceSnapshot,
    researchReport,
    releaseBinding,
  });
}

function campaignNodes({ campaignId, researchReport, lineage } = {}) {
  const finalCompileNodeId = `${campaignId}:1:final-compile`;
  const finalCompileResult = Object.freeze({
    status: 'final_compile_completed',
    sourceMerkleHash: lineage.verifiedSourceMerkleHash,
    sourceWorkspaceManifestHash:
      lineage.verifiedSourceWorkspaceManifestHash,
  });
  const finalCompileNode = Object.freeze({
    nodeId: finalCompileNodeId,
    kind: 'final-compile',
    status: 'completed',
    attemptId: `${campaignId}:final-compile-attempt-1`,
    leaseGeneration: 1,
    dependencies: Object.freeze([]),
    result: finalCompileResult,
    resultSha256: hashRecord('PaperCampaignNodeResult', finalCompileResult),
  });
  const researchResult = Object.freeze({
    version: 1,
    kind: 'CampaignResearchVerificationResult',
    status: 'campaign_research_verification_completed',
    campaignId,
    paperId: researchReport.paperId,
    researchReportHash: researchReport.researchReportHash,
    researchPromotionStatus: 'research_promotion_ready',
    researchNodeId: lineage.researchNodeId,
    researchAttemptId: lineage.researchAttemptId,
    researchLeaseGeneration: lineage.researchLeaseGeneration,
    verifiedSourceMerkleHash: lineage.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash:
      lineage.verifiedSourceWorkspaceManifestHash,
    campaignResearchSourceSnapshotHash:
      lineage.campaignResearchSourceSnapshot
        .campaignResearchSourceSnapshotHash,
    campaignResearchSourceSnapshot: lineage.campaignResearchSourceSnapshot,
    proposalClaimToTheoremBindingHash:
      researchReport.proposalClaimToTheoremBindingHash,
    report: researchReport,
  });
  const researchVerifyNode = Object.freeze({
    nodeId: lineage.researchNodeId,
    kind: 'research-verify',
    status: 'completed',
    attemptId: lineage.researchAttemptId,
    leaseGeneration: lineage.researchLeaseGeneration,
    dependencies: Object.freeze([finalCompileNodeId]),
    result: researchResult,
    resultSha256: hashRecord('PaperCampaignNodeResult', researchResult),
  });
  const packageNode = Object.freeze({
    nodeId: `${campaignId}:3:package`,
    kind: 'package',
    status: 'running',
    attemptId: `${campaignId}:package-attempt-1`,
    leaseGeneration: 1,
    dependencies: Object.freeze([
      finalCompileNode.nodeId,
      researchVerifyNode.nodeId,
    ]),
  });
  return Object.freeze({ finalCompileNode, researchVerifyNode, packageNode });
}

function safeExperimentSegment(experimentId) {
  const prefix = String(experimentId || 'experiment')
    .replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'experiment';
  return `${prefix}-${hashRecord(
    'ResearchEvidenceCapsulePathSegment',
    String(experimentId || 'experiment'),
  ).slice(-12)}`;
}

function experimentDescriptor(experiment) {
  const binding = experiment?.evidenceBinding || null;
  const authority = binding?.authorityEvidence || null;
  const replayReceipt = authority?.experimentReplayReceipt || null;
  const original = authority?.experimentRunReceipt || null;
  const replay = replayReceipt?.replayRunReceipt || null;
  const execution = (executionRole, run) => Object.freeze({
    executionRole,
    experimentRunReceiptHash: run?.experimentRunReceiptHash,
    executionReceiptHash: run?.executionReceiptHash,
    runtimeIdentityHash: run?.runtimeIdentityHash,
    environmentBindingHash:
      run?.harnessExecutionReceipt?.environmentBindingHash
      || run?.runnerReceipt?.environmentBindingHash,
    environmentBomHash: run?.environmentBomHash,
    experimentAttemptId: run?.experimentAttemptId,
    resultJsonHash: run?.resultJsonHash,
    resultCsvHash: run?.resultCsvHash,
    rawEventArtifactHash: run?.rawEventArtifactHash,
    rawEventArtifactBytes: Number(run?.rawEventArtifactBytes),
    rawArtifactWriteReceiptHash: run?.rawArtifactWriteReceipt?.writeReceiptHash,
    rawArtifactLedgerReceiptId: run?.rawArtifactWriteReceipt?.ledgerReceiptId,
  });
  return Object.freeze({
    experimentId: experiment.experimentId,
    academicPromotionEligible: true,
    experimentEvidenceBindingHash: binding.experimentEvidenceBindingHash,
    experimentReplayReceiptHash: replayReceipt.experimentReplayReceiptHash,
    sourceLineageHash: binding.sourceLineageHash,
    analysisProtocolHash: binding.analysisProtocolHash,
    originalAnalysisEvaluationHash: binding.originalAnalysisEvaluationHash,
    replayAnalysisEvaluationHash: binding.replayAnalysisEvaluationHash,
    analysisProtocolReplayBindingHash:
      binding.analysisProtocolReplayBindingHash,
    originalEnvironmentBomHash: replayReceipt.originalEnvironmentBomHash,
    replayEnvironmentBomHash: replayReceipt.replayEnvironmentBomHash,
    replayAssuranceScope: replayReceipt.replayAssuranceScope,
    ...researchEvidenceRecomputationIndependenceSummary(binding),
    executions: Object.freeze([
      execution('original', original),
      execution('independent-replay', replay),
    ]),
  });
}

export function assertProductionCampaignCapsuleRawDocuments({
  experiments,
  manuscript,
} = {}) {
  if (!Array.isArray(experiments) || experiments.length < 1) {
    throw new Error('production_campaign_release_capsule_experiments_required');
  }
  for (const experiment of experiments) {
    const executions = experiment?.executions || [];
    if (executions.length !== 2
      || new Set(executions.map((execution) => execution.executionRole)).size !== 2
      || !executions.some((execution) => execution.executionRole === 'original')
      || !executions.some(
        (execution) => execution.executionRole === 'independent-replay',
      )) {
      throw new Error(
        `production_campaign_release_capsule_execution_set_invalid:${
          experiment?.experimentId || 'unknown'
        }`,
      );
    }
    for (const execution of executions) {
      const document = execution.executionRole === 'original'
        ? manuscript?.originalExperimentRawEventDocument
        : manuscript?.replayExperimentRawEventDocument;
      if (!Buffer.isBuffer(document)
        || hashBytes(document) !== execution.rawEventArtifactHash
        || document.length !== Number(execution.rawEventArtifactBytes)) {
        throw new Error(
          `production_campaign_release_capsule_raw_document_invalid:${
            experiment?.experimentId || 'unknown'
          }:${execution?.executionRole || 'unknown'}`,
        );
      }
    }
  }
  return true;
}

function capsuleEntries(experiments, researchReport, manuscript) {
  assertProductionCampaignCapsuleRawDocuments({ experiments, manuscript });
  const base = [
    ['portable_research_report', 'evidence/RESEARCH_REPORT.json', {
      version: 1,
      kind: 'PortablePaperResearchVerifyReport',
      sourceResearchReportHash: researchReport.researchReportHash,
      paperId: researchReport.paperId,
      experimentRegistryHash: researchReport.experimentRegistryHash,
    }],
    ['portable_experiment_registry', 'evidence/EXPERIMENT_REGISTRY.json', {
      version: 1,
      kind: 'PortableExperimentRegistry',
      sourceExperimentRegistryHash: researchReport.experimentRegistryHash,
      paperId: researchReport.paperId,
    }],
    ['research_environment_manifest', 'evidence/ENVIRONMENT_MANIFEST.json', {
      version: 1,
      kind: 'CampaignReleaseResearchEnvironmentManifestFixture',
      researchReportHash: researchReport.researchReportHash,
    }],
    ['research_public_authority_evidence', 'evidence/PUBLIC_AUTHORITY_EVIDENCE.json', {
      version: 1,
      kind: 'CampaignReleasePublicResearchAuthorityEvidenceFixture',
      privateKeysIncluded: false,
      hiddenOracleIncluded: false,
    }],
    ['public_authority_trust_snapshot', 'evidence/PUBLIC_AUTHORITY_TRUST_SNAPSHOT.json', {
      version: 1,
      kind: 'PublicAuthorityTrustSnapshotFixture',
      privateKeysIncluded: false,
    }],
  ].map(([role, entryPath, document]) => {
    const content = jsonDocumentBytes(document);
    return Object.freeze({
      entry: Object.freeze({
        role,
        path: entryPath,
        hash: hashBytes(content),
        bytes: content.length,
        executionRole: 'base',
        experimentId: null,
      }),
      content,
    });
  });
  const registryExperiments = new Map((
    researchReport.capabilities.experimentRegistry.experiments || []
  ).map((experiment) => [experiment.experimentId, experiment]));
  const executions = experiments.flatMap((experiment) => {
    const directory = `evidence/experiments/${safeExperimentSegment(
      experiment.experimentId,
    )}`;
    const registered = registryExperiments.get(experiment.experimentId);
    const authority = registered?.evidenceBinding?.authorityEvidence || null;
    const original = authority?.experimentRunReceipt || null;
    const replay = authority?.experimentReplayReceipt?.replayRunReceipt || null;
    return experiment.executions.flatMap((execution) => {
      const roleDirectory = `${directory}/${execution.executionRole}`;
      const run = execution.executionRole === 'original' ? original : replay;
      const jsonContent = jsonDocumentBytes(run?.harnessExecutionReceipt?.resultDocument);
      const csvContent = Buffer.from(
        String(run?.harnessExecutionReceipt?.csvDocument || ''),
        'utf8',
      );
      const rawContent = Buffer.from(execution.executionRole === 'original'
        ? manuscript.originalExperimentRawEventDocument
        : manuscript.replayExperimentRawEventDocument);
      if (hashBytes(jsonContent) !== execution.resultJsonHash
        || hashBytes(csvContent) !== execution.resultCsvHash
        || hashBytes(rawContent) !== execution.rawEventArtifactHash
        || rawContent.length !== execution.rawEventArtifactBytes) {
        throw new Error(
          `production_campaign_release_capsule_execution_identity_invalid:${experiment.experimentId}:${execution.executionRole}`,
        );
      }
      return [
        Object.freeze({
          entry: Object.freeze({
            role: 'experiment_results_json',
            path: `${roleDirectory}/results.json`,
            hash: execution.resultJsonHash,
            bytes: jsonContent.length,
            executionRole: execution.executionRole,
            experimentId: experiment.experimentId,
          }),
          content: jsonContent,
        }),
        Object.freeze({
          entry: Object.freeze({
            role: 'experiment_results_csv',
            path: `${roleDirectory}/results.csv`,
            hash: execution.resultCsvHash,
            bytes: csvContent.length,
            executionRole: execution.executionRole,
            experimentId: experiment.experimentId,
          }),
          content: csvContent,
        }),
        Object.freeze({
          entry: Object.freeze({
            role: 'experiment_raw_events',
            path: `${roleDirectory}/raw-events.ndjson`,
            hash: execution.rawEventArtifactHash,
            bytes: execution.rawEventArtifactBytes,
            executionRole: execution.executionRole,
            experimentId: experiment.experimentId,
          }),
          content: rawContent,
        }),
      ];
    });
  });
  const files = Object.freeze([...base, ...executions]);
  return Object.freeze({
    entries: Object.freeze(files.map((file) => file.entry)),
    contents: Object.freeze(new Map(files.map((file) => [file.entry.path, file.content]))),
  });
}

function researchEvidenceCapsule({
  campaignId,
  paperId,
  createdAt,
  researchReport,
  lineage,
  manuscript,
} = {}) {
  const experiments = Object.freeze((
    researchReport.capabilities.experimentRegistry.experiments || []
  ).filter((experiment) => experiment.academicPromotionEligible === true)
    .map(experimentDescriptor));
  const capsule = capsuleEntries(experiments, researchReport, manuscript);
  const entries = capsule.entries;
  const manifest = buildCampaignReleaseEvidenceCapsuleManifest({
    campaignId,
    paperId,
    researchReportHash: researchReport.researchReportHash,
    experimentRegistryHash: researchReport.experimentRegistryHash,
    campaignResearchSourceSnapshotHash:
      lineage.campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
    verifiedSourceMerkleHash: lineage.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash:
      lineage.verifiedSourceWorkspaceManifestHash,
    researchVerifyNodeId: lineage.researchNodeId,
    researchVerifyAttemptId: lineage.researchAttemptId,
    researchVerifyLeaseGeneration: lineage.researchLeaseGeneration,
    publicAuthorityTrustSnapshotHash: hashRecord(
      'ProductionCampaignReleasePublicAuthorityTrustSnapshotFixture',
      { campaignId, paperId },
    ),
    experiments,
    entries,
    createdAt,
  });
  const manifestFile = documentFile(
    'research_evidence_capsule_manifest',
    'evidence/CAPSULE_MANIFEST.json',
    manifest,
  );
  let attestation = null;
  let attestationFile = null;
  if (manifest.externalExecutionAttestationRequired) {
    const unsignedPayload = buildCampaignReleaseExecutionAttestationUnsignedPayload({
      manifest,
      manifestFileHash: manifestFile.hash,
      signer: {
        keyId: 'fixture-release-attestor-key',
        keyVersion: 'v1',
        subjectId: 'fixture-release-attestor',
        organization: 'Fixture Release Attestation Office',
      },
      signedAt: createdAt,
      expiresAt: new Date(Date.parse(createdAt) + 24 * 60 * 60 * 1_000)
        .toISOString(),
    });
    const signature = crypto.sign(
      null,
      Buffer.from(
        campaignReleaseExecutionAttestationSigningPayloadHash(unsignedPayload),
        'utf8',
      ),
      releaseAttestorPair.privateKey,
    ).toString('base64');
    attestation = finalizeCampaignReleaseExecutionAttestation({
      unsignedPayload,
      signature,
    });
    attestationFile = Object.freeze({
      role: 'research_execution_release_attestation',
      path: RESEARCH_EXECUTION_RELEASE_ATTESTATION_PATH,
      hash: campaignReleaseExecutionAttestationDocumentFileHash(attestation),
      bytes: Buffer.byteLength(`${JSON.stringify(attestation, null, 2)}\n`, 'utf8'),
    });
  }
  const contents = new Map(capsule.contents);
  contents.set(manifestFile.path, jsonDocumentBytes(manifest));
  if (attestationFile) {
    contents.set(attestationFile.path, jsonDocumentBytes(attestation));
  }
  return Object.freeze({
    manifest,
    manifestFile,
    entries,
    attestation,
    attestationFile,
    contents,
  });
}

function independentRebuild({
  paperId,
  createdAt,
  sourceTreeManifest,
  lineage,
  artifactBaseRoot,
  compiledPdf,
  rebuiltPdf,
} = {}) {
  const authoritativePdfInspection = inspectDeterministicPdfPageTree(
    fs.readFileSync(boundFixturePath(artifactBaseRoot, compiledPdf.path)),
  );
  const rebuiltPdfInspection = inspectDeterministicPdfPageTree(
    fs.readFileSync(boundFixturePath(artifactBaseRoot, rebuiltPdf.path)),
  );
  if (authoritativePdfInspection.pageCount !== rebuiltPdfInspection.pageCount) {
    throw new Error('production_campaign_release_rebuild_page_count_mismatch');
  }
  const command = buildIndependentPdfRebuildCommand('main.tex');
  const toolIdentity = buildIndependentPdfRebuildToolIdentity({
    runnerId: 'fixture-independent-pdf-rebuild-runner',
    runtimeIdentityHash: hashRecord(
      'ProductionCampaignReleasePdfRuntimeIdentityFixture',
      { paperId },
    ),
    runtimeType: 'fixture-isolated-process',
    executionClass: 'bounded-fixture-rebuild',
    latexmkExecutableHash: hashRecord(
      'ProductionCampaignReleaseLatexmkExecutableFixture',
      { paperId },
    ),
  });
  const receipt = buildIndependentPdfRebuildVerificationReceipt({
    paperId,
    sourcePackageContractHash: sourceTreeManifest.sourcePackageContractHash,
    sourceTreeManifestHash: sourceTreeManifest.sourceTreeManifestHash,
    sourceMerkleHash: lineage.verifiedSourceMerkleHash,
    sourceWorkspaceManifestHash:
      lineage.verifiedSourceWorkspaceManifestHash,
    materializedSourceWorkspaceManifestHash: hashRecord(
      'ProductionCampaignReleaseMaterializedSourceFixture',
      { paperId },
    ),
    mainTex: 'main.tex',
    command,
    toolIdentity,
    workerReceiptHash: hashRecord(
      'ProductionCampaignReleasePdfWorkerReceiptFixture',
      { paperId },
    ),
    executionProcessIdentityHash: hashRecord(
      'ProductionCampaignReleasePdfProcessIdentityFixture',
      { paperId },
    ),
    limits: {
      timeoutMs: 120_000,
      memoryBytes: 1_073_741_824,
      cpuSeconds: 120,
      maximumPids: 64,
      maximumOutputBytes: 64 * 1024 * 1024,
    },
    rebuiltPdf: {
      path: 'main.pdf',
      hash: rebuiltPdf.hash,
      bytes: rebuiltPdf.bytes,
      pageCount: rebuiltPdfInspection.pageCount,
    },
    authoritativePdfHash: compiledPdf.hash,
    authoritativePdfPageCount: authoritativePdfInspection.pageCount,
    createdAt,
  });
  return Object.freeze({
    receipt,
    content: jsonDocumentBytes(receipt),
    file: documentFile(
      'independent_pdf_rebuild_receipt',
      'independent-pdf-rebuild-receipt.json',
      receipt,
    ),
  });
}

function packageVerification({
  paperId,
  candidateArtifactPackage,
  sourceTreeManifest,
  files,
  artifacts,
} = {}) {
  const settlementPayload = {
    version: 1,
    kind: 'ArtifactSettlement',
    status: 'artifact_settlement_verified',
    artifacts: Object.freeze(artifacts.map((artifact) => Object.freeze({
      role: artifact.role,
      hash: artifact.hash,
    }))),
    blockers: Object.freeze([]),
  };
  const artifactSettlement = Object.freeze({
    ...settlementPayload,
    artifactSettlementHash: hashRecord('ArtifactSettlement', settlementPayload),
  });
  const payload = {
    version: 1,
    kind: 'PackageVerificationReceipt',
    status: 'package_verification_passed',
    paperId,
    verifiedArtifactPackageHash: candidateArtifactPackage.artifactPackageHash,
    sourceTreeManifestHash: sourceTreeManifest.sourceTreeManifestHash,
    verifiedFiles: Object.freeze(files.map((file) => Object.freeze({
      path: file.packageRelativePath || file.path,
      hash: file.hash,
      bytes: file.bytes,
    }))),
    archives: Object.freeze([Object.freeze({
      path: artifacts.find((artifact) => artifact.role === 'generated_source_zip').path,
      sourceTreeManifestHash: sourceTreeManifest.sourceTreeManifestHash,
      entryCount: sourceTreeManifest.rows.length,
      issues: Object.freeze([]),
    })]),
    artifactSettlement,
    blockers: Object.freeze([]),
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    packageVerificationReceiptHash:
      hashRecord('PackageVerificationReceipt', payload),
  });
}

function promotionGate({ paperId, experimentRegistryHash } = {}) {
  const payload = {
    version: 1,
    kind: 'ManuscriptPromotionGate',
    status: 'manuscript_promotion_ready',
    paperId,
    experimentRegistryHash,
    evidenceEntailmentReviewRequired: false,
    blockers: Object.freeze([]),
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    manuscriptPromotionGateHash: hashRecord('ManuscriptPromotionGate', payload),
  });
}

function artifactRecord(file) {
  return Object.freeze({
    role: file.role,
    filename: path.posix.basename(String(file.path).replace(/\\/g, '/')),
    path: file.path,
    sizeBytes: file.bytes,
    hash: file.hash,
  });
}

function buildPackageRecords({
  paperId,
  createdAt,
  sourceSnapshotHash,
  sourceTreeManifest,
  coreFiles,
  evidence,
  rebuild,
  artifactBaseRoot,
  candidateArtifactPackage,
  researchReport,
} = {}) {
  const artifacts = Object.freeze([
    ...coreFiles,
    rebuild.file,
  ].map(artifactRecord));
  const gate = promotionGate({
    paperId,
    experimentRegistryHash: researchReport.experimentRegistryHash,
  });
  const capsuleFiles = evidence.entries.map((entry) => Object.freeze({
    role: 'research_evidence_capsule_file',
    path: entry.path,
    packageRelativePath: entry.path,
    capsuleRole: entry.role,
    executionRole: entry.executionRole,
    experimentId: entry.experimentId,
    hash: entry.hash,
    bytes: entry.bytes,
  }));
  const manifestFile = Object.freeze({
    ...evidence.manifestFile,
    packageRelativePath: 'evidence/CAPSULE_MANIFEST.json',
    capsuleRole: 'research_evidence_capsule_manifest',
  });
  const attestationFile = evidence.attestationFile ? Object.freeze({
    ...evidence.attestationFile,
    packageRelativePath: RESEARCH_EXECUTION_RELEASE_ATTESTATION_PATH,
    capsuleRole: 'research_execution_release_attestation',
  }) : null;
  const packageRecordDocument = {
    version: 1,
    kind: 'ProductionCampaignReleasePackageRecordFixture',
    paperId,
    createdAt,
    sourceTreeManifestHash: sourceTreeManifest.sourceTreeManifestHash,
  };
  const packageRecordContent = jsonDocumentBytes(packageRecordDocument);
  const packageRecordFile = documentFile(
    'package_record',
    'PACKAGE_RECORD.json',
    packageRecordDocument,
  );
  const filesWithoutSums = Object.freeze([
    ...coreFiles,
    rebuild.file,
    packageRecordFile,
    manifestFile,
    ...capsuleFiles,
    ...(attestationFile ? [attestationFile] : []),
  ]);
  const sumsContent = Buffer.from(`${filesWithoutSums
    .map((file) => `${file.hash.slice('sha256:'.length)}  ${
      file.packageRelativePath || file.path
    }`).sort().join('\n')}\n`, 'utf8');
  const sumsFile = Object.freeze({
    role: 'sha256sums',
    path: 'SHA256SUMS.txt',
    hash: hashBytes(sumsContent),
    bytes: sumsContent.length,
  });
  const files = Object.freeze([...filesWithoutSums, sumsFile]);
  for (const file of coreFiles) {
    writeBoundFixtureFile(artifactBaseRoot, file, null, { existing: true });
  }
  writeBoundFixtureFile(artifactBaseRoot, rebuild.file, rebuild.content);
  writeBoundFixtureFile(
    artifactBaseRoot,
    packageRecordFile,
    packageRecordContent,
  );
  writeBoundFixtureFile(artifactBaseRoot, sumsFile, sumsContent);
  for (const [relative, content] of evidence.contents) {
    const file = files.find((candidate) => (
      (candidate.packageRelativePath || candidate.path) === relative
    ));
    if (!file) {
      throw new Error(`production_campaign_release_capsule_file_unbound:${relative}`);
    }
    writeBoundFixtureFile(artifactBaseRoot, file, content);
  }
  const verification = packageVerification({
    paperId,
    candidateArtifactPackage,
    sourceTreeManifest,
    files,
    artifacts,
  });
  const paperTask = Object.freeze({
    taskKey: `paper_factory:${paperId}`,
    paperId,
    channelId: null,
    productLineId: null,
    workflowId: null,
  });
  const artifactPackage = createPaperArtifactPackage({
    paperTask,
    mode: 'local-package',
    artifacts,
    packageStatus: 'package_ready',
    buildStatus: 'build_completed',
    submitReady: true,
    candidateArtifactPackageHash: candidateArtifactPackage.artifactPackageHash,
    packageVerificationReceipt: verification,
    sourceSnapshotHash,
    sourceTreeManifestHash: sourceTreeManifest.sourceTreeManifestHash,
    sourcePackageContractHash: sourceTreeManifest.sourcePackageContractHash,
    promotionGate: gate,
    createdAt,
  });
  const sourceZip = coreFiles.find((file) => file.role === 'generated_source_zip');
  const compiledPdf = coreFiles.find((file) => file.role === 'compiled_pdf');
  const rebuiltPdf = coreFiles.find((file) => file.role === 'independent_rebuilt_pdf');
  const outputPayload = {
    version: 1,
    kind: 'ImmutableCampaignPackageOutput',
    immutable: true,
    releaseRoot: artifactBaseRoot,
    packageDir: artifactBaseRoot,
    artifactBaseRoot,
    files,
    fileCount: files.length,
    sourceZipHash: sourceZip.hash,
    sourceZipPath: sourceZip.path,
    authoritativeCompiledPdfHash: compiledPdf.hash,
    independentRebuiltPdfHash: rebuiltPdf.hash,
    independentPdfRebuildVerificationReceiptHash:
      rebuild.receipt.independentPdfRebuildVerificationReceiptHash,
    independentPdfRebuildReceipt: rebuild.receipt,
    independentPdfRebuildReceiptFileHash: rebuild.file.hash,
    researchEvidenceCapsuleManifestHash:
      evidence.manifest.researchEvidenceCapsuleManifestHash,
    researchEvidenceCapsuleManifestFileHash: evidence.manifestFile.hash,
    researchExecutionReleaseAttestationHash:
      evidence.attestation?.campaignReleaseExecutionAttestationHash || null,
    researchExecutionReleaseAttestationFileHash:
      evidence.attestationFile?.hash || null,
    packageRecordHash: packageRecordFile.hash,
    sha256SumsHash: sumsFile.hash,
    packageVerificationReceiptHash: verification.packageVerificationReceiptHash,
    externalActionPerformed: false,
  };
  const packageOutput = Object.freeze({
    ...outputPayload,
    immutableCampaignPackageOutputHash:
      hashRecord('ImmutableCampaignPackageOutput', outputPayload),
  });
  return Object.freeze({
    artifacts,
    gate,
    verification,
    artifactPackage,
    packageOutput,
  });
}

export function currentCampaignReleaseAuthority({
  artifactBaseRoot,
  campaignId,
  campaignPlanHash,
  createdAt,
  experimentRegistryAuthorityVerifier,
  packageNode: basePackageNode,
  paperId,
  releaseBundle,
  venueTarget,
} = {}) {
  const releaseRoot = path.join(artifactBaseRoot, 'current-release-authority');
  const materializationReceipt = persistCampaignReleaseBundleSync({
    runtimeRoot: artifactBaseRoot,
    releaseRoot,
    bundle: releaseBundle,
  });
  const packageResultPayload = {
    version: 1,
    kind: 'CampaignReleasePackageResult',
    status: 'campaign_release_prepared',
    campaignId,
    paperId,
    packageNodeId: basePackageNode.nodeId,
    packageAttemptId: basePackageNode.attemptId,
    campaignPlanHash,
    campaignReleaseBundleHash: releaseBundle.campaignReleaseBundleHash,
    experimentRegistryHash: releaseBundle.experimentRegistryHash || null,
    empiricalAssertionAuthorityHash:
      releaseBundle.empiricalAssertionAuthorityHash || null,
    empiricalAssertionUniverseHash:
      releaseBundle.empiricalAssertionUniverseHash || null,
    empiricalAssertionUniverseBindingHash:
      releaseBundle.empiricalAssertionUniverseBindingHash || null,
    empiricalAssertionManuscriptCorpusHash:
      releaseBundle.empiricalAssertionManuscriptCorpusHash || null,
    releaseBundle,
    artifactPackage: releaseBundle.artifactPackage,
    packageVerificationReceipt: releaseBundle.packageVerificationReceipt,
    manuscriptPromotionGate: releaseBundle.manuscriptPromotionGate,
    campaignReleaseBundleMaterializationReceiptHash:
      materializationReceipt.campaignReleaseBundleMaterializationReceiptHash,
    materializationReceipt,
    submitReady: false,
    submissionConsumable: false,
    externalActionPerformed: false,
  };
  const packageResult = Object.freeze({
    ...packageResultPayload,
    campaignReleasePackageResultHash:
      hashRecord('CampaignReleasePackageResult', packageResultPayload),
  });
  const integrationDescriptorHash = hashRecord(
    'ProductionCampaignReleaseIntegrationDescriptorFixture',
    {
      campaignId,
      nodeId: basePackageNode.nodeId,
      attemptId: basePackageNode.attemptId,
      leaseGeneration: basePackageNode.leaseGeneration,
      packageResultHash: hashRecord('PaperCampaignNodeResult', packageResult),
    },
  );
  const integrationReceiptPayload = {
    version: 1,
    kind: 'WorkspaceAttemptIntegrationReceipt',
    status: 'workspace_attempt_integrated',
    descriptorHash: integrationDescriptorHash,
    campaignId,
    nodeId: basePackageNode.nodeId,
    attemptId: basePackageNode.attemptId,
    leaseGeneration: basePackageNode.leaseGeneration,
    integratedAt: createdAt,
    externalActionPerformed: false,
  };
  const integrationReceipt = Object.freeze({
    ...integrationReceiptPayload,
    workspaceAttemptIntegrationReceiptHash: hashRecord(
      'WorkspaceAttemptIntegrationReceipt',
      integrationReceiptPayload,
    ),
  });
  const packageNode = Object.freeze({
    ...basePackageNode,
    status: 'completed',
    preparedResultHash: hashRecord('PaperCampaignNodeResult', packageResult),
    preparedIntegrationStatus: 'integrated',
    preparedIntegrationKey: integrationDescriptorHash,
    preparedIntegrationReceiptHash:
      integrationReceipt.workspaceAttemptIntegrationReceiptHash,
  });
  const promotionReceipt = createCampaignReleasePromotionReceipt({
    campaign: {
      campaignId,
      paperId,
      spec: { campaignPlanHash, venueTarget },
    },
    packageNode,
    packageResult,
    promotedAt: createdAt,
    experimentRegistryAuthorityVerifier,
  });
  const {
    campaignReleasePromotionReceiptHash: _promotionReceiptHash,
    externalActionPerformed: _promotionExternalAction,
    kind: _promotionKind,
    status: _promotionStatus,
    submissionConsumable: _submissionConsumable,
    version: _promotionVersion,
    ...promotionMirror
  } = promotionReceipt;
  const authority = Object.freeze({
    version: 1,
    kind: 'CurrentCampaignReleaseAuthority',
    status: 'current_completed_release',
    ...promotionMirror,
    nodeRevision: 1,
    promotionReceipt,
    materializationReceipt,
    releaseBundle,
  });
  const verification = verifyCampaignReleaseAuthorityRecord(authority, {
    campaignId,
    campaignPlanHash,
    paperId,
    venueTarget,
    packageNodeId: packageNode.nodeId,
    packageAttemptId: packageNode.attemptId,
    leaseGeneration: packageNode.leaseGeneration,
    packageResultHash: packageNode.preparedResultHash,
    integrationDescriptorHash: packageNode.preparedIntegrationKey,
    integrationReceiptHash: packageNode.preparedIntegrationReceiptHash,
  }, { experimentRegistryAuthorityVerifier });
  if (!verification.valid) {
    throw new Error(
      `production_campaign_release_authority_invalid:${verification.blockers.join(',')}`,
    );
  }
  return Object.freeze({
    authority,
    integrationReceipt,
    materializationReceipt,
    packageNode,
    packageResult,
    promotionReceipt,
    verification,
  });
}

export function buildProductionCampaignReleaseClosureFixture({
  paperId,
  campaignId,
  campaignPlanHash,
  createdAt,
  manuscript,
  sourceTreeManifest,
  sourceWorkspace,
  artifactBaseRoot,
  packageFiles,
} = {}) {
  const coreFiles = Object.freeze([
    requiredFile(packageFiles, 'generated_source_zip'),
    requiredFile(packageFiles, 'compiled_pdf'),
    requiredFile(packageFiles, 'independent_rebuilt_pdf'),
  ]);
  const lineage = updateResearchLineage({
    manuscript,
    campaignId,
    paperId,
    sourceTreeManifest,
  });
  const nodes = campaignNodes({
    campaignId,
    researchReport: lineage.researchReport,
    lineage,
  });
  const evidence = researchEvidenceCapsule({
    campaignId,
    paperId,
    createdAt,
    researchReport: lineage.researchReport,
    lineage,
    manuscript,
  });
  const compiledPdf = coreFiles.find((file) => file.role === 'compiled_pdf');
  const rebuiltPdf = coreFiles.find(
    (file) => file.role === 'independent_rebuilt_pdf',
  );
  const rebuild = independentRebuild({
    paperId,
    createdAt,
    sourceTreeManifest,
    lineage,
    artifactBaseRoot,
    compiledPdf,
    rebuiltPdf,
  });
  const paperTask = Object.freeze({
    taskKey: `paper_factory:${paperId}`,
    paperId,
    channelId: null,
    productLineId: null,
    workflowId: null,
  });
  const sourceSnapshotHash = hashRecord(
    'ProductionCampaignReleaseSourceSnapshotFixture',
    {
      paperId,
      campaignId,
      sourceTreeManifestHash: sourceTreeManifest.sourceTreeManifestHash,
    },
  );
  const candidateArtifactPackage = createPaperArtifactPackage({
    paperTask,
    mode: 'local-package',
    artifacts: [...coreFiles, rebuild.file].map(artifactRecord),
    packageStatus: 'package_candidate',
    buildStatus: 'build_completed',
    submitReady: false,
    sourceSnapshotHash,
    sourceTreeManifestHash: sourceTreeManifest.sourceTreeManifestHash,
    sourcePackageContractHash: sourceTreeManifest.sourcePackageContractHash,
    createdAt,
  });
  const packaged = buildPackageRecords({
    paperId,
    createdAt,
    sourceSnapshotHash,
    sourceTreeManifest,
    coreFiles,
    evidence,
    rebuild,
    artifactBaseRoot,
    candidateArtifactPackage,
    researchReport: lineage.researchReport,
  });
  const promotionCandidate = createAutomationPromotionCandidate({
    campaignPlanHash,
    campaignId,
    paperId,
    venueTarget: manuscript.venueProfileSelection.venueId,
    packageNode: nodes.packageNode,
    finalCompileNode: nodes.finalCompileNode,
    researchVerifyNode: nodes.researchVerifyNode,
    researchReport: lineage.researchReport,
    campaignResearchSourceSnapshot: lineage.campaignResearchSourceSnapshot,
    verifiedSourceMerkleHash: lineage.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash:
      lineage.verifiedSourceWorkspaceManifestHash,
    sourceWorkspace,
    sourceSnapshotHash,
    sourceTreeManifest,
    researchEvidenceCapsuleManifest: evidence.manifest,
    researchExecutionReleaseAttestation: evidence.attestation,
    autonomousResearchReleaseBinding: lineage.releaseBinding,
    createdAt,
    experimentRegistryAuthorityVerifier:
      manuscript.experimentRegistryAuthorityVerifier,
  });
  const releaseBundle = createCampaignReleaseBundle({
    promotionCandidate,
    artifactPackage: packaged.artifactPackage,
    packageVerificationReceipt: packaged.verification,
    manuscriptPromotionGate: packaged.gate,
    researchReport: lineage.researchReport,
    researchEvidenceCapsuleManifest: evidence.manifest,
    researchExecutionReleaseAttestation: evidence.attestation,
    packageOutput: packaged.packageOutput,
    createdAt,
    experimentRegistryAuthorityVerifier:
      manuscript.experimentRegistryAuthorityVerifier,
  });
  const verification = verifyCampaignReleaseBundle(releaseBundle, {
    campaignId,
    campaignPlanHash,
    paperId,
    venueTarget: manuscript.venueProfileSelection.venueId,
    packageNodeId: nodes.packageNode.nodeId,
    packageAttemptId: nodes.packageNode.attemptId,
    researchReportHash: lineage.researchReport.researchReportHash,
    experimentRegistryHash: lineage.researchReport.experimentRegistryHash,
    proposalClaimToTheoremBindingHash:
      lineage.researchReport.proposalClaimToTheoremBindingHash,
    autonomousResearchReleaseBindingHash:
      lineage.releaseBinding.autonomousResearchReleaseBindingHash,
    researchVerifyNodeId: lineage.researchNodeId,
    researchVerifyAttemptId: lineage.researchAttemptId,
    researchVerifyLeaseGeneration: lineage.researchLeaseGeneration,
    verifiedSourceMerkleHash: lineage.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash:
      lineage.verifiedSourceWorkspaceManifestHash,
  }, {
    experimentRegistryAuthorityVerifier:
      manuscript.experimentRegistryAuthorityVerifier,
  });
  if (!verification.valid) {
    throw new Error(
      `production_campaign_release_fixture_invalid:${verification.blockers.join(',')}`,
    );
  }
  const releaseAuthority = currentCampaignReleaseAuthority({
    artifactBaseRoot,
    campaignId,
    campaignPlanHash,
    createdAt,
    experimentRegistryAuthorityVerifier:
      manuscript.experimentRegistryAuthorityVerifier,
    packageNode: nodes.packageNode,
    paperId,
    releaseBundle,
    venueTarget: manuscript.venueProfileSelection.venueId,
  });
  return Object.freeze({
    manuscript: Object.freeze({
      ...manuscript,
      researchReport: lineage.researchReport,
      releaseBinding: lineage.releaseBinding,
    }),
    researchReport: lineage.researchReport,
    releaseBinding: lineage.releaseBinding,
    campaignResearchSourceSnapshot: lineage.campaignResearchSourceSnapshot,
    finalCompileNode: nodes.finalCompileNode,
    researchVerifyNode: nodes.researchVerifyNode,
    packageNode: releaseAuthority.packageNode,
    researchEvidenceCapsuleManifest: evidence.manifest,
    researchExecutionReleaseAttestation: evidence.attestation,
    artifactPackage: packaged.artifactPackage,
    packageVerificationReceipt: packaged.verification,
    manuscriptPromotionGate: packaged.gate,
    packageOutput: packaged.packageOutput,
    promotionCandidate,
    releaseBundle,
    campaignReleaseAuthority: releaseAuthority.authority,
    campaignReleaseAuthorityVerification: releaseAuthority.verification,
    campaignReleasePromotionReceipt: releaseAuthority.promotionReceipt,
    campaignReleaseMaterializationReceipt:
      releaseAuthority.materializationReceipt,
    campaignReleasePackageResult: releaseAuthority.packageResult,
    campaignReleaseIntegrationReceipt: releaseAuthority.integrationReceipt,
  });
}
