import path from 'node:path';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import {
  buildCampaignReleaseEvidenceCapsuleManifest,
  verifyCampaignReleaseEvidenceCapsuleManifest,
} from '../../paper-domain/automation/campaign-release-evidence-capsule-contract.mjs';
import {
  prepareCampaignReleaseGpuScientificCapsuleEvidenceSync,
  verifyCampaignReleaseGpuScientificCapsuleDirectorySync,
} from './research-evidence-capsule-gpu-scientific.mjs';
import {
  verifyExperimentReplayReceipt,
  verifyExperimentRunReceipt,
} from '../../paper-domain/automation/experiment-run-contract.mjs';
import {
  buildPublicAuthorityTrustSnapshot,
  verifyPublicAuthorityTrustSnapshot,
} from '../../paper-domain/automation/public-authority-trust-snapshot-contract.mjs';
import { verifyArtifactWriteReceiptSource } from '../artifacts/artifact-write-receipt-verifier.mjs';
import { materializeResearchEvidenceCapsuleFilesSync } from './research-evidence-capsule-repository.mjs';
import { buildOfflineOperatorDatasetAuthorityEvidence, verifyOfflineOperatorDatasetAuthorityEvidence } from './offline-operator-dataset-authority-verifier.mjs';
import { verifyOfflineResearchExecutionReleaseAttestation } from './offline-research-execution-release-attestation-verifier.mjs';
import { attestResearchEvidenceCapsuleManifest } from './research-evidence-capsule-attestation.mjs';
import {
  RESEARCH_EXECUTION_RELEASE_ATTESTATION_PATH,
  verifyCampaignReleaseExecutionAttestationStructure,
} from '../../paper-domain/automation/campaign-release-execution-attestation-contract.mjs';
import {
  listResearchEvidenceCapsuleFiles,
  parseResearchEvidenceCapsuleJson,
  readResearchEvidenceCapsuleFile,
  readResearchEvidenceCapsuleSha256Sums,
} from './research-evidence-capsule-directory-reader.mjs';
import {
  portableResearchEvidenceDocument as portableDocument,
  portableResearchEvidenceValue as portableValue,
  researchEvidencePublicationBlockers as assertNoPrivateMaterial,
} from './research-evidence-capsule-publication-policy.mjs';
import {
  empiricalAssertionResearchReportValid,
  portableExperimentRegistryWithAssertionDerivation,
} from './research-evidence-empirical-assertion-binding.mjs';
import { researchEvidenceRecomputationIndependenceSummary } from './research-evidence-recomputation-binding.mjs';
import { buildCampaignReleaseFormalReadableProofEvidence } from './research-evidence-formal-readable-proof.mjs';
import { portableExperimentBindingsValid } from './research-evidence-capsule-portable-bindings-verifier.mjs';
export { createResearchExecutionReleaseAttestor } from './research-execution-release-attestor.mjs';
const MAXIMUM_CAPSULE_FILE_BYTES = 256 * 1024 * 1024;
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\/-]{1,512}$/;
function safeSegment(value) {
  const text = String(value || 'experiment');
  const prefix = text.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'experiment';
  return `${prefix}-${hashRecord('ResearchEvidenceCapsulePathSegment', text).slice(-12)}`;
}
function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function fileEntry({ role, relativePath, content, executionRole = 'base', experimentId = null }) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (!SAFE_RELATIVE_PATH.test(relativePath) || !relativePath.startsWith('evidence/')) {
    throw new Error(`research_evidence_capsule_path_invalid:${relativePath}`);
  }
  if (bytes.length > MAXIMUM_CAPSULE_FILE_BYTES) throw new Error(`research_evidence_capsule_file_too_large:${relativePath}`);
  return Object.freeze({
    role,
    path: relativePath,
    hash: hashBytes(bytes),
    bytes: bytes.length,
    executionRole,
    experimentId,
    content: bytes,
  });
}

function ledgerReceiptSummary(receiptLedger, receiptId, expectedHash) {
  if (!receiptLedger || typeof receiptLedger.get !== 'function' || !receiptId) {
    throw new Error('research_evidence_capsule_ledger_authority_required');
  }
  const row = receiptLedger.get(receiptId);
  if (!row || row.receipt_id !== receiptId || row.receipt_sha256 !== expectedHash
    || Number(row.writer_trusted || 0) !== 1 || !row.writer_id || !row.writer_kind
    || !row.issuer_policy_id || !row.issuer_policy_hash) {
    throw new Error(`research_evidence_capsule_ledger_receipt_invalid:${receiptId}`);
  }
  return Object.freeze({
    receiptId: row.receipt_id,
    receiptHash: row.receipt_sha256,
    kind: row.kind,
    status: row.status,
    stream: row.stream,
    paperId: row.paper_id || null,
    writerId: row.writer_id,
    writerKind: row.writer_kind,
    writerTrusted: true,
    issuerPolicyId: row.issuer_policy_id,
    issuerPolicyHash: row.issuer_policy_hash,
    issuerAssurance: row.issuer_assurance || null,
    effectiveDisposition: row.effective_disposition || null,
  });
}

