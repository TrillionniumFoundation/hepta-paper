import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyEmpiricalEnvironmentBom } from './environment-bom-contract.mjs';
import { EXPERIMENT_REPLAY_ASSURANCE_SCOPE } from './experiment-environment-bom-binding.mjs';
import { campaignReleaseExecutionAttestationDocumentFileHash } from './campaign-release-execution-attestation-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\/-]{1,512}$/;
const RECOMPUTATION_INDEPENDENCE_LEVEL = 'repository-separate-implementation-same-process-v1';

export const CAMPAIGN_RELEASE_CAPSULE_BASE_ROLES = Object.freeze([
  'portable_research_report',
  'portable_experiment_registry',
  'research_environment_manifest',
  'research_public_authority_evidence',
  'public_authority_trust_snapshot',
]);

export const CAMPAIGN_RELEASE_CAPSULE_EXECUTION_ROLES = Object.freeze([
  'experiment_results_json',
  'experiment_results_csv',
  'experiment_raw_events',
]);

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || '')).filter(Boolean))];
}

function recordPayload(record, hashField) {
  if (!record || typeof record !== 'object') return null;
  const { [hashField]: _claimedHash, ...payload } = record;
  return payload;
}

function validEntry(entry) {
  return Boolean(entry && typeof entry === 'object'
    && SAFE_RELATIVE_PATH.test(String(entry.path || ''))
    && !String(entry.path).split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('-'))
    && String(entry.path).startsWith('evidence/')
    && String(entry.role || '')
    && SHA256.test(String(entry.hash || ''))
    && Number.isSafeInteger(Number(entry.bytes))
    && Number(entry.bytes) >= 0
    && Number(entry.bytes) <= 256 * 1024 * 1024
    && ['base', 'original', 'independent-replay'].includes(String(entry.executionRole || 'base'))
    && (entry.executionRole === 'base' ? !entry.experimentId : Boolean(entry.experimentId)));
}

function executionDescriptorValid(descriptor) {
  return Boolean(descriptor && typeof descriptor === 'object'
    && ['original', 'independent-replay'].includes(descriptor.executionRole)
    && SHA256.test(String(descriptor.experimentRunReceiptHash || ''))
    && SHA256.test(String(descriptor.executionReceiptHash || ''))
    && SHA256.test(String(descriptor.runtimeIdentityHash || ''))
    && SHA256.test(String(descriptor.environmentBindingHash || ''))
    && SHA256.test(String(descriptor.environmentBomHash || ''))
    && SHA256.test(String(descriptor.resultJsonHash || ''))
    && SHA256.test(String(descriptor.resultCsvHash || ''))
    && SHA256.test(String(descriptor.rawEventArtifactHash || ''))
    && Number.isSafeInteger(Number(descriptor.rawEventArtifactBytes))
    && Number(descriptor.rawEventArtifactBytes) > 0
    && SHA256.test(String(descriptor.rawArtifactWriteReceiptHash || ''))
    && String(descriptor.rawArtifactLedgerReceiptId || '').startsWith('artifact-writes:')
    && String(descriptor.experimentAttemptId || ''));
}

function experimentDescriptorValid(experiment) {
  if (!experiment || typeof experiment !== 'object' || !String(experiment.experimentId || '')
    || !SHA256.test(String(experiment.experimentEvidenceBindingHash || ''))
    || !SHA256.test(String(experiment.experimentReplayReceiptHash || ''))
    || !SHA256.test(String(experiment.sourceLineageHash || ''))
    || !SHA256.test(String(experiment.analysisProtocolHash || ''))
    || !SHA256.test(String(experiment.originalAnalysisEvaluationHash || ''))
    || !SHA256.test(String(experiment.replayAnalysisEvaluationHash || ''))
    || !SHA256.test(String(experiment.analysisProtocolReplayBindingHash || ''))
    || !SHA256.test(String(experiment.originalEnvironmentBomHash || ''))
    || !SHA256.test(String(experiment.replayEnvironmentBomHash || ''))
    || experiment.replayAssuranceScope !== EXPERIMENT_REPLAY_ASSURANCE_SCOPE
    || experiment.independentRecomputationImplementationVerified !== true
    || experiment.recomputationIndependenceLevel !== RECOMPUTATION_INDEPENDENCE_LEVEL
    || !SHA256.test(String(experiment.rawEventRecomputationIndependenceContractHash || ''))
    || experiment.recomputationProcessIndependent !== false
    || !Array.isArray(experiment.executions) || experiment.executions.length !== 2
    || !experiment.executions.every(executionDescriptorValid)) return false;
  const roles = experiment.executions.map((item) => item.executionRole).sort();
  const original = experiment.executions.find((item) => item.executionRole === 'original');
  const replay = experiment.executions.find((item) => item.executionRole === 'independent-replay');
  return JSON.stringify(roles) === JSON.stringify(['independent-replay', 'original'])
    && original?.environmentBomHash === experiment.originalEnvironmentBomHash
    && replay?.environmentBomHash === experiment.replayEnvironmentBomHash
    && experiment.executions[0].experimentRunReceiptHash !== experiment.executions[1].experimentRunReceiptHash
    && experiment.executions[0].executionReceiptHash !== experiment.executions[1].executionReceiptHash
    && experiment.executions[0].experimentAttemptId !== experiment.executions[1].experimentAttemptId;
}

