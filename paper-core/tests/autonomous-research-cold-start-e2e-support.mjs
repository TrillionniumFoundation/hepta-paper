import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  preflightAutonomousEmpiricalRuntimes,
} from '../../paper-adapters/automation/autonomous-empirical-runtime-preflight.mjs';
import { AUTOMATION_RUNTIME_IMAGES } from '../../paper-adapters/automation/runtime-image-registry.mjs';
import { createRandomIdGenerator } from '../../paper-adapters/runtime/random-id-generator.mjs';
import { createSystemScheduler } from '../../paper-adapters/runtime/system-scheduler.mjs';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import {
  buildCampaignBenchmarkSelector,
} from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import {
  buildCanonicalAnalysisProtocol,
} from '../../paper-domain/automation/analysis-protocol-contract.mjs';
import {
  validateOperatorDatasetAuthorityDocument,
} from '../../paper-domain/automation/operator-dataset-harness-contract.mjs';
import {
  productionSignedReviewerReviewFixture,
} from './support/autonomous-research-generalization-fixture.mjs';

export const H = (label) => hashRecord('AutonomousCampaignTestHash', { label });

function empiricalRuntimeCapabilityInspection({ wrongDigestLanguage = null } = {}) {
  return preflightAutonomousEmpiricalRuntimes({
    spawnSyncImpl(_command, args) {
      const [language, runtime] = Object.entries({
        python: AUTOMATION_RUNTIME_IMAGES.python,
        r: AUTOMATION_RUNTIME_IMAGES.r,
      }).find(([, candidate]) => candidate.image === args[2]) || [];
      return {
        status: runtime ? 0 : 1,
        stdout: runtime ? JSON.stringify([{
          Id: `sha256:${'f'.repeat(64)}`,
          Descriptor: {
            digest: language === wrongDigestLanguage
              ? `sha256:${'0'.repeat(64)}` : runtime.imageDigest,
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
          },
          Os: 'linux',
          Architecture: 'amd64',
        }]) : '',
      };
    },
  });
}

export const READY_EMPIRICAL_RUNTIME_CAPABILITY_INSPECTION =
  empiricalRuntimeCapabilityInspection();

export function qualificationServiceIdentities(label) {
  const configurationIdentityHash = H(`${label}:configuration`);
  const trustIdentityHash = H(`${label}:trust`);
  return Object.freeze({
    client: Object.freeze({
      configurationIdentityHash,
      trustIdentityHash,
      serviceIdentityHash: H(`${label}:client-service`),
      maximumQualificationCostUsd: 0,
      qualificationCostAuthority: 'externally_operated_zero_cost',
    }),
    verifier: Object.freeze({
      configurationIdentityHash,
      trustIdentityHash,
      serviceIdentityHash: H(`${label}:verifier-service`),
      maximumQualificationCostUsd: 0,
      qualificationCostAuthority: 'externally_operated_zero_cost',
    }),
  });
}

function hashed(kind, hashField, payload) {
  return Object.freeze({ ...payload, [hashField]: hashRecord(kind, payload) });
}

export function principals() {
  const authorCapability = hashed('CodexResearchAuthorCapabilityReceipt',
    'codexResearchAuthorCapabilityReceiptHash', {
      version: 1, kind: 'CodexResearchAuthorCapabilityReceipt',
      status: 'codex_research_author_capability_ready', provider: 'openai', model: 'author',
      credentialRootIdentityHash: H('author-root'), credentialConfigIdentityHash: H('author-config'),
      freshEphemeralSessionRequired: true, priorAgentContextInheritanceForbidden: true,
    });
  const reviewerCapability = hashed('CodexFormalReviewerCapabilityReceipt',
    'codexFormalReviewerCapabilityReceiptHash', {
      version: 1, kind: 'CodexFormalReviewerCapabilityReceipt',
      status: 'codex_formal_reviewer_capability_ready', provider: 'openai', model: 'reviewer',
      credentialRootIdentityHash: H('reviewer-root'), credentialConfigIdentityHash: H('reviewer-config'),
      authorCredentialRootIdentityHash: authorCapability.credentialRootIdentityHash,
      credentialIndependenceVerified: true,
      providerCredentialSharingPermitted: true, freshEphemeralSessionRequired: true,
      authorContextInheritanceForbidden: true, frozenArtifactReviewRequired: true,
      reviewerMustDifferFromAuthorPrincipal: true,
      assuranceScope: 'ephemeral_session_frozen_artifact_and_role_separation',
    });
  return {
    authorPrincipal: { principalId: 'author:test', capabilityReceipt: authorCapability },
    formalReviewerPrincipal: { principalId: 'reviewer:test', capabilityReceipt: reviewerCapability },
  };
}