function rawArtifactBytes(receipt) {
  const verification = verifyArtifactWriteReceiptSource({ receipt });
  if (verification.status !== 'artifact_write_receipt_source_verified') {
    throw new Error(`research_evidence_capsule_raw_source_invalid:${verification.blockers.join(',')}`);
  }
  const read = readScopedFileSync({
    scopeRoot: receipt.scopeRoot,
    candidate: path.resolve(receipt.scopeRoot, receipt.path),
    maximumBytes: 16 * 1024 * 1024,
  });
  if (read.status !== 'scoped_file_read_verified' || read.hash !== receipt.hash
    || Number(read.bytes) !== Number(receipt.bytes)) {
    throw new Error('research_evidence_capsule_raw_source_changed');
  }
  return read.content;
}

function publicArtifactEvidence(receipt, receiptLedger) {
  return Object.freeze({
    version: 1,
    kind: 'PortableArtifactWriteAuthorityEvidence',
    repositoryId: receipt.repositoryId,
    role: receipt.role,
    contentType: receipt.contentType,
    logicalPath: receipt.path,
    bytes: Number(receipt.bytes),
    contentHash: receipt.hash,
    contentAddress: receipt.contentAddress,
    immutableArtifactManifestHash: receipt.manifestHash,
    artifactWriteReceiptHash: receipt.writeReceiptHash,
    ledgerReceiptId: receipt.ledgerReceiptId,
    immutableObject: receipt.immutableObject === true,
    atomic: receipt.atomic === true,
    createdAt: receipt.createdAt,
    ledgerEvidenceAssurance: 'trusted-runtime-row-summary-structural-only-v1',
    ledgerReceiptSummary: ledgerReceiptSummary(receiptLedger, receipt.ledgerReceiptId, receipt.writeReceiptHash),
  });
}

function executionEnvironment(runReceipt, executionRole) {
  const harness = runReceipt.harnessExecutionReceipt;
  return Object.freeze({
    executionRole,
    experimentRunReceiptHash: runReceipt.experimentRunReceiptHash,
    experimentAttemptId: runReceipt.experimentAttemptId,
    executionReceiptHash: runReceipt.executionReceiptHash,
    runtimeIdentityHash: runReceipt.runtimeIdentityHash,
    sourceMerkleHash: runReceipt.sourceMerkleHash,
    sourceWorkspaceManifestHash: runReceipt.sourceWorkspaceManifestHash,
    sourceLineageHash: runReceipt.sourceLineageHash,
    environmentBindingHash: harness.environmentBindingHash,
    environmentBomHash: runReceipt.environmentBomHash,
    environmentBom: portableValue(runReceipt.environmentBom),
    datasetAuthorizationSetHash: runReceipt.datasetAuthorizationSetHash,
    backendSet: [...new Set((harness.armBatchExecutions || []).map((batch) => batch.runnerReceipt?.backend).filter(Boolean))].sort(),
    runtimeIdentityTypes: [...new Set((harness.armBatchExecutions || []).map((batch) => batch.runnerReceipt?.runtimeIdentityType).filter(Boolean))].sort(),
    runtimeExecutableSnapshotHashes: [...new Set((harness.armBatchExecutions || []).map((batch) => batch.runnerReceipt?.runtimeExecutableSnapshotHash).filter(Boolean))].sort(),
    containerImageDigests: [...new Set((harness.armBatchExecutions || []).map((batch) => batch.runnerReceipt?.containerImageDigest).filter(Boolean))].sort(),
    resourceLimits: (harness.armBatchExecutions || []).map((batch) => portableValue(batch.runnerReceipt?.limits || {})),
    isolation: (harness.armBatchExecutions || []).map((batch) => portableValue(batch.runnerReceipt?.isolation || {})),
    hardware: Object.freeze({
      gpuAccessRequested: (harness.armBatchExecutions || []).some((batch) => batch.runnerReceipt?.isolation?.gpuAccessRequested === true),
      gpuDeviceIsolationVerified: (harness.armBatchExecutions || []).every((batch) => batch.runnerReceipt?.isolation?.gpuDeviceIsolationVerified !== false),
      hardwareModelAttested: false,
    }),
  });
}

function resultBytes(runReceipt) {
  const harness = runReceipt?.harnessExecutionReceipt;
  if (!harness?.resultDocument || typeof harness.csvDocument !== 'string') {
    throw new Error('research_evidence_capsule_result_documents_missing');
  }
  const json = jsonBytes(harness.resultDocument);
  const csv = Buffer.from(harness.csvDocument, 'utf8');
  if (hashBytes(json) !== runReceipt.resultJsonHash || hashBytes(csv) !== runReceipt.resultCsvHash) {
    throw new Error('research_evidence_capsule_result_document_hash_mismatch');
  }
  return { json, csv };
}