export function verifyCampaignReleasePortableEnvironmentBindings({
  manifest,
  registry,
  environment,
  authority,
} = {}) {
  const blockers = [];
  const manifestExperiments = Array.isArray(manifest?.experiments) ? manifest.experiments : [];
  const expectedBomCount = manifestExperiments.length * 2;
  const expectedDisclosure = manifestExperiments.length
    ? 'hash-bound-observed-environment-bom-no-independent-hardware-replication-claim-v1'
    : 'no-academic-experiment-environment-bom-v1';
  if (environment?.version !== 2 || environment?.kind !== 'CampaignReleaseResearchEnvironmentManifest'
    || environment?.environmentBomEvidenceIncluded !== (manifestExperiments.length > 0)
    || Number(environment?.environmentBomCount) !== expectedBomCount
    || environment?.hardwareDisclosure !== expectedDisclosure) blockers.push('release_environment_bom_manifest_invalid');
  const registryExperiments = new Map((registry?.document?.experiments || []).map((item) => [item?.experimentId, item]));
  const environmentExperiments = new Map((environment?.experiments || []).map((item) => [item?.experimentId, item]));
  const authorityExperiments = new Map((authority?.experiments || []).map((item) => [item?.experimentId, item]));
  for (const experiment of manifestExperiments) {
    const registered = registryExperiments.get(experiment.experimentId);
    const runtime = environmentExperiments.get(experiment.experimentId);
    const publicAuthority = authorityExperiments.get(experiment.experimentId);
    if (registered?.evidenceBinding?.originalEnvironmentBomHash !== experiment.originalEnvironmentBomHash
      || registered?.evidenceBinding?.replayEnvironmentBomHash !== experiment.replayEnvironmentBomHash
      || registered?.evidenceBinding?.replayAssuranceScope !== EXPERIMENT_REPLAY_ASSURANCE_SCOPE
      || runtime?.originalEnvironmentBomHash !== experiment.originalEnvironmentBomHash
      || runtime?.replayEnvironmentBomHash !== experiment.replayEnvironmentBomHash
      || runtime?.replayAssuranceScope !== EXPERIMENT_REPLAY_ASSURANCE_SCOPE
      || publicAuthority?.originalEnvironmentBomHash !== experiment.originalEnvironmentBomHash
      || publicAuthority?.replayEnvironmentBomHash !== experiment.replayEnvironmentBomHash
      || publicAuthority?.replayAssuranceScope !== EXPERIMENT_REPLAY_ASSURANCE_SCOPE) {
      blockers.push(`release_environment_bom_experiment_binding_invalid:${experiment.experimentId}`);
      continue;
    }
    const runtimeExecutions = new Map((runtime.executions || []).map((item) => [item?.executionRole, item]));
    for (const execution of experiment.executions || []) {
      const runtimeExecution = runtimeExecutions.get(execution.executionRole);
      const verification = verifyEmpiricalEnvironmentBom(runtimeExecution?.environmentBom);
      const expectedHash = execution.executionRole === 'original'
        ? experiment.originalEnvironmentBomHash : experiment.replayEnvironmentBomHash;
      if (!verification.valid || runtimeExecution?.environmentBom?.environmentBomHash !== expectedHash
        || runtimeExecution?.environmentBomHash !== expectedHash
        || execution.environmentBomHash !== expectedHash) {
        blockers.push(`release_environment_bom_execution_binding_invalid:${experiment.experimentId}:${execution.executionRole}`);
      }
    }
  }
  if (environmentExperiments.size !== manifestExperiments.length
    || authorityExperiments.size !== manifestExperiments.length) blockers.push('release_environment_bom_experiment_set_invalid');
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze(uniqueStrings(blockers)) });
}