export function trustedDatasetAuthorityReceipt(mount) {
  const authorityVerification = Object.freeze({
    status: 'operator_dataset_authority_verified',
    cryptographicSignaturesVerified: true,
    verifiedSignatures: Object.freeze([{ keyId: 'dataset-key:test' }]),
    verifiedRoles: Object.freeze(['dataset_harness_operator']),
    verifiedSubjectIds: Object.freeze(['dataset-operator:test']),
    timeWindowValid: true,
    signedAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
  });
  const payload = {
    version: 3,
    kind: 'OperatorDatasetHarnessAuthorityReceipt',
    status: 'operator_dataset_harness_authority_verified',
    datasetName: mount.name,
    datasetManifestHash: mount.manifestHash,
    operatorDatasetAuthorityDocumentHash: mount.operatorDatasetAuthorityDocumentHash,
    analysisProtocolHash: mount.analysisProtocolHash,
    benchmarkFamily: mount.benchmarkFamily,
    operatorDatasetAuthorityVerificationHash:
      hashRecord('OperatorDatasetAuthorityVerification', authorityVerification),
    authorityVerification,
    blockers: Object.freeze([]),
  };
  return Object.freeze({
    ...payload,
    operatorDatasetHarnessAuthorityReceiptHash:
      hashRecord('OperatorDatasetHarnessAuthorityReceipt', payload),
  });
}

export function authorizedDatasetMount(base, name = 'autonomous-dataset') {
  const source = path.join(base, name);
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'dataset.json'), '{}\n');
  const benchmarkFamily = 'ml_algorithm_benchmark';
  const repositoryDesign = buildCampaignBenchmarkSelector({ benchmarkId: benchmarkFamily })
    .experimentDesign;
  const builtProtocol = buildCanonicalAnalysisProtocol({
    benchmarkId: name,
    benchmarkFamily,
    requiredMetrics: repositoryDesign.requiredMetrics,
    metricSpecs: repositoryDesign.metricSpecs,
  });
  const { analysisProtocolHash, ...analysisProtocol } = builtProtocol;
  const datasetManifestHash = H(`dataset-manifest:${name}`);
  const splitManifestHash = H(`dataset-split:${name}`);
  const benchmarkHarnessDefinitionHash = H(`dataset-harness:${name}`);
  const signed = signAuthorityDocument({
    version: 2,
    kind: 'OperatorDatasetHarnessAuthority',
    datasetName: name,
    datasetManifestHash,
    datasetLicenseId: 'CC-BY-4.0',
    datasetSplitManifestHash: splitManifestHash,
    benchmarkHarnessDefinitionHash,
    analysisProtocolHash,
    benchmarkFamily,
    seedSchedule: [17, 23, 31, 43, 59],
    minimumRepetitions: 7,
    workerExposurePolicy: 'signed-complete-dataset-file-manifest-v1',
    signedAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
  }, {
    privateKeyPem: crypto.generateKeyPairSync('ed25519').privateKey
      .export({ type: 'pkcs8', format: 'pem' }),
    keyId: `dataset-key:${name}`,
    role: 'dataset_harness_operator',
  });
  const validated = validateOperatorDatasetAuthorityDocument(signed);
  return Object.freeze({
    name,
    source,
    readOnly: true,
    manifestHash: datasetManifestHash,
    licenseId: 'CC-BY-4.0',
    operatorAuthorizationHash: validated.operatorDatasetAuthorityDocumentHash,
    operatorDatasetAuthorityDocumentHash: validated.operatorDatasetAuthorityDocumentHash,
    operatorDatasetAuthority: validated.authority,
    splitManifestHash,
    benchmarkHarnessDocumentHash: H(`dataset-document:${name}`),
    benchmarkHarnessDefinitionHash,
    analysisProtocol,
    analysisProtocolHash,
    benchmarkFamily,
    benchmarkSeedSchedule: [17, 23, 31, 43, 59],
    benchmarkMinimumRepetitions: 7,
  });
}