function experimentFilesAndEvidence(experiment, receiptLedger) {
  const binding = experiment?.evidenceBinding;
  const authority = binding?.authorityEvidence;
  const original = authority?.experimentRunReceipt;
  const replayReceipt = authority?.experimentReplayReceipt;
  const replay = replayReceipt?.replayRunReceipt;
  if (experiment?.academicPromotionEligible !== true || binding?.academicPromotionEligible !== true
    || !verifyExperimentRunReceipt(original) || !verifyExperimentRunReceipt(replay)
    || !verifyExperimentReplayReceipt(replayReceipt)) {
    throw new Error(`research_evidence_capsule_academic_experiment_invalid:${experiment?.experimentId || 'missing'}`);
  }
  const id = String(experiment.experimentId);
  const directory = `evidence/experiments/${safeSegment(id)}`;
  const files = [];
  const executions = [];
  const publicArtifacts = {};
  const environments = [];
  for (const [executionRole, run] of [['original', original], ['independent-replay', replay]]) {
    const result = resultBytes(run);
    const raw = rawArtifactBytes(run.rawArtifactWriteReceipt);
    if (hashBytes(raw) !== run.rawEventArtifactHash || raw.length !== Number(run.rawEventArtifactBytes)) {
      throw new Error(`research_evidence_capsule_raw_artifact_mismatch:${id}:${executionRole}`);
    }
    const roleDirectory = `${directory}/${executionRole}`;
    files.push(
      fileEntry({ role: 'experiment_results_json', relativePath: `${roleDirectory}/results.json`, content: result.json, executionRole, experimentId: id }),
      fileEntry({ role: 'experiment_results_csv', relativePath: `${roleDirectory}/results.csv`, content: result.csv, executionRole, experimentId: id }),
      fileEntry({ role: 'experiment_raw_events', relativePath: `${roleDirectory}/raw-events.ndjson`, content: raw, executionRole, experimentId: id }),
    );
    const environmentBindingHash = run.harnessExecutionReceipt?.environmentBindingHash || run.runnerReceipt?.environmentBindingHash;
    executions.push(Object.freeze({
      executionRole,
      experimentRunReceiptHash: run.experimentRunReceiptHash,
      executionReceiptHash: run.executionReceiptHash,
      runtimeIdentityHash: run.runtimeIdentityHash,
      environmentBindingHash,
      environmentBomHash: run.environmentBomHash,
      experimentAttemptId: run.experimentAttemptId,
      resultJsonHash: run.resultJsonHash,
      resultCsvHash: run.resultCsvHash,
      rawEventArtifactHash: run.rawEventArtifactHash,
      rawEventArtifactBytes: Number(run.rawEventArtifactBytes),
      rawArtifactWriteReceiptHash: run.rawArtifactWriteReceipt.writeReceiptHash,
      rawArtifactLedgerReceiptId: run.rawArtifactWriteReceipt.ledgerReceiptId,
    }));
    publicArtifacts[executionRole] = publicArtifactEvidence(run.rawArtifactWriteReceipt, receiptLedger);
    environments.push(executionEnvironment(run, executionRole));
  }
  const trustedReceipts = [authority.workerReceipt, authority.replayWorkerReceipt, authority.reproducibilityLedgerReceipt];
  if (trustedReceipts.some((receipt) => !receipt?.receiptHash || !receipt?.ledgerReceiptId)) {
    throw new Error(`research_evidence_capsule_trusted_receipts_missing:${id}`);
  }
  const trustedLedgerReceiptSummaries = trustedReceipts
    .map((receipt) => ledgerReceiptSummary(receiptLedger, receipt.ledgerReceiptId, receipt.receiptHash));
  const offlineOperatorDatasetAuthorityEvidence = buildOfflineOperatorDatasetAuthorityEvidence({
    originalRunReceipt: original,
    replayRunReceipt: replay,
  });
  const publicAuthority = Object.freeze({
    experimentId: id,
    experimentEvidenceBindingHash: binding.experimentEvidenceBindingHash,
    experimentReplayReceiptHash: replayReceipt.experimentReplayReceiptHash,
    sourceLineageHash: binding.sourceLineageHash,
    analysisProtocolHash: binding.analysisProtocolHash,
    originalAnalysisEvaluationHash: binding.originalAnalysisEvaluationHash,
    replayAnalysisEvaluationHash: binding.replayAnalysisEvaluationHash,
    analysisProtocolReplayBindingHash: binding.analysisProtocolReplayBindingHash,
    originalEnvironmentBomHash: replayReceipt.originalEnvironmentBomHash,
    replayEnvironmentBomHash: replayReceipt.replayEnvironmentBomHash,
    replayAssuranceScope: replayReceipt.replayAssuranceScope,
    ...researchEvidenceRecomputationIndependenceSummary(binding),
    offlineOperatorDatasetAuthorityEvidence: portableValue(offlineOperatorDatasetAuthorityEvidence),
    workerReceipt: portableValue(authority.workerReceipt),
    replayWorkerReceipt: portableValue(authority.replayWorkerReceipt),
    reproducibilityLedgerReceipt: portableValue(authority.reproducibilityLedgerReceipt),
    artifactAuthority: publicArtifacts,
    ledgerEvidenceAssurance: 'structural-receipt-summaries-not-cryptographic-inclusion-proof-v1',
    trustedLedgerReceiptSummaries,
  });
  return Object.freeze({
    files,
    descriptor: Object.freeze({
      experimentId: id,
      academicPromotionEligible: true,
      experimentEvidenceBindingHash: binding.experimentEvidenceBindingHash,
      experimentReplayReceiptHash: replayReceipt.experimentReplayReceiptHash,
      sourceLineageHash: binding.sourceLineageHash,
      analysisProtocolHash: binding.analysisProtocolHash,
      originalAnalysisEvaluationHash: binding.originalAnalysisEvaluationHash,
      replayAnalysisEvaluationHash: binding.replayAnalysisEvaluationHash,
      analysisProtocolReplayBindingHash: binding.analysisProtocolReplayBindingHash,
      originalEnvironmentBomHash: replayReceipt.originalEnvironmentBomHash,
      replayEnvironmentBomHash: replayReceipt.replayEnvironmentBomHash,
      replayAssuranceScope: replayReceipt.replayAssuranceScope,
      ...researchEvidenceRecomputationIndependenceSummary(binding),
      executions: Object.freeze(executions),
    }),
    publicAuthority,
    referencedAuthorityKeyIds: Object.freeze([...new Set([
      ...(original.harnessExecutionReceipt?.operatorDatasetHarnessAuthority?.authority?.signatures || []),
      ...(replay.harnessExecutionReceipt?.operatorDatasetHarnessAuthority?.authority?.signatures || []),
    ].map((signature) => String(signature?.keyId || '')).filter(Boolean))].sort()),
    environments,
  });
}