function expectedEntryKeys(manifest) {
  const expected = new Set(CAMPAIGN_RELEASE_CAPSULE_BASE_ROLES.map((role) => `base\0\0${role}`));
  for (const experiment of manifest.experiments || []) {
    for (const execution of experiment.executions || []) {
      for (const role of CAMPAIGN_RELEASE_CAPSULE_EXECUTION_ROLES) {
        expected.add(`${execution.executionRole}\0${experiment.experimentId}\0${role}`);
      }
    }
  }
  return expected;
}

function entryKey(entry) {
  return `${entry.executionRole || 'base'}\0${entry.experimentId || ''}\0${entry.role || ''}`;
}

function exactEntrySetValid(manifest) {
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  const expected = expectedEntryKeys(manifest || {});
  const actual = entries.map(entryKey);
  return entries.length === expected.size
    && new Set(actual).size === actual.length
    && actual.every((key) => expected.has(key))
    && [...expected].every((key) => actual.includes(key));
}

function executionEntriesMatch(manifest) {
  const entries = new Map((manifest.entries || []).map((entry) => [entryKey(entry), entry]));
  for (const experiment of manifest.experiments || []) {
    for (const execution of experiment.executions || []) {
      const prefix = `${execution.executionRole}\0${experiment.experimentId}\0`;
      if (entries.get(`${prefix}experiment_results_json`)?.hash !== execution.resultJsonHash
        || entries.get(`${prefix}experiment_results_csv`)?.hash !== execution.resultCsvHash
        || entries.get(`${prefix}experiment_raw_events`)?.hash !== execution.rawEventArtifactHash
        || Number(entries.get(`${prefix}experiment_raw_events`)?.bytes) !== Number(execution.rawEventArtifactBytes)) return false;
    }
  }
  return true;
}

export function buildCampaignReleaseEvidenceCapsuleManifest({
  campaignId,
  paperId,
  researchReportHash,
  experimentRegistryHash,
  campaignResearchSourceSnapshotHash = null,
  verifiedSourceMerkleHash,
  verifiedSourceWorkspaceManifestHash,
  researchVerifyNodeId,
  researchVerifyAttemptId,
  researchVerifyLeaseGeneration,
  publicAuthorityTrustSnapshotHash,
  experiments = [],
  entries = [],
  createdAt,
} = {}) {
  const normalizedExperiments = experiments.map((experiment) => Object.freeze({
    ...experiment,
    executions: Object.freeze((experiment.executions || []).map((execution) => Object.freeze({ ...execution }))
      .sort((left, right) => left.executionRole.localeCompare(right.executionRole))),
  })).sort((left, right) => left.experimentId.localeCompare(right.experimentId));
  const normalizedEntries = entries.map((entry) => Object.freeze({
    role: String(entry.role || ''),
    path: String(entry.path || '').replace(/\\/g, '/'),
    hash: String(entry.hash || '').toLowerCase(),
    bytes: Number(entry.bytes),
    executionRole: String(entry.executionRole || 'base'),
    experimentId: entry.experimentId ? String(entry.experimentId) : null,
  })).sort((left, right) => entryKey(left).localeCompare(entryKey(right)));
  const payload = {
    version: 2,
    kind: 'CampaignReleaseResearchEvidenceCapsuleManifest',
    status: 'research_evidence_capsule_ready',
    campaignId: String(campaignId || ''),
    paperId: String(paperId || ''),
    researchReportHash: String(researchReportHash || ''),
    experimentRegistryHash: String(experimentRegistryHash || ''),
    campaignResearchSourceSnapshotHash: campaignResearchSourceSnapshotHash || null,
    verifiedSourceMerkleHash: String(verifiedSourceMerkleHash || ''),
    verifiedSourceWorkspaceManifestHash: String(verifiedSourceWorkspaceManifestHash || ''),
    researchVerifyNodeId: String(researchVerifyNodeId || ''),
    researchVerifyAttemptId: String(researchVerifyAttemptId || ''),
    researchVerifyLeaseGeneration: Number(researchVerifyLeaseGeneration),
    publicAuthorityTrustSnapshotHash: String(publicAuthorityTrustSnapshotHash || ''),
    empiricalEvidenceIncluded: normalizedExperiments.length > 0,
    externalAuthorityTrustAnchorRequired: normalizedExperiments.length > 0,
    externalExecutionAttestationRequired: normalizedExperiments.length > 0,
    academicExperimentCount: normalizedExperiments.filter((item) => item.academicPromotionEligible === true).length,
    experimentCount: normalizedExperiments.length,
    experiments: Object.freeze(normalizedExperiments),
    entryCount: normalizedEntries.length,
    entries: Object.freeze(normalizedEntries),
    redactionPolicy: 'public-research-evidence-no-host-paths-no-private-authority-v1',
    createdAt: String(createdAt || ''),
    externalActionPerformed: false,
  };
  const manifest = Object.freeze({
    ...payload,
    researchEvidenceCapsuleManifestHash: hashRecord('CampaignReleaseResearchEvidenceCapsuleManifest', payload),
  });
  const verification = verifyCampaignReleaseEvidenceCapsuleManifest(manifest);
  if (!verification.valid) throw new Error(`campaign_release_evidence_capsule_manifest_invalid:${verification.blockers.join(',')}`);
  return manifest;
}