export function fakeExecutor({ failWriterOnce = false, forbidden = false } = {}) {
  const calls = [];
  let writerFailed = false;
  return {
    calls,
    executor: {
      verifySignedReviewerReceipt() { return true; },
      async execute({ campaign, node }) {
        if (forbidden) throw new Error('completed_campaign_reexecuted');
        calls.push(node.kind);
        if (failWriterOnce && node.kind === 'writer' && !writerFailed) {
          writerFailed = true;
          const error = new Error('transient_fake_author_failure');
          error.retryable = true;
          throw error;
        }
        if (/^(?:revision-)?referee-\d+$/.test(node.kind)) {
          const reviewerOrdinal = Number(node.kind.match(/referee-(\d+)$/)?.[1] || 1);
          return productionSignedReviewerReviewFixture({
            campaignId: campaign.campaignId,
            campaignPlanHash: campaign.spec.campaignPlanHash,
            paperId: campaign.paperId,
            manuscriptHash: H(`manuscript:${node.roundIndex}`),
            runtimePrincipalBinding:
              campaign.spec.autonomousResearchPreparation.runtimePrincipalBinding,
            reviewerOrdinal,
            nodeId: node.nodeId,
            reviewAttemptId: node.attemptId,
            roundIndex: node.roundIndex,
          });
        }
        return {
          version: 1,
          kind: 'FakeAutonomousNodeReceipt',
          status: 'fake_autonomous_node_completed',
          nodeKind: node.kind,
          ...(node.kind === 'convergence' ? {
            qualityGates: [],
            thresholds: {},
          } : {}),
          externalActionPerformed: false,
        };
      },
    },
  };
}

export function runtime(clock) {
  return {
    concurrency: 1,
    pollMs: 1,
    clock,
    scheduler: createSystemScheduler(),
    idGenerator: createRandomIdGenerator(),
  };
}

export function verifiedQualificationInspection({ campaignId, prepared, authority, label }) {
  const releaseBinding = authority.releaseBundle.autonomousResearchReleaseBinding;
  return {
    kind: 'FullResearchQualificationInspection',
    status: 'full_research_qualification_verified',
    ready: true,
    receiptAccepted: true,
    campaignId,
    paperId: prepared.proposal.paperId,
    campaignReleaseBundleHash: authority.campaignReleaseBundleHash,
    qualificationReceiptHash: H(`${label}:receipt`),
    qualificationSignatureVerified: true,
    qualificationTimeWindowVerified: true,
    releasePointerVerified: true,
    independentVerifierVerified: true,
    externalVerificationRequestHash: H(`${label}:verification`),
    proposalHash: prepared.proposal.machineProposedScientificClaimSetHash,
    policyAuthorizationHash:
      prepared.policyAuthorization.autonomousResearchPolicyAuthorizationHash,
    seedBindingHash: prepared.seedBinding.autonomousResearchSeedBindingHash,
    qualificationScope: releaseBinding.qualificationScope,
    genericContentCanaryVerified: releaseBinding.genericContentCanaryVerified,
    fullDomainVerificationReady: true,
    independentHypothesisPriorArtReviewVerified: true,
    independentHypothesisPriorArtReceiptHash: H(`${label}:prior-art`),
    failureCodes: [],
    blockers: [],
  };
}