export async function materializeCampaignReleaseEvidenceCapsule({
  packageDir,
  researchReport,
  campaignId,
  paperId,
  receiptLedger,
  operatorDatasetAuthorityTrustStore = null,
  researchExecutionReleaseAttestor = null,
  assertExternalSideEffectReady = null,
  academicEvidenceRequired = false,
  runtimeRoot = null,
  gpuScientificExecutionPlan = null,
  gpuScientificExecutionNode = null,
  gpuScientificExecutionResult = null,
  gpuScientificQualificationEvidence = null,
  gpuScientificArtifactBodyArchiveManifest = null,
  createdAt,
} = {}) {
  if (!packageDir || researchReport?.kind !== 'PaperResearchVerifyReport' || !researchReport?.researchReportHash
    || researchReport?.promotionEligibility?.status !== 'research_promotion_ready') {
    throw new Error('research_evidence_capsule_research_report_required');
  }
  const registry = researchReport?.capabilities?.experimentRegistry;
  if (!registry?.experimentRegistryHash || registry.experimentRegistryHash !== researchReport.experimentRegistryHash) {
    throw new Error('research_evidence_capsule_experiment_registry_invalid');
  }
  if (!empiricalAssertionResearchReportValid(researchReport, { campaignId, registry })) {
    throw new Error('research_evidence_capsule_empirical_assertion_binding_invalid');
  }
  const academicIds = new Set(registry.academicPromotionEligibleExperimentIds || []);
  const academicExperiments = (registry.experiments || []).filter((experiment) => experiment.academicPromotionEligible === true);
  if (academicExperiments.length !== Number(registry.academicExperimentCount || 0)
    || academicExperiments.some((experiment) => !academicIds.has(experiment.experimentId))) {
    throw new Error('research_evidence_capsule_academic_registry_summary_invalid');
  }
  if (academicEvidenceRequired && academicExperiments.length < 1) {
    throw new Error('research_evidence_capsule_academic_evidence_required');
  }
  const gpuScientificCapsuleEvidence =
    prepareCampaignReleaseGpuScientificCapsuleEvidenceSync({
      runtimeRoot,
      packageDir,
      campaignId,
      paperId,
      gpuScientificExecutionPlan,
      gpuScientificExecutionNode,
      gpuScientificExecutionResult,
      gpuScientificQualificationEvidence,
      gpuScientificArtifactBodyArchiveManifest,
      createdAt,
    });
  const gpuScientificEvidenceIncluded =
    gpuScientificCapsuleEvidence.included;
  const materialized = academicExperiments.map((experiment) => experimentFilesAndEvidence(experiment, receiptLedger));
  const publicAuthorityTrustSnapshot = buildPublicAuthorityTrustSnapshot({
    trustStore: operatorDatasetAuthorityTrustStore || { version: 1, kind: 'AuthorityTrustStore', keys: [] },
    referencedKeyIds: [
      ...materialized.flatMap((item) => item.referencedAuthorityKeyIds),
      ...gpuScientificCapsuleEvidence.referencedAuthorityKeyIds,
    ],
    capturedAt: createdAt,
  });
  const portableReport = portableDocument('PortablePaperResearchVerifyReport', 'sourceResearchReportHash', researchReport.researchReportHash, researchReport);
  const portableRegistry = portableExperimentRegistryWithAssertionDerivation({ registry, paperId, campaignId });
  const environmentManifest = Object.freeze({
    version: 2,
    kind: 'CampaignReleaseResearchEnvironmentManifest',
    campaignId,
    paperId,
    researchReportHash: researchReport.researchReportHash,
    experimentRegistryHash: registry.experimentRegistryHash,
    verifiedSourceMerkleHash: researchReport.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash: researchReport.verifiedSourceWorkspaceManifestHash,
    environmentBomEvidenceIncluded: materialized.length > 0,
    environmentBomCount: materialized.length * 2,
    experiments: materialized.map((item) => Object.freeze({
      experimentId: item.descriptor.experimentId,
      sourceLineageHash: item.descriptor.sourceLineageHash,
      originalEnvironmentBomHash: item.descriptor.originalEnvironmentBomHash,
      replayEnvironmentBomHash: item.descriptor.replayEnvironmentBomHash,
      replayAssuranceScope: item.descriptor.replayAssuranceScope,
      executions: item.environments,
    })),
    hardwareDisclosure: materialized.length
      ? 'hash-bound-observed-environment-bom-no-independent-hardware-replication-claim-v1'
      : 'no-academic-experiment-environment-bom-v1',
  });
  const publicAuthorityEvidence = Object.freeze({
    version: 1,
    kind: 'CampaignReleasePublicResearchAuthorityEvidence',
    campaignId,
    paperId,
    researchReportHash: researchReport.researchReportHash,
    experimentRegistryHash: registry.experimentRegistryHash,
    publicAuthorityTrustSnapshotHash: publicAuthorityTrustSnapshot.publicAuthorityTrustSnapshotHash,
    publicAuthorityTrustAssurance: 'package-internal-public-key-disclosure-not-trust-anchor-v1',
    sourceAuthenticityRequiresExternalTrustAnchor:
      academicExperiments.length > 0 || gpuScientificEvidenceIncluded,
    experiments: materialized.map((item) => item.publicAuthority),
    ...(gpuScientificEvidenceIncluded ? {
      gpuScientificQualificationAuthority:
        gpuScientificCapsuleEvidence.authoritySummary,
    } : {}),
    ledgerEvidenceAssurance: 'structural-receipt-summaries-not-cryptographic-inclusion-proof-v1',
    privateKeysIncluded: false,
    hiddenOracleIncluded: false,
    hostAbsolutePathsIncluded: false,
  });
  const formalReadableProofEvidence = buildCampaignReleaseFormalReadableProofEvidence({ researchReport, campaignId, paperId });
  const gpuScientificQualificationFile =
    gpuScientificCapsuleEvidence.qualificationFile;
  const files = [
    fileEntry({ role: 'portable_research_report', relativePath: 'evidence/RESEARCH_REPORT.json', content: jsonBytes(portableReport) }),
    fileEntry({ role: 'portable_experiment_registry', relativePath: 'evidence/EXPERIMENT_REGISTRY.json', content: jsonBytes(portableRegistry) }),
    fileEntry({ role: 'research_environment_manifest', relativePath: 'evidence/ENVIRONMENT_MANIFEST.json', content: jsonBytes(environmentManifest) }),
    fileEntry({ role: 'research_public_authority_evidence', relativePath: 'evidence/PUBLIC_AUTHORITY_EVIDENCE.json', content: jsonBytes(publicAuthorityEvidence) }),
    fileEntry({ role: 'public_authority_trust_snapshot', relativePath: 'evidence/PUBLIC_AUTHORITY_TRUST_SNAPSHOT.json', content: jsonBytes(publicAuthorityTrustSnapshot) }),
    ...(formalReadableProofEvidence ? [fileEntry({ role: 'formal_readable_proof_explanations', relativePath: 'evidence/FORMAL_READABLE_PROOF_EXPLANATIONS.json', content: jsonBytes(formalReadableProofEvidence) })] : []),
    ...materialized.flatMap((item) => item.files),
    ...gpuScientificCapsuleEvidence.files,
  ];
  for (const file of files.filter((entry) => /\.(?:json|ndjson)$/i.test(entry.path))) {
    const content = file.content || readResearchEvidenceCapsuleFile(
      path.resolve(packageDir),
      file.path,
      MAXIMUM_CAPSULE_FILE_BYTES,
    ).content;
    if (!content) throw new Error(`research_evidence_capsule_file_unreadable:${file.path}`);
    const documents = file.path.endsWith('.ndjson')
      ? content.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      : [JSON.parse(content.toString('utf8'))];
    const privateBlockers = documents.flatMap((document) => assertNoPrivateMaterial(document));
    if (privateBlockers.length) throw new Error(`research_evidence_capsule_private_material_forbidden:${file.path}:${privateBlockers.join(',')}`);
  }
  const manifest = buildCampaignReleaseEvidenceCapsuleManifest({
    campaignId,
    paperId,
    researchReportHash: researchReport.researchReportHash,
    experimentRegistryHash: registry.experimentRegistryHash,
    campaignResearchSourceSnapshotHash: researchReport.campaignResearchSourceSnapshotHash,
    verifiedSourceMerkleHash: researchReport.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash: researchReport.verifiedSourceWorkspaceManifestHash,
    researchVerifyNodeId: researchReport.researchNodeId,
    researchVerifyAttemptId: researchReport.researchAttemptId,
    researchVerifyLeaseGeneration: researchReport.researchLeaseGeneration,
    publicAuthorityTrustSnapshotHash: publicAuthorityTrustSnapshot.publicAuthorityTrustSnapshotHash,
    experiments: materialized.map((item) => item.descriptor),
    entries: files,
    gpuScientificArtifactBodyArchiveManifest:
      gpuScientificCapsuleEvidence.artifactBodyArchive?.manifest || null,
    gpuScientificQualificationEvidence:
      gpuScientificQualificationEvidence || null,
    createdAt,
  });
  const manifestFile = fileEntry({
    role: 'research_evidence_capsule_manifest',
    relativePath: 'evidence/CAPSULE_MANIFEST.json',
    content: jsonBytes(manifest),
  });
  let executionAttestation = null;
  let executionAttestationFile = null;
  if (manifest.externalExecutionAttestationRequired) {
    executionAttestation = await attestResearchEvidenceCapsuleManifest({
      researchExecutionReleaseAttestor,
      assertExternalSideEffectReady,
      manifest,
      manifestFileHash: manifestFile.hash,
      campaignId,
      paperId,
      signedAt: createdAt,
    });
    const attestationVerification = verifyCampaignReleaseExecutionAttestationStructure(executionAttestation, {
      manifest,
      researchEvidenceCapsuleManifestHash: manifest.researchEvidenceCapsuleManifestHash,
      researchEvidenceCapsuleManifestFileHash: manifestFile.hash,
    });
    if (!attestationVerification.valid) {
      throw new Error(`research_evidence_capsule_execution_attestation_invalid:${attestationVerification.blockers.join(',')}`);
    }
    if (typeof researchExecutionReleaseAttestor.verifyAttestation !== 'function'
      || researchExecutionReleaseAttestor.verifyAttestation({
        attestation: executionAttestation,
        manifest,
        manifestFileHash: manifestFile.hash,
      }) !== true) throw new Error('research_evidence_capsule_execution_attestation_signature_not_verified');
    executionAttestationFile = fileEntry({
      role: 'research_execution_release_attestation',
      relativePath: RESEARCH_EXECUTION_RELEASE_ATTESTATION_PATH,
      content: jsonBytes(executionAttestation),
    });
  }
  const allFiles = [...files, manifestFile, ...(executionAttestationFile ? [executionAttestationFile] : [])];
  materializeResearchEvidenceCapsuleFilesSync({
    packageDir,
    files: allFiles.filter((file) => file.content),
  });
  return Object.freeze({
    version: manifest.version,
    kind: 'MaterializedCampaignReleaseResearchEvidenceCapsule',
    status: 'research_evidence_capsule_materialized',
    manifest,
    researchEvidenceCapsuleManifestHash: manifest.researchEvidenceCapsuleManifestHash,
    researchExecutionReleaseAttestation: executionAttestation,
    researchExecutionReleaseAttestationHash: executionAttestation?.campaignReleaseExecutionAttestationHash || null,
    manifestFile: Object.freeze({ ...manifestFile, content: undefined }),
    executionAttestationFile: executionAttestationFile
      ? Object.freeze({ ...executionAttestationFile, content: undefined }) : null,
    gpuScientificArtifactBodyArchive:
      gpuScientificCapsuleEvidence.artifactBodyArchive,
    gpuScientificArtifactBodyArchiveManifest:
      gpuScientificCapsuleEvidence.artifactBodyArchive?.manifest || null,
    gpuScientificArtifactBodyArchiveManifestFile:
      gpuScientificCapsuleEvidence.artifactBodyArchive?.manifestFile || null,
    gpuScientificArtifactBodyArchiveBodyFiles:
      gpuScientificCapsuleEvidence.artifactBodyArchive?.bodyFiles
        || Object.freeze([]),
    gpuScientificQualificationEvidence:
      gpuScientificQualificationEvidence || null,
    gpuScientificQualificationEvidenceFile:
      gpuScientificQualificationFile
        ? Object.freeze({
          ...gpuScientificQualificationFile,
          content: undefined,
        }) : null,
    files: Object.freeze(files.map((file) => Object.freeze({ ...file, content: undefined }))),
    allFiles: Object.freeze(allFiles.map((file) => Object.freeze({ ...file, content: undefined }))),
  });
}