export function verifyCampaignReleaseEvidenceCapsuleManifest(manifest, expected = {}) {
  const blockers = [];
  const payload = recordPayload(manifest, 'researchEvidenceCapsuleManifestHash');
  if (manifest?.version !== 2 || manifest?.kind !== 'CampaignReleaseResearchEvidenceCapsuleManifest'
    || manifest?.status !== 'research_evidence_capsule_ready') blockers.push('research_evidence_capsule_shape_invalid');
  if (!payload || !SHA256.test(String(manifest?.researchEvidenceCapsuleManifestHash || ''))
    || hashRecord('CampaignReleaseResearchEvidenceCapsuleManifest', payload) !== manifest?.researchEvidenceCapsuleManifestHash) {
    blockers.push('research_evidence_capsule_manifest_hash_invalid');
  }
  for (const field of ['campaignId', 'paperId', 'researchReportHash', 'experimentRegistryHash', 'verifiedSourceMerkleHash',
    'verifiedSourceWorkspaceManifestHash', 'researchVerifyNodeId', 'researchVerifyAttemptId']) {
    if (!String(manifest?.[field] || '')) blockers.push(`research_evidence_capsule_${field}_required`);
    if (expected[field] && manifest?.[field] !== expected[field]) blockers.push(`research_evidence_capsule_${field}_mismatch`);
  }
  if (![manifest?.researchReportHash, manifest?.experimentRegistryHash, manifest?.verifiedSourceMerkleHash,
    manifest?.verifiedSourceWorkspaceManifestHash, manifest?.publicAuthorityTrustSnapshotHash]
    .every((value) => SHA256.test(String(value || '')))) {
    blockers.push('research_evidence_capsule_lineage_hash_invalid');
  }
  if (expected.campaignResearchSourceSnapshotHash
    && manifest?.campaignResearchSourceSnapshotHash !== expected.campaignResearchSourceSnapshotHash) {
    blockers.push('research_evidence_capsule_campaign_source_snapshot_mismatch');
  }
  if (!Number.isSafeInteger(Number(manifest?.researchVerifyLeaseGeneration))
    || Number(manifest.researchVerifyLeaseGeneration) < 1
    || (expected.researchVerifyLeaseGeneration
      && Number(manifest.researchVerifyLeaseGeneration) !== Number(expected.researchVerifyLeaseGeneration))) {
    blockers.push('research_evidence_capsule_research_lease_invalid');
  }
  if (!Number.isFinite(Date.parse(String(manifest?.createdAt || '')))) blockers.push('research_evidence_capsule_created_at_invalid');
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  const experiments = Array.isArray(manifest?.experiments) ? manifest.experiments : [];
  if (entries.length !== Number(manifest?.entryCount) || !entries.every(validEntry)
    || new Set(entries.map((entry) => entry.path)).size !== entries.length) blockers.push('research_evidence_capsule_entries_invalid');
  if (experiments.length !== Number(manifest?.experimentCount)
    || new Set(experiments.map((item) => item?.experimentId)).size !== experiments.length
    || !experiments.every(experimentDescriptorValid)) blockers.push('research_evidence_capsule_experiments_invalid');
  if (manifest?.empiricalEvidenceIncluded !== (experiments.length > 0)
    || manifest?.externalAuthorityTrustAnchorRequired !== (experiments.length > 0)
    || manifest?.externalExecutionAttestationRequired !== (experiments.length > 0)
    || Number(manifest?.academicExperimentCount) !== experiments.filter((item) => item?.academicPromotionEligible === true).length) {
    blockers.push('research_evidence_capsule_experiment_summary_invalid');
  }
  if (!exactEntrySetValid(manifest) || !executionEntriesMatch(manifest)) blockers.push('research_evidence_capsule_exact_role_binding_invalid');
  if (expected.academicEvidenceRequired === true
    && (Number(manifest?.academicExperimentCount) < 1
      || experiments.some((experiment) => experiment.academicPromotionEligible !== true))) {
    blockers.push('research_evidence_capsule_academic_evidence_required');
  }
  if (manifest?.redactionPolicy !== 'public-research-evidence-no-host-paths-no-private-authority-v1'
    || manifest?.externalActionPerformed !== false) blockers.push('research_evidence_capsule_publication_policy_invalid');
  return Object.freeze({ valid: blockers.length === 0, blockers: uniqueStrings(blockers) });
}