export function verifyCampaignReleaseEvidenceCapsuleDirectory({ packageDir, expected = {} } = {}) {
  const blockers = [];
  const root = path.resolve(packageDir || '.');
  const manifestRead = readResearchEvidenceCapsuleFile(root, 'evidence/CAPSULE_MANIFEST.json', 16 * 1024 * 1024);
  if (!manifestRead.content) blockers.push('research_evidence_capsule_manifest_missing');
  const manifest = manifestRead.content ? parseResearchEvidenceCapsuleJson(manifestRead.content) : null;
  if (manifestRead.content && !manifest) blockers.push('research_evidence_capsule_manifest_json_invalid');
  const contract = verifyCampaignReleaseEvidenceCapsuleManifest(manifest, expected);
  blockers.push(...contract.blockers);
  const sums = readResearchEvidenceCapsuleSha256Sums(root);
  const expectedFiles = [
    ...(manifest?.entries || []),
    ...(manifestRead.content ? [{ path: 'evidence/CAPSULE_MANIFEST.json', hash: manifestRead.hash, bytes: manifestRead.bytes }] : []),
  ];
  const attestationRead = manifest?.externalExecutionAttestationRequired
    ? readResearchEvidenceCapsuleFile(root, RESEARCH_EXECUTION_RELEASE_ATTESTATION_PATH, 1024 * 1024)
    : null;
  if (manifest?.externalExecutionAttestationRequired && !attestationRead?.content) {
    blockers.push('research_execution_release_attestation_file_missing');
  }
  if (attestationRead?.content) expectedFiles.push({
    path: RESEARCH_EXECUTION_RELEASE_ATTESTATION_PATH,
    hash: attestationRead.hash,
    bytes: attestationRead.bytes,
  });
  const expectedPaths = expectedFiles.map((item) => item.path).sort();
  if (JSON.stringify(listResearchEvidenceCapsuleFiles(root)) !== JSON.stringify(expectedPaths)) {
    blockers.push('research_evidence_capsule_unbound_or_missing_file');
  }
  const documents = new Map();
  for (const entry of expectedFiles) {
    const read = readResearchEvidenceCapsuleFile(root, entry.path, MAXIMUM_CAPSULE_FILE_BYTES);
    if (!read.content) { blockers.push(`research_evidence_capsule_file_missing:${entry.path}`); continue; }
    if (read.hash !== entry.hash || Number(read.bytes) !== Number(entry.bytes)) blockers.push(`research_evidence_capsule_file_hash_mismatch:${entry.path}`);
    if (sums.get(entry.path) !== entry.hash) blockers.push(`research_evidence_capsule_sha256sums_mismatch:${entry.path}`);
    if (/\.json$/i.test(entry.path)) {
      const document = parseResearchEvidenceCapsuleJson(read.content);
      if (!document) blockers.push(`research_evidence_capsule_json_invalid:${entry.path}`);
      else documents.set(entry.path, document);
    }
    if (/\.ndjson$/i.test(entry.path)) {
      try {
        const rows = read.content.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
        if (!rows.length) blockers.push(`research_evidence_capsule_raw_events_empty:${entry.path}`);
        rows.forEach((row) => blockers.push(...assertNoPrivateMaterial(row).map((item) => `research_evidence_capsule_publication_violation:${entry.path}:${item}`)));
      } catch { blockers.push(`research_evidence_capsule_ndjson_invalid:${entry.path}`); }
    }
  }
  for (const [relative, document] of documents) {
    blockers.push(...assertNoPrivateMaterial(document).map((item) => `research_evidence_capsule_publication_violation:${relative}:${item}`));
  }
  const report = documents.get('evidence/RESEARCH_REPORT.json');
  const registry = documents.get('evidence/EXPERIMENT_REGISTRY.json');
  const environment = documents.get('evidence/ENVIRONMENT_MANIFEST.json');
  const authority = documents.get('evidence/PUBLIC_AUTHORITY_EVIDENCE.json');
  const trustSnapshot = documents.get('evidence/PUBLIC_AUTHORITY_TRUST_SNAPSHOT.json');
  const executionAttestation = documents.get(RESEARCH_EXECUTION_RELEASE_ATTESTATION_PATH) || null;
  const gpuScientificVerification =
    verifyCampaignReleaseGpuScientificCapsuleDirectorySync({
      packageDir: root,
      manifest,
      documents,
      publicAuthorityTrustSnapshot: trustSnapshot,
      trustedAuthorityRoots: expected.trustedAuthorityRoots,
      verificationTime: manifest?.createdAt,
    });
  blockers.push(...gpuScientificVerification.blockers);
  const gpuScientificQualificationEvidence =
    gpuScientificVerification.qualificationEvidence;
  const gpuScientificArtifactBodyArchiveManifest =
    gpuScientificVerification.artifactArchiveManifest;
  const gpuScientificArtifactBodyArchiveVerification =
    gpuScientificVerification.artifactBodyArchiveVerification;
  const trustSnapshotVerification = verifyPublicAuthorityTrustSnapshot(trustSnapshot, { capturedAt: manifest?.createdAt });
  blockers.push(...trustSnapshotVerification.blockers.map((blocker) => `research_evidence_capsule:${blocker}`));
  if (report?.kind !== 'PortablePaperResearchVerifyReport'
    || report?.sourceResearchReportHash !== manifest?.researchReportHash
    || report?.redactionPolicy !== 'public-research-evidence-no-host-paths-no-private-authority-v1'
    || report?.document?.paperId !== manifest?.paperId
    || report?.document?.researchReportHash !== manifest?.researchReportHash
    || report?.document?.experimentRegistryHash !== manifest?.experimentRegistryHash) blockers.push('research_evidence_capsule_report_binding_invalid');
  if (!empiricalAssertionResearchReportValid(report?.document, {
    campaignId: manifest?.campaignId,
    registry: registry?.document,
    derivationEvidence: registry?.empiricalAssertionRegistryDerivationEvidence,
  })) {
    blockers.push('research_evidence_capsule_empirical_assertion_binding_invalid');
  }
  if (registry?.kind !== 'PortableExperimentRegistry'
    || registry?.sourceExperimentRegistryHash !== manifest?.experimentRegistryHash
    || registry?.redactionPolicy !== 'public-research-evidence-no-host-paths-no-private-authority-v1'
    || registry?.document?.paperId !== manifest?.paperId
    || registry?.document?.experimentRegistryHash !== manifest?.experimentRegistryHash) blockers.push('research_evidence_capsule_registry_binding_invalid');
  for (const document of [environment, authority]) {
    if (document?.campaignId !== manifest?.campaignId || document?.paperId !== manifest?.paperId
      || document?.researchReportHash !== manifest?.researchReportHash
      || document?.experimentRegistryHash !== manifest?.experimentRegistryHash) blockers.push('research_evidence_capsule_public_evidence_binding_invalid');
  }
  if (environment?.verifiedSourceMerkleHash !== manifest?.verifiedSourceMerkleHash
    || environment?.verifiedSourceWorkspaceManifestHash !== manifest?.verifiedSourceWorkspaceManifestHash
    || (environment?.experiments || []).length !== Number(manifest?.experimentCount)) blockers.push('research_evidence_capsule_environment_binding_invalid');
  if ((authority?.experiments || []).length !== Number(manifest?.experimentCount)
    || authority?.privateKeysIncluded !== false || authority?.hiddenOracleIncluded !== false
    || authority?.hostAbsolutePathsIncluded !== false
    || authority?.ledgerEvidenceAssurance !== 'structural-receipt-summaries-not-cryptographic-inclusion-proof-v1'
    || authority?.publicAuthorityTrustAssurance !== 'package-internal-public-key-disclosure-not-trust-anchor-v1'
    || authority?.sourceAuthenticityRequiresExternalTrustAnchor !== (
      Number(manifest?.experimentCount || 0) > 0
        || manifest?.gpuScientificEvidenceIncluded === true
    )
    || authority?.publicAuthorityTrustSnapshotHash !== manifest?.publicAuthorityTrustSnapshotHash
    || trustSnapshot?.publicAuthorityTrustSnapshotHash !== manifest?.publicAuthorityTrustSnapshotHash
    || trustSnapshot?.capturedAt !== manifest?.createdAt) blockers.push('research_evidence_capsule_authority_disclosure_invalid');
  if (!portableExperimentBindingsValid({ manifest, registry, environment, authority })) {
    blockers.push('research_evidence_capsule_experiment_public_lineage_invalid');
  }
  const verificationTime = expected.verificationTime || new Date();
  const executionAttestationVerification = manifest?.externalExecutionAttestationRequired
    ? verifyOfflineResearchExecutionReleaseAttestation({
      attestation: executionAttestation,
      manifest,
      manifestFileHash: manifestRead.hash,
      trustedReleaseRoots: expected.trustedReleaseRoots,
      verificationTime,
    })
    : null;
  if (executionAttestationVerification && !executionAttestationVerification.valid) {
    blockers.push(...executionAttestationVerification.blockers.map((blocker) => (
      `research_evidence_capsule_execution_attestation_invalid:${blocker}`
    )));
  }
  const offlineAuthorityVerifications = [];
  for (const experiment of authority?.experiments || []) {
    const verification = verifyOfflineOperatorDatasetAuthorityEvidence({
      evidence: experiment?.offlineOperatorDatasetAuthorityEvidence,
      trustSnapshot,
      trustedAuthorityRoots: expected.trustedAuthorityRoots,
      verificationTime,
    });
    offlineAuthorityVerifications.push(verification);
    if (!verification.valid) blockers.push(...verification.blockers.map((blocker) => (
      `research_evidence_capsule_offline_authority_invalid:${experiment?.experimentId || 'missing'}:${blocker}`
    )));
  }
  const uniqueBlockers = [...new Set(blockers)];
  const nonExternalAnchorBlockers = uniqueBlockers.filter((blocker) => (
    !blocker.includes('external_trust_anchor') && !blocker.includes('external_trust_root')
      && !blocker.startsWith('research_evidence_capsule_execution_attestation_invalid:')
  ));
  const hasAcademicEvidence = Number(manifest?.experimentCount || 0) > 0;
  const hasGpuScientificEvidence =
    manifest?.gpuScientificEvidenceIncluded === true;
  const hasExternallyAttestedEvidence = hasAcademicEvidence
    || hasGpuScientificEvidence;
  const academicInternalAuthorityVerified = !hasAcademicEvidence
    || (offlineAuthorityVerifications.length
      === Number(manifest?.experimentCount || 0)
      && offlineAuthorityVerifications.every((verification) => (
        verification.packageInternalCryptographicConsistencyVerified === true
      )));
  const academicExternalAuthorityVerified = !hasAcademicEvidence
    || (offlineAuthorityVerifications.length
      === Number(manifest?.experimentCount || 0)
      && offlineAuthorityVerifications.every((verification) => (
        verification.externalTrustAnchorVerified === true
      )));
  const externalManifestAuthorityVerified =
    executionAttestationVerification
      ?.capsuleManifestExternalSignatureVerified === true;
  const gpuInternalAuthorityVerified = !hasGpuScientificEvidence
    || gpuScientificVerification.qualificationAuthorityInspection?.valid
      === true;
  const gpuExternalAuthorityVerified = !hasGpuScientificEvidence
    || gpuScientificVerification.externalAuthorityTrustVerification
      ?.externalTrustAnchorVerified === true;
  return Object.freeze({
    version: manifest?.version || 2,
    kind: 'CampaignReleaseResearchEvidenceCapsuleVerification',
    status: blockers.length ? 'research_evidence_capsule_verification_blocked' : 'research_evidence_capsule_verification_passed',
    valid: uniqueBlockers.length === 0,
    researchEvidenceCapsuleManifestHash: manifest?.researchEvidenceCapsuleManifestHash || null,
    publicAuthorityTrustSnapshotHash: manifest?.publicAuthorityTrustSnapshotHash || null,
    packageInternalCryptographicConsistencyVerified:
      hasExternallyAttestedEvidence
      && nonExternalAnchorBlockers.length === 0
      && academicInternalAuthorityVerified
      && gpuInternalAuthorityVerified
      && (!hasGpuScientificEvidence
        || gpuScientificArtifactBodyArchiveVerification?.valid === true),
    externalAuthorityTrustAnchorVerified: hasExternallyAttestedEvidence
      && academicExternalAuthorityVerified
      && gpuExternalAuthorityVerified
      && externalManifestAuthorityVerified,
    offlineCryptographicAuthorityVerified: uniqueBlockers.length === 0
      && hasExternallyAttestedEvidence,
    capsuleManifestExternalSignatureVerified: hasExternallyAttestedEvidence
      ? externalManifestAuthorityVerified : false,
    recordedExecutionLineageExternallyAttested: hasExternallyAttestedEvidence
      ? executionAttestationVerification?.recordedExecutionLineageExternallyAttested === true : false,
    executionAuthenticityExternallyAttested: false,
    ledgerEvidenceAssurance: 'structural-receipt-summaries-not-cryptographic-inclusion-proof-v1',
    verifiedFileCount: expectedFiles.length,
    gpuScientificEvidenceIncluded: hasGpuScientificEvidence,
    gpuScientificArtifactBodyArchiveManifestHash:
      gpuScientificArtifactBodyArchiveManifest
        ?.gpuScientificArtifactBodyArchiveManifestHash || null,
    gpuScientificCampaignQualificationEvidenceHash:
      gpuScientificQualificationEvidence
        ?.gpuScientificCampaignQualificationEvidenceHash || null,
    gpuScientificArtifactBodyArchiveVerified:
      hasGpuScientificEvidence
        && gpuScientificArtifactBodyArchiveVerification?.valid === true,
    blockers: Object.freeze(uniqueBlockers),
  });
}