export function verifyCampaignReleaseEvidenceCapsulePackageOutput({ packageOutput, manifest, executionAttestation = null } = {}) {
  const verification = verifyCampaignReleaseEvidenceCapsuleManifest(manifest, {
    campaignId: manifest?.campaignId,
    paperId: manifest?.paperId,
    researchReportHash: manifest?.researchReportHash,
    experimentRegistryHash: manifest?.experimentRegistryHash,
  });
  if (!verification.valid
    || packageOutput?.researchEvidenceCapsuleManifestHash !== manifest?.researchEvidenceCapsuleManifestHash) return false;
  const files = Array.isArray(packageOutput?.files) ? packageOutput.files : [];
  const manifestFile = files.filter((item) => item?.role === 'research_evidence_capsule_manifest');
  const capsuleFiles = files.filter((item) => item?.role === 'research_evidence_capsule_file');
  const attestationFiles = files.filter((item) => item?.role === 'research_execution_release_attestation');
  if (manifestFile.length !== 1 || manifestFile[0].capsuleRole !== 'research_evidence_capsule_manifest'
    || manifestFile[0].packageRelativePath !== 'evidence/CAPSULE_MANIFEST.json'
    || manifestFile[0].hash !== packageOutput?.researchEvidenceCapsuleManifestFileHash
    || capsuleFiles.length !== manifest.entries.length
    || attestationFiles.length !== (manifest.externalExecutionAttestationRequired ? 1 : 0)) return false;
  if (manifest.externalExecutionAttestationRequired
    && (attestationFiles[0]?.capsuleRole !== 'research_execution_release_attestation'
      || attestationFiles[0]?.packageRelativePath !== 'evidence/CAPSULE_MANIFEST.external-attestation.json'
      || attestationFiles[0]?.hash !== packageOutput?.researchExecutionReleaseAttestationFileHash
      || executionAttestation?.campaignReleaseExecutionAttestationHash
        !== packageOutput?.researchExecutionReleaseAttestationHash
      || campaignReleaseExecutionAttestationDocumentFileHash(executionAttestation)
        !== attestationFiles[0]?.hash)) return false;
  const byPath = new Map(capsuleFiles.map((item) => [item.packageRelativePath, item]));
  return manifest.entries.every((entry) => {
    const output = byPath.get(entry.path);
    return output?.capsuleRole === entry.role
      && output?.executionRole === entry.executionRole
      && (output?.experimentId || null) === (entry.experimentId || null)
      && output?.hash === entry.hash
      && Number(output?.bytes) === Number(entry.bytes);
  });
}
