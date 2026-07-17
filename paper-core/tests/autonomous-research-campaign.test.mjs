import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { prepareAutonomousResearchLoop } from '../../paper-application/automation/autonomous-research-readiness.mjs';
import {
  buildAutonomousResearchCampaignPlan,
  executeAutonomousResearchCampaign,
} from '../../paper-application/automation/autonomous-research-campaign.mjs';
import { createAutonomousResearchWorkspaceRepository } from '../../paper-adapters/automation/autonomous-research-workspace-repository.mjs';
import { createAutonomousResearchQualificationStateRepository } from '../../paper-adapters/automation/autonomous-research-qualification-state-repository.mjs';
import { materializeAutonomousResearchWorkspace } from '../../paper-adapters/automation/autonomous-research-workspace-materializer.mjs';
import { preflightAutonomousEmpiricalRuntimes } from '../../paper-adapters/automation/autonomous-empirical-runtime-preflight.mjs';
import { AUTOMATION_RUNTIME_IMAGES } from '../../paper-adapters/automation/runtime-image-registry.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { createSystemScheduler } from '../../paper-adapters/runtime/system-scheduler.mjs';
import { createRandomIdGenerator } from '../../paper-adapters/runtime/random-id-generator.mjs';
import { createAutonomousResearchReleaseBinding } from '../../paper-domain/automation/autonomous-research-release-binding-contract.mjs';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import { buildCanonicalAnalysisProtocol } from '../../paper-domain/automation/analysis-protocol-contract.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { validateOperatorDatasetAuthorityDocument } from '../../paper-domain/automation/operator-dataset-harness-contract.mjs';
import { readEmpiricalClaimUniverse } from '../../paper-adapters/research-verify/empirical-claim-universe-reader.mjs';
import { renderAutonomousEmpiricalClaimStatement } from '../../paper-domain/automation/autonomous-empirical-claim-lineage-contract.mjs';

const H = (label) => hashRecord('AutonomousCampaignTestHash', { label });

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

const READY_EMPIRICAL_RUNTIME_CAPABILITY_INSPECTION =
  empiricalRuntimeCapabilityInspection();
const R_DIGEST_MISMATCH_RUNTIME_CAPABILITY_INSPECTION =
  empiricalRuntimeCapabilityInspection({ wrongDigestLanguage: 'r' });

function memoryQualificationStateStore({ read, write }) {
  return Object.freeze({
    kind: 'AutonomousResearchQualificationStateRepository',
    durable: true,
    compareAndSwap: true,
    systemOwnedRuntimeState: true,
    readExternalQualificationState: read,
    compareAndSwapExternalQualificationState({ expectedStateHash, state }) {
      assert.equal(
        read()?.autonomousExternalQualificationStateHash || null,
        expectedStateHash,
      );
      write(structuredClone(state));
      return state;
    },
  });
}

function qualificationServiceIdentities(label) {
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

function principals() {
  const authorCapability = hashed('CodexResearchAuthorCapabilityReceipt',
    'codexResearchAuthorCapabilityReceiptHash', {
      version: 1, kind: 'CodexResearchAuthorCapabilityReceipt',
      status: 'codex_research_author_capability_ready', provider: 'openai', model: 'author',
      credentialRootIdentityHash: H('author-root'), credentialConfigIdentityHash: H('author-config'),
    });
  const reviewerCapability = hashed('CodexFormalReviewerCapabilityReceipt',
    'codexFormalReviewerCapabilityReceiptHash', {
      version: 1, kind: 'CodexFormalReviewerCapabilityReceipt',
      status: 'codex_formal_reviewer_capability_ready', provider: 'openai', model: 'reviewer',
      credentialRootIdentityHash: H('reviewer-root'), credentialConfigIdentityHash: H('reviewer-config'),
      authorCredentialRootIdentityHash: authorCapability.credentialRootIdentityHash,
      credentialIndependenceVerified: true,
      assuranceScope: 'filesystem_credential_root_and_principal_separation',
    });
  return {
    authorPrincipal: { principalId: 'author:test', capabilityReceipt: authorCapability },
    formalReviewerPrincipal: { principalId: 'reviewer:test', capabilityReceipt: reviewerCapability },
  };
}

async function preparation(paperId, datasetMounts = []) {
  return prepareAutonomousResearchLoop({
    paperId,
    protocolFamily: 'ml_algorithm_benchmark',
    ...principals(),
    datasetMounts,
    datasetAuthorityReceipt: datasetMounts.length === 1
      ? trustedDatasetAuthorityReceipt(datasetMounts[0]) : null,
    empiricalRuntimeCapabilityInspection: READY_EMPIRICAL_RUNTIME_CAPABILITY_INSPECTION,
    revisionRounds: 1,
    refereeCount: 3,
    createdAt: '2026-07-15T12:00:00.000Z',
  });
}

function trustedDatasetAuthorityReceipt(mount) {
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

function authorizedDatasetMount(base, name = 'autonomous-dataset') {
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

function testWorkspace(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-autonomous-campaign-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const assetRoot = path.join(base, 'assets');
  const runtimeRoot = path.join(base, 'runtime');
  fs.mkdirSync(assetRoot);
  fs.mkdirSync(runtimeRoot);
  const clock = createSystemClock();
  const store = createDefaultPaperStore({ root: assetRoot, runtimeRoot });
  t.after(() => store.close?.());
  return {
    runtimeRoot,
    clock,
    campaignStore: createSqliteCampaignStore({ store, clock }),
  };
}

function fakeExecutor({ failWriterOnce = false, forbidden = false } = {}) {
  const calls = [];
  let writerFailed = false;
  return {
    calls,
    executor: {
      async execute({ node }) {
        if (forbidden) throw new Error('completed_campaign_reexecuted');
        calls.push(node.kind);
        if (failWriterOnce && node.kind === 'writer' && !writerFailed) {
          writerFailed = true;
          const error = new Error('transient_fake_author_failure');
          error.retryable = true;
          throw error;
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
          ...(/^(?:revision-)?referee-/.test(node.kind)
            ? {
              reviewerId: `independent-review:test:${node.kind}`,
              childSessionId: `independent-session:${node.kind}`,
              reviewHash: H(node.nodeId),
              manuscriptHash: H(`manuscript:${node.roundIndex}`),
              verdict: 'accept',
              score: 1,
              criticalFindingCount: 0,
            } : {}),
          externalActionPerformed: false,
        };
      },
    },
  };
}

function runtime(clock) {
  return {
    concurrency: 1,
    pollMs: 1,
    clock,
    scheduler: createSystemScheduler(),
    idGenerator: createRandomIdGenerator(),
  };
}

function releaseAuthority(campaignId, paperId, preparationReport) {
  const campaignPlanHash = H(`release-plan:${campaignId}`);
  const autonomousResearchReleaseBinding = createAutonomousResearchReleaseBinding({
    campaignId,
    paperId,
    campaignPlanHash,
    preparation: preparationReport,
  });
  return {
    status: 'current_completed_release', campaignStatus: 'completed', packageNodeStatus: 'completed',
    campaignId, paperId, campaignReleaseBundleHash: H(`release:${campaignId}`),
    releaseBundle: {
      campaignPlanHash,
      autonomousResearchReleaseBindingHash:
        autonomousResearchReleaseBinding.autonomousResearchReleaseBindingHash,
      autonomousResearchReleaseBinding,
      researchReport: { promotionEligibility: { status: 'research_promotion_ready' } },
    },
  };
}

function verifiedQualificationInspection({ campaignId, prepared, authority, label }) {
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
    fullDomainVerificationReady: true,
    independentHypothesisPriorArtReviewVerified: true,
    independentHypothesisPriorArtReceiptHash: H(`${label}:prior-art`),
    failureCodes: [],
    blockers: [],
  };
}

test('machine agenda separates empirical outcome from a non-reflexive formal support theorem', async (t) => {
  const fixture = testWorkspace(t);
  const datasetMount = authorizedDatasetMount(fixture.runtimeRoot, 'agenda-dataset');
  const prepared = await preparation('agenda-selected-paper', [datasetMount]);
  assert.equal(prepared.proposal.agendaSelectionReceipt.machineSelectionPerformed, true);
  const empirical = prepared.proposal.claims.find((claim) => claim.verificationMode === 'empirical_protocol');
  const formal = prepared.proposal.claims.find((claim) => claim.verificationMode === 'formal_kernel');
  assert.ok(empirical.empiricalObligations.length > 0);
  assert.deepEqual(empirical.proofObligations, []);
  assert.deepEqual(formal.empiricalObligations, []);
  assert.deepEqual(formal.proofObligations, ['length_filter_le']);
  assert.match(formal.statement, /filter|sublist/i);
  assert.doesNotMatch(formal.assumptions.join(' '), /at most|does not exceed/i);
});

test('verified unique dataset authority constrains automatic family selection without impersonating an override', async (t) => {
  const fixture = testWorkspace(t);
  const datasetMount = authorizedDatasetMount(fixture.runtimeRoot, 'agenda-constraint-dataset');
  const datasetAuthorityReceipt = trustedDatasetAuthorityReceipt(datasetMount);
  const selected = await prepareAutonomousResearchLoop({
    paperId: 'dataset-constrained-agenda-paper',
    ...principals(),
    datasetMounts: [datasetMount],
    datasetAuthorityReceipt,
    empiricalRuntimeCapabilityInspection: READY_EMPIRICAL_RUNTIME_CAPABILITY_INSPECTION,
    createdAt: '2026-07-15T12:00:00.000Z',
  });
  assert.equal(selected.proposal.protocolFamily, datasetMount.benchmarkFamily);
  assert.equal(selected.proposal.agendaSelectionReceipt.datasetAuthorityConstrainedSelection, true);
  assert.equal(selected.proposal.agendaSelectionReceipt.protocolFamilyOverrideUsed, false);
  assert.equal(selected.autonomousExecutionLaunchReady, true);

  const explicitConflict = await prepareAutonomousResearchLoop({
    paperId: 'dataset-family-conflict-paper',
    protocolFamily: 'operations_optimization_benchmark',
    ...principals(),
    datasetMounts: [datasetMount],
    datasetAuthorityReceipt,
    empiricalRuntimeCapabilityInspection: READY_EMPIRICAL_RUNTIME_CAPABILITY_INSPECTION,
    createdAt: '2026-07-15T12:00:00.000Z',
  });
  assert.equal(explicitConflict.proposal.protocolFamily, 'operations_optimization_benchmark');
  assert.equal(explicitConflict.proposal.agendaSelectionReceipt.datasetAuthorityConstrainedSelection, false);
  assert.equal(explicitConflict.proposal.agendaSelectionReceipt.protocolFamilyOverrideUsed, true);
  assert.equal(explicitConflict.autonomousExecutionLaunchReady, false);
  assert.ok(explicitConflict.datasetLaunchInspection.blockers.includes(
    'autonomous_research_unique_matching_dataset_mount_required',
  ));

  const unverified = await prepareAutonomousResearchLoop({
    paperId: 'unverified-dataset-agenda-paper',
    ...principals(),
    datasetMounts: [datasetMount],
    empiricalRuntimeCapabilityInspection: READY_EMPIRICAL_RUNTIME_CAPABILITY_INSPECTION,
    datasetAuthorityReceipt: {
      ...datasetAuthorityReceipt,
      status: 'operator_dataset_harness_authority_blocked',
    },
    createdAt: '2026-07-15T12:00:00.000Z',
  });
  assert.equal(unverified.proposal.agendaSelectionReceipt.datasetAuthorityConstrainedSelection, false);
  assert.equal(unverified.autonomousExecutionLaunchReady, false);
  assert.ok(unverified.datasetLaunchInspection.blockers.includes(
    'autonomous_research_dataset_runtime_authority_preflight_required',
  ));
});

test('one launch crosses qualification epochs automatically, then repeat launch is idempotent', async (t) => {
  const fixture = testWorkspace(t);
  const datasetMount = authorizedDatasetMount(fixture.runtimeRoot, 'launch-dataset');
  const prepared = await preparation('launch-paper', [datasetMount]);
  const repository = createAutonomousResearchWorkspaceRepository({
    runtimeRoot: fixture.runtimeRoot,
    paperId: prepared.proposal.paperId,
  });
  const materialization = materializeAutonomousResearchWorkspace({
    repository, loopPreparation: prepared, datasetMounts: [datasetMount],
  });
  const qualificationStateStore = createAutonomousResearchQualificationStateRepository({
    runtimeRoot: fixture.runtimeRoot,
    paperId: prepared.proposal.paperId,
  });
  const campaignId = 'autonomous-research:launch-paper';
  const fake = fakeExecutor({ failWriterOnce: true });
  let qualificationRequests = 0;
  let qualificationVerifications = 0;
  const qualificationIdentities = qualificationServiceIdentities('launch');
  const externalQualificationClient = {
    kind: 'ExternalResearchQualificationClient',
    ...qualificationIdentities.client,
    async requestQualification(request) {
      qualificationRequests += 1;
      if (qualificationRequests === 1) throw new Error('transient_external_qualifier_unavailable');
      return {
        ...request,
        signature: 'external-service-signature',
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
    },
  };
  const externalQualificationVerifier = {
    kind: 'IndependentExternalResearchQualificationVerifier',
    ...qualificationIdentities.verifier,
    async verify({ receipt, campaignReleaseAuthority }) {
      qualificationVerifications += 1;
      assert.equal(receipt.signature, 'external-service-signature');
      return {
        kind: 'FullResearchQualificationInspection', status: 'full_research_qualification_verified',
        ready: true, receiptAccepted: true, campaignId, paperId: prepared.proposal.paperId,
        campaignReleaseBundleHash: campaignReleaseAuthority.campaignReleaseBundleHash,
        qualificationReceiptHash: H('external-qualification'),
        qualificationSignatureVerified: true, qualificationTimeWindowVerified: true,
        releasePointerVerified: true, independentVerifierVerified: true,
        externalVerificationRequestHash: H('external-verification-request'), blockers: [],
        proposalHash: prepared.proposal.machineProposedScientificClaimSetHash,
        policyAuthorizationHash:
          prepared.policyAuthorization.autonomousResearchPolicyAuthorizationHash,
        seedBindingHash: prepared.seedBinding.autonomousResearchSeedBindingHash,
        fullDomainVerificationReady: true,
        independentHypothesisPriorArtReviewVerified: true,
        independentHypothesisPriorArtReceiptHash: H('independent-prior-art-review'),
      };
    },
  };
  const common = {
    readinessReport: prepared,
    campaignId,
    datasetMounts: [datasetMount],
    campaignStore: fixture.campaignStore,
    campaignReleaseAuthorityReader:
      () => releaseAuthority(campaignId, prepared.proposal.paperId, prepared),
    externalQualificationClient,
    externalQualificationVerifier,
    qualificationStateStore,
    qualificationRetry: {
      maximumAttempts: 1,
      maximumEpochs: 3,
      initialBackoffMs: 0,
      epochCooldownMs: 0,
      deadlineMs: 5000,
    },
    runtime: runtime(fixture.clock),
  };
  const launched = await executeAutonomousResearchCampaign({
    ...common,
    action: 'launch',
    executor: fake.executor,
    preparedMaterialization: materialization,
  });
  assert.equal(launched.status, 'autonomous_research_campaign_completed_and_qualified',
    JSON.stringify(launched));
  assert.equal(launched.campaignFullyQualified, true);
  assert.equal(launched.fullAutomaticResearchWritingReady, launched.campaignFullyQualified);
  assert.equal(qualificationRequests, 2);
  assert.equal(qualificationVerifications, 1);
  assert.ok(fake.calls.includes('formal-verify'));
  assert.ok(fake.calls.includes('empirical-reproduce'));
  const terminalFormalIndex = fake.calls.lastIndexOf('formal-verify');
  const sourceClosureEmpiricalIndex = fake.calls.indexOf('revalidate-empirical-source-seal');
  const sourceClosureReplayIndex = fake.calls.indexOf('revalidate-empirical-reproduce-source-seal');
  const finalCompileIndex = fake.calls.indexOf('final-compile');
  assert.ok(terminalFormalIndex >= 0 && terminalFormalIndex < sourceClosureEmpiricalIndex);
  assert.ok(sourceClosureEmpiricalIndex < sourceClosureReplayIndex);
  assert.ok(sourceClosureReplayIndex < finalCompileIndex);
  assert.ok(fake.calls.includes('revision-referee-1'));
  assert.equal(fake.calls.filter((kind) => kind === 'writer').length, 2);
  assert.ok(launched.run.retryCount >= 1);
  const persistedProtocol = fixture.campaignStore.getCampaign(campaignId).spec.benchmarkSelector;
  assert.equal(persistedProtocol.analysisProtocol.version, 2);
  assert.equal(persistedProtocol.empiricalClaimUniverse.empiricalClaimUniverseHash,
    materialization.empiricalClaimUniverse.empiricalClaimUniverseHash);
  assert.deepEqual(persistedProtocol.analysisProtocol.hypotheses.map((hypothesis) => ({
    claimId: hypothesis.claimId,
    manuscriptClaimHash: hypothesis.manuscriptClaimHash,
    proposalClaimRecordHash: hypothesis.proposalClaimRecordHash,
  })), materialization.empiricalClaimLineage.protocolHypotheses.map((hypothesis) => ({
    claimId: hypothesis.claimId,
    manuscriptClaimHash: hypothesis.manuscriptClaimHash,
    proposalClaimRecordHash: hypothesis.proposalClaimRecordHash,
  })));

  const repeated = await executeAutonomousResearchCampaign({
    ...common,
    action: 'launch',
    executor: fakeExecutor({ forbidden: true }).executor,
  });
  assert.equal(repeated.status, 'autonomous_research_campaign_completed_and_qualified');
  assert.equal(repeated.externalQualification.status, 'qualification_cached_verified_locally');
  assert.equal(qualificationRequests, 2);
  assert.equal(qualificationVerifications, 1);
  const qualificationState = qualificationStateStore.readExternalQualificationState();
  assert.equal(qualificationState.version, 4);
  assert.equal(qualificationState.recovery.epoch, 2);
  assert.equal(qualificationState.recovery.attemptCount, 1);
  assert.equal(qualificationState.recovery.totalAttemptCount, 2);
  assert.equal(qualificationState.verifiedInspection.ready, true);
  assert.equal(fs.existsSync(path.join(repository.sourceWorkspace,
    'AUTONOMOUS_EXTERNAL_QUALIFICATION_STATE.json')), false);
});

test('qualification exhaustion enters cooldown, restart opens a new epoch, and cached receipt is reverified', async (t) => {
  const fixture = testWorkspace(t);
  const datasetMount = authorizedDatasetMount(fixture.runtimeRoot, 'qualification-restart-dataset');
  const prepared = await preparation('qualification-restart-paper', [datasetMount]);
  const campaignId = 'autonomous-research:qualification-restart-paper';
  const authority = releaseAuthority(campaignId, prepared.proposal.paperId, prepared);
  const campaign = {
    campaignId,
    paperId: prepared.proposal.paperId,
    status: 'completed',
    spec: { autonomousResearchPreparation: prepared },
  };
  const campaignStore = {
    createCampaign() { throw new Error('unexpected create'); },
    getCampaign() { return campaign; },
    listNodes() { return []; },
    resumeCampaign() { throw new Error('unexpected resume'); },
  };
  let state = null;
  let writes = 0;
  const qualificationStateStore = memoryQualificationStateStore({
    read() { return state; },
    write(value) {
      writes += 1;
      state = value;
    },
  });
  let requests = 0;
  let verifications = 0;
  const restartIdentities = qualificationServiceIdentities('restart');
  const client = {
    kind: 'ExternalResearchQualificationClient',
    ...restartIdentities.client,
    async requestQualification(request) {
      requests += 1;
      if (requests === 1) throw new Error('transient_qualifier_outage');
      return {
        ...request,
        signature: 'externally-signed-receipt',
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
    },
  };
  const verifier = {
    kind: 'IndependentExternalResearchQualificationVerifier',
    ...restartIdentities.verifier,
    async verify({ receipt }) {
      verifications += 1;
      assert.equal(receipt.signature, 'externally-signed-receipt');
      return {
        kind: 'FullResearchQualificationInspection',
        status: 'full_research_qualification_verified',
        ready: true,
        receiptAccepted: true,
        campaignId,
        paperId: prepared.proposal.paperId,
        campaignReleaseBundleHash: authority.campaignReleaseBundleHash,
        qualificationReceiptHash: H('restart-qualification-receipt'),
        qualificationSignatureVerified: true,
        qualificationTimeWindowVerified: true,
        releasePointerVerified: true,
        independentVerifierVerified: true,
        externalVerificationRequestHash: H('restart-independent-verification'),
        proposalHash: prepared.proposal.machineProposedScientificClaimSetHash,
        policyAuthorizationHash:
          prepared.policyAuthorization.autonomousResearchPolicyAuthorizationHash,
        seedBindingHash: prepared.seedBinding.autonomousResearchSeedBindingHash,
        fullDomainVerificationReady: true,
        independentHypothesisPriorArtReviewVerified: true,
        independentHypothesisPriorArtReceiptHash: H('restart-prior-art-review'),
        blockers: [],
      };
    },
  };
  let nowMs = Date.parse('2026-07-15T12:00:00.000Z');
  const clock = { now: () => new Date(nowMs) };
  const common = {
    campaignId,
    campaignStore,
    campaignReleaseAuthorityReader: () => authority,
    externalQualificationClient: client,
    externalQualificationVerifier: verifier,
    qualificationStateStore,
  };
  await assert.rejects(() => executeAutonomousResearchCampaign({
    ...common,
    action: 'launch',
    qualificationRetry: {
      maximumAttempts: 1,
      maximumEpochs: 3,
      initialBackoffMs: 1000,
      epochCooldownMs: 1000,
      deadlineMs: 10_000,
      globalDeadlineMs: 60_000,
      clock,
      scheduler: { async sleep() { throw new Error('simulated_process_shutdown'); } },
    },
  }), /simulated_process_shutdown/);
  assert.equal(state.recovery.status, 'qualification_epoch_cooldown');
  assert.equal(state.recovery.epoch, 1);
  assert.equal(state.recovery.attemptCount, 1);
  assert.equal(state.recovery.totalAttemptCount, 1);
  assert.equal(state.receipt, null);
  const stateBeforeStatus = structuredClone(state);
  const writesBeforeStatus = writes;
  const pending = await executeAutonomousResearchCampaign({ ...common, action: 'status' });
  assert.equal(pending.externalQualification.status, 'qualification_pending_explicit_resume');
  assert.equal(writes, writesBeforeStatus);
  assert.deepEqual(state, stateBeforeStatus);

  const resumed = await executeAutonomousResearchCampaign({
    ...common,
    action: 'resume',
    qualificationRetry: {
      maximumAttempts: 1,
      maximumEpochs: 3,
      initialBackoffMs: 1000,
      epochCooldownMs: 1000,
      deadlineMs: 10_000,
      globalDeadlineMs: 60_000,
      clock,
      scheduler: { async sleep(milliseconds) { nowMs += milliseconds; } },
    },
  });
  assert.equal(resumed.status, 'autonomous_research_campaign_completed_and_qualified');
  assert.equal(requests, 2);
  assert.equal(verifications, 1);
  assert.equal(state.recovery.status, 'qualification_verified');
  assert.equal(state.recovery.epoch, 2);
  assert.equal(state.recovery.attemptCount, 1);
  assert.equal(state.recovery.totalAttemptCount, 2);
  assert.equal(state.verifiedInspection.ready, true);

  const writesBeforeLocalStatus = writes;
  const reverified = await executeAutonomousResearchCampaign({ ...common, action: 'status' });
  assert.equal(reverified.externalQualification.status, 'qualification_cached_verified_locally');
  assert.equal(verifications, 1);
  assert.equal(writes, writesBeforeLocalStatus);
});

test('a terminal bad-signature receipt stays blocked for one trust configuration but rotates automatically', async (t) => {
  const fixture = testWorkspace(t);
  const datasetMount = authorizedDatasetMount(fixture.runtimeRoot, 'qualification-rotation-dataset');
  const prepared = await preparation('qualification-rotation-paper', [datasetMount]);
  const campaignId = 'autonomous-research:qualification-rotation-paper';
  const authority = releaseAuthority(campaignId, prepared.proposal.paperId, prepared);
  const campaign = {
    campaignId,
    paperId: prepared.proposal.paperId,
    status: 'completed',
    spec: { autonomousResearchPreparation: prepared },
  };
  const campaignStore = {
    createCampaign() { throw new Error('unexpected create'); },
    getCampaign() { return campaign; },
    listNodes() { return []; },
    resumeCampaign() { throw new Error('unexpected resume'); },
  };
  let state = null;
  const qualificationStateStore = memoryQualificationStateStore({
    read() { return state; },
    write(value) { state = value; },
  });
  const oldIdentities = qualificationServiceIdentities('rotation-old');
  let oldRequests = 0;
  const oldClient = {
    kind: 'ExternalResearchQualificationClient',
    ...oldIdentities.client,
    async requestQualification() {
      oldRequests += 1;
      return { receipt: 'signed-by-wrong-key' };
    },
  };
  const oldVerifier = {
    kind: 'IndependentExternalResearchQualificationVerifier',
    ...oldIdentities.verifier,
    async verify() {
      return {
        kind: 'FullResearchQualificationInspection',
        status: 'full_research_qualification_blocked',
        ready: false,
        receiptAccepted: false,
        failureCodes: ['external_qualification.receipt_signature_invalid'],
        blockers: ['external_qualification_signature_invalid'],
      };
    },
  };
  const common = {
    action: 'launch',
    campaignId,
    campaignStore,
    campaignReleaseAuthorityReader: () => authority,
    qualificationStateStore,
    qualificationRetry: { maximumAttempts: 1, maximumEpochs: 2, initialBackoffMs: 0 },
  };
  const first = await executeAutonomousResearchCampaign({
    ...common,
    externalQualificationClient: oldClient,
    externalQualificationVerifier: oldVerifier,
  });
  assert.equal(first.externalQualification.status, 'qualification_external_service_blocked');
  assert.equal(state.recovery.status, 'qualification_terminal_blocked');
  assert.equal(state.recovery.configurationIdentityHash, oldIdentities.client.configurationIdentityHash);
  assert.deepEqual(state.recovery.terminalFailure.failureCodes,
    ['external_qualification.receipt_signature_invalid']);
  assert.match(state.recovery.terminalFailure.rejectedReceiptHash, /^sha256:/);
  const oldRecoveryConfigurationIdentityHash =
    state.recovery.recoveryConfigurationIdentityHash;

  const sameConfiguration = await executeAutonomousResearchCampaign({
    ...common,
    externalQualificationClient: oldClient,
    externalQualificationVerifier: oldVerifier,
  });
  assert.equal(sameConfiguration.externalQualification.status,
    'qualification_external_service_terminal_blocked');
  assert.equal(oldRequests, 1);

  const newIdentities = qualificationServiceIdentities('rotation-new');
  let newRequests = 0;
  const newClient = {
    kind: 'ExternalResearchQualificationClient',
    ...newIdentities.client,
    async requestQualification(request) {
      newRequests += 1;
      return {
        ...request,
        signature: 'valid-after-trust-rotation',
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
    },
  };
  const newVerifier = {
    kind: 'IndependentExternalResearchQualificationVerifier',
    ...newIdentities.verifier,
    async verify() {
      return {
        kind: 'FullResearchQualificationInspection',
        status: 'full_research_qualification_verified',
        ready: true,
        receiptAccepted: true,
        campaignId,
        paperId: prepared.proposal.paperId,
        campaignReleaseBundleHash: authority.campaignReleaseBundleHash,
        qualificationReceiptHash: H('rotation-qualification-receipt'),
        qualificationSignatureVerified: true,
        qualificationTimeWindowVerified: true,
        releasePointerVerified: true,
        independentVerifierVerified: true,
        externalVerificationRequestHash: H('rotation-verification-request'),
        proposalHash: prepared.proposal.machineProposedScientificClaimSetHash,
        policyAuthorizationHash:
          prepared.policyAuthorization.autonomousResearchPolicyAuthorizationHash,
        seedBindingHash: prepared.seedBinding.autonomousResearchSeedBindingHash,
        fullDomainVerificationReady: true,
        independentHypothesisPriorArtReviewVerified: true,
        independentHypothesisPriorArtReceiptHash: H('rotation-prior-art'),
        failureCodes: [],
        blockers: [],
      };
    },
  };
  const rotated = await executeAutonomousResearchCampaign({
    ...common,
    externalQualificationClient: newClient,
    externalQualificationVerifier: newVerifier,
  });
  assert.equal(rotated.status, 'autonomous_research_campaign_completed_and_qualified');
  assert.equal(rotated.externalQualification.status, 'qualification_external_service_verified');
  assert.equal(newRequests, 1);
  assert.equal(state.recovery.status, 'qualification_verified');
  assert.equal(state.recovery.configurationIdentityHash, newIdentities.client.configurationIdentityHash);
  assert.notEqual(state.recovery.recoveryConfigurationIdentityHash,
    oldRecoveryConfigurationIdentityHash);
});

test('qualification requires durable state, rejects corrupt state, and policy growth re-arms exhaustion', async (t) => {
  const fixture = testWorkspace(t);
  const datasetMount = authorizedDatasetMount(fixture.runtimeRoot, 'qualification-policy-dataset');
  const prepared = await preparation('qualification-policy-paper', [datasetMount]);
  const campaignId = 'autonomous-research:qualification-policy-paper';
  const authority = releaseAuthority(campaignId, prepared.proposal.paperId, prepared);
  const campaign = {
    campaignId,
    paperId: prepared.proposal.paperId,
    status: 'completed',
    spec: { autonomousResearchPreparation: prepared },
  };
  const campaignStore = {
    createCampaign() { throw new Error('unexpected create'); },
    getCampaign() { return campaign; },
    listNodes() { return []; },
    resumeCampaign() { throw new Error('unexpected resume'); },
  };
  let state = null;
  const qualificationStateStore = memoryQualificationStateStore({
    read() { return state; },
    write(value) { state = value; },
  });
  let requests = 0;
  let succeed = false;
  const identities = qualificationServiceIdentities('policy-growth');
  const client = {
    kind: 'ExternalResearchQualificationClient',
    ...identities.client,
    async requestQualification(request) {
      requests += 1;
      if (!succeed) throw new Error('temporary outage');
      return { ...request, expiresAt: '2099-01-01T00:00:00.000Z', signature: 'valid' };
    },
  };
  const verifier = {
    kind: 'IndependentExternalResearchQualificationVerifier',
    ...identities.verifier,
    async verify() {
      return verifiedQualificationInspection({ campaignId, prepared, authority, label: 'growth' });
    },
  };
  let nowMs = Date.parse('2026-07-15T12:00:00.000Z');
  const common = {
    action: 'resume',
    campaignId,
    campaignStore,
    campaignReleaseAuthorityReader: () => authority,
    externalQualificationClient: client,
    externalQualificationVerifier: verifier,
  };
  const missingStore = await executeAutonomousResearchCampaign(common);
  assert.equal(missingStore.externalQualification.status,
    'qualification_durable_state_store_required');
  assert.equal(requests, 0);

  const corrupt = await executeAutonomousResearchCampaign({
    ...common,
    qualificationStateStore: {
      ...qualificationStateStore,
      readExternalQualificationState() { return { version: 4, nextAttemptAt: '2099-01-01' }; },
    },
  });
  assert.equal(corrupt.externalQualification.status, 'qualification_external_state_invalid');
  assert.equal(requests, 0);

  const first = await executeAutonomousResearchCampaign({
    ...common,
    qualificationStateStore,
    qualificationRetry: {
      maximumAttempts: 1,
      maximumEpochs: 1,
      maximumTotalAttempts: 1,
      initialBackoffMs: 0,
      exhaustedCooldownMs: 60 * 60 * 1000,
      clock: { now: () => new Date(nowMs) },
      scheduler: { async sleep(milliseconds) { nowMs += milliseconds; } },
    },
  });
  assert.equal(first.externalQualification.status,
    'qualification_external_service_recovery_budget_exhausted');
  assert.equal(requests, 1);
  const cooling = await executeAutonomousResearchCampaign({
    ...common,
    qualificationStateStore,
    qualificationRetry: {
      maximumAttempts: 1,
      maximumEpochs: 1,
      maximumTotalAttempts: 1,
      initialBackoffMs: 0,
      exhaustedCooldownMs: 60 * 60 * 1000,
      clock: { now: () => new Date(nowMs) },
    },
  });
  assert.equal(cooling.externalQualification.status,
    'qualification_external_service_recovery_cooldown');
  assert.equal(requests, 1);

  succeed = true;
  const rearmed = await executeAutonomousResearchCampaign({
    ...common,
    qualificationStateStore,
    qualificationRetry: {
      maximumAttempts: 2,
      maximumEpochs: 2,
      maximumTotalAttempts: 4,
      initialBackoffMs: 0,
      exhaustedCooldownMs: 60 * 60 * 1000,
      clock: { now: () => new Date(nowMs) },
    },
  });
  assert.equal(rearmed.status, 'autonomous_research_campaign_completed_and_qualified');
  assert.equal(requests, 2);
  assert.notEqual(state.recovery.retryPolicyIdentityHash,
    first.externalQualification.retryPolicyIdentityHash);
});

test('qualification attempt lease prevents concurrent resume from duplicating an external call', async (t) => {
  const fixture = testWorkspace(t);
  const datasetMount = authorizedDatasetMount(fixture.runtimeRoot, 'qualification-lease-dataset');
  const prepared = await preparation('qualification-lease-paper', [datasetMount]);
  const campaignId = 'autonomous-research:qualification-lease-paper';
  const authority = releaseAuthority(campaignId, prepared.proposal.paperId, prepared);
  const campaign = {
    campaignId,
    paperId: prepared.proposal.paperId,
    status: 'completed',
    spec: { autonomousResearchPreparation: prepared },
  };
  const campaignStore = {
    createCampaign() { throw new Error('unexpected create'); },
    getCampaign() { return campaign; },
    listNodes() { return []; },
    resumeCampaign() { throw new Error('unexpected resume'); },
  };
  let state = null;
  const qualificationStateStore = memoryQualificationStateStore({
    read() { return state; },
    write(value) { state = value; },
  });
  let requests = 0;
  let releaseRequest;
  const requestGate = new Promise((resolve) => { releaseRequest = resolve; });
  const identities = qualificationServiceIdentities('lease');
  const client = {
    kind: 'ExternalResearchQualificationClient',
    ...identities.client,
    async requestQualification() {
      requests += 1;
      return requestGate;
    },
  };
  const verifier = {
    kind: 'IndependentExternalResearchQualificationVerifier',
    ...identities.verifier,
    async verify() {
      return verifiedQualificationInspection({ campaignId, prepared, authority, label: 'lease' });
    },
  };
  const common = {
    action: 'resume',
    campaignId,
    campaignStore,
    campaignReleaseAuthorityReader: () => authority,
    externalQualificationClient: client,
    externalQualificationVerifier: verifier,
    qualificationStateStore,
    qualificationRetry: { maximumAttempts: 1, maximumEpochs: 1, attemptLeaseMs: 60_000 },
  };
  const first = executeAutonomousResearchCampaign(common);
  await new Promise((resolve) => { setImmediate(resolve); });
  const concurrent = await executeAutonomousResearchCampaign(common);
  assert.equal(concurrent.externalQualification.status,
    'qualification_external_service_attempt_in_progress');
  assert.equal(requests, 1);
  releaseRequest({ expiresAt: '2099-01-01T00:00:00.000Z', signature: 'valid' });
  const completed = await first;
  assert.equal(completed.status, 'autonomous_research_campaign_completed_and_qualified');
  assert.equal(requests, 1);
});

test('resume uses persisted fencing state and completes a paused campaign without rebuilding its plan', async (t) => {
  const fixture = testWorkspace(t);
  const datasetMount = authorizedDatasetMount(fixture.runtimeRoot, 'resume-dataset');
  const prepared = await preparation('resume-paper', [datasetMount]);
  const repository = createAutonomousResearchWorkspaceRepository({
    runtimeRoot: fixture.runtimeRoot,
    paperId: prepared.proposal.paperId,
  });
  const materialization = materializeAutonomousResearchWorkspace({
    repository, loopPreparation: prepared, datasetMounts: [datasetMount],
  });
  const campaignId = 'autonomous-research:resume-paper';
  assert.equal(materialization.empiricalExecutionProfileSelectionHash,
    prepared.empiricalExecutionProfileSelection
      .autonomousEmpiricalExecutionProfileSelectionHash);
  assert.equal(materialization.empiricalRuntimeCapabilityInspectionHash,
    prepared.empiricalRuntimeCapabilityInspection
      .autonomousEmpiricalRuntimeCapabilityInspectionHash);
  const plan = buildAutonomousResearchCampaignPlan({
    loopPreparation: prepared,
    materialization,
    datasetMounts: [datasetMount],
    campaignId,
  });
  assert.equal(plan.autonomousEmpiricalExecutionProfileSelectionHash,
    prepared.empiricalExecutionProfileSelection
      .autonomousEmpiricalExecutionProfileSelectionHash);
  assert.deepEqual(plan.languages, ['lean', 'python', 'latex']);
  fixture.campaignStore.createCampaign(plan);
  fixture.campaignStore.pauseCampaign(campaignId, 'simulated_process_shutdown');
  const fake = fakeExecutor();
  const result = await executeAutonomousResearchCampaign({
    action: 'resume',
    campaignId,
    campaignStore: fixture.campaignStore,
    executor: fake.executor,
    campaignReleaseAuthorityReader:
      () => releaseAuthority(campaignId, prepared.proposal.paperId, prepared),
    qualificationStateStore: createAutonomousResearchQualificationStateRepository({
      runtimeRoot: fixture.runtimeRoot,
      paperId: prepared.proposal.paperId,
    }),
    runtime: runtime(fixture.clock),
  });
  assert.equal(result.status, 'autonomous_research_campaign_completed_external_qualification_eligible', JSON.stringify(result));
  assert.equal(result.campaignFullyQualified, false);
  assert.equal(result.fullAutomaticResearchWritingReady, result.campaignFullyQualified);
  assert.equal(result.externalQualification.status, 'qualification_pending_external_service');
  assert.equal(fixture.campaignStore.getCampaign(campaignId).status, 'completed');
  assert.ok(fixture.campaignStore.listEvents(campaignId).some((event) => event.kind === 'campaign_resumed'));
});

test('materialization and launch fail closed on authority conflicts or absent academic dataset authority', async (t) => {
  const fixture = testWorkspace(t);
  const datasetMount = authorizedDatasetMount(fixture.runtimeRoot, 'blocked-dataset');
  const prepared = await preparation('blocked-launch-paper', [datasetMount]);
  const repository = createAutonomousResearchWorkspaceRepository({
    runtimeRoot: fixture.runtimeRoot,
    paperId: prepared.proposal.paperId,
  });
  const materialization = materializeAutonomousResearchWorkspace({
    repository, loopPreparation: prepared, datasetMounts: [datasetMount],
  });
  const {
    autonomousResearchLoopPreparationReportHash: _ignoredPreparationHash,
    ...forgedPreparationPayload
  } = structuredClone(prepared);
  forgedPreparationPayload.empiricalRuntimeCapabilityInspection =
    R_DIGEST_MISMATCH_RUNTIME_CAPABILITY_INSPECTION;
  const fullyRehashedMismatchedPreparation = {
    ...forgedPreparationPayload,
    autonomousResearchLoopPreparationReportHash:
      hashRecord('AutonomousResearchLoopPreparationReport', forgedPreparationPayload),
  };
  assert.throws(() => materializeAutonomousResearchWorkspace({
    repository,
    loopPreparation: fullyRehashedMismatchedPreparation,
    datasetMounts: [datasetMount],
  }), /autonomous_research_workspace_empirical_execution_profile_invalid/);
  assert.throws(() => buildAutonomousResearchCampaignPlan({
    loopPreparation: fullyRehashedMismatchedPreparation,
    materialization,
    datasetMounts: [datasetMount],
  }), /autonomous_research_empirical_execution_profile_invalid/);
  assert.throws(() => buildPaperCampaignPlan({
    paperId: prepared.proposal.paperId,
    sourceWorkspace: materialization.sourceWorkspace,
    mode: 'full-campaign',
    maxRounds: 1,
    refereeCount: 3,
    languages: ['lean', 'python', 'latex'],
    datasetMounts: [datasetMount],
    benchmarkId: datasetMount.name,
    empiricalClaimUniverse: materialization.empiricalClaimUniverse,
    applyManuscript: true,
    paperQualityProfiles: ['formal_theorem_or_proof', 'empirical_or_experiment'],
    scientificClaimAuthority: prepared.seedBinding,
    autonomousResearchPreparation: fullyRehashedMismatchedPreparation,
  }), /campaign_autonomous_research_preparation_invalid/);
  void _ignoredPreparationHash;
  assert.throws(() => materializeAutonomousResearchWorkspace({
    repository,
    loopPreparation: { ...prepared, seedBundle: { ...prepared.seedBundle, status: 'tampered' } },
    datasetMounts: [datasetMount],
  }), /materialization_not_authorized/);
  const conflictingMount = authorizedDatasetMount(fixture.runtimeRoot, 'conflicting-dataset');
  const conflictingPrepared = await preparation('conflicting-source-paper', [conflictingMount]);
  const conflictingRepository = createAutonomousResearchWorkspaceRepository({
    runtimeRoot: fixture.runtimeRoot,
    paperId: conflictingPrepared.proposal.paperId,
  });
  conflictingRepository.writeTextOnce('main.tex', 'ATTACKER CONTENT\n');
  assert.throws(() => materializeAutonomousResearchWorkspace({
    repository: conflictingRepository,
    loopPreparation: conflictingPrepared,
    datasetMounts: [conflictingMount],
  }), /autonomous_research_workspace_record_conflict:main\.tex/);
  assert.throws(() => buildAutonomousResearchCampaignPlan({
    loopPreparation: prepared,
    materialization,
    datasetMounts: [],
  }), /academic_dataset_authority_required/);
});

test('proposal A cannot be replaced by empirical claim B after recomputing manuscript, universe, lineage, and receipt hashes', async (t) => {
  const fixture = testWorkspace(t);
  const datasetMount = authorizedDatasetMount(fixture.runtimeRoot, 'lineage-attack-dataset');
  const prepared = await preparation('lineage-attack-paper', [datasetMount]);
  const repository = createAutonomousResearchWorkspaceRepository({
    runtimeRoot: fixture.runtimeRoot,
    paperId: prepared.proposal.paperId,
  });
  const materialization = materializeAutonomousResearchWorkspace({
    repository,
    loopPreparation: prepared,
    datasetMounts: [datasetMount],
  });
  const originalRawClaim = prepared.seedBundle.claims.find(
    (claim) => claim.verificationMode === 'empirical_protocol',
  );
  const substitutedRawClaim = {
    ...originalRawClaim,
    text: 'Substituted claim B asserts an unrelated empirical outcome.',
    assumptions: ['Substituted assumption B.'],
    quantifiers: ['For a substituted population B.'],
    negativeBoundaries: ['Substituted negative boundary B.'],
    empiricalObligations: ['Substituted evidence obligation B.'],
  };
  const substitutedRecordHash = hashRecord('AutonomousResearchClaimRecord', substitutedRawClaim);
  const substitutedText = renderAutonomousEmpiricalClaimStatement(substitutedRawClaim.text);
  const mainPath = materialization.mainTex;
  const substitutedSource = fs.readFileSync(mainPath, 'utf8')
    .replaceAll(materialization.empiricalClaimLineage.proposalClaimRecordHash, substitutedRecordHash)
    .replaceAll(materialization.empiricalClaimLineage.manuscriptClaimText, substitutedText);
  fs.writeFileSync(mainPath, substitutedSource);
  const substitutedUniverse = readEmpiricalClaimUniverse({
    sourceRoot: materialization.sourceWorkspace,
  });
  assert.equal(substitutedUniverse.status, 'empirical_claim_universe_verified');
  const lineagePayload = {
    ...structuredClone(materialization.empiricalClaimLineage),
    proposalClaimRecordHash: substitutedRecordHash,
    proposalClaimScope: {
      statement: substitutedRawClaim.text,
      assumptions: substitutedRawClaim.assumptions,
      quantifiers: substitutedRawClaim.quantifiers,
      negativeBoundaries: substitutedRawClaim.negativeBoundaries,
      evidenceObligations: substitutedRawClaim.empiricalObligations,
    },
    statementRenderingPolicy: 'deterministic-latex-source-escaping-v1',
    manuscriptClaimText: substitutedText,
    empiricalClaimUniverseHash: substitutedUniverse.empiricalClaimUniverseHash,
    manuscriptCorpusHash: substitutedUniverse.manuscriptCorpusHash,
    protocolHypotheses: substitutedUniverse.claims.map((claim) => ({
      claimId: claim.claimId,
      manuscriptClaimHash: claim.manuscriptClaimHash,
      proposalClaimRecordHash: claim.proposalClaimRecordHash,
      metric: claim.metric,
      comparator: claim.comparator,
      alternative: claim.alternative,
      minimumEffect: claim.minimumEffect,
      acceptanceRequired: claim.acceptanceRequired,
    })),
  };
  lineagePayload.proposalClaimScopeHash = hashRecord(
    'AutonomousEmpiricalProposalClaimScope',
    lineagePayload.proposalClaimScope,
  );
  delete lineagePayload.autonomousEmpiricalClaimLineageHash;
  const substitutedLineage = {
    ...lineagePayload,
    autonomousEmpiricalClaimLineageHash:
      hashRecord('AutonomousEmpiricalClaimLineage', lineagePayload),
  };
  const materializationPayload = {
    ...structuredClone(materialization),
    empiricalClaimUniverse: substitutedUniverse,
    empiricalClaimLineage: substitutedLineage,
    records: {
      ...materialization.records,
      mainTex: hashBytes(Buffer.from(substitutedSource, 'utf8')),
      autonomousEmpiricalClaimLineage: hashBytes(Buffer.from(
        `${JSON.stringify(substitutedLineage, null, 2)}\n`,
        'utf8',
      )),
    },
  };
  delete materializationPayload.autonomousResearchWorkspaceMaterializationReceiptHash;
  const fullyRehashedMaterialization = {
    ...materializationPayload,
    autonomousResearchWorkspaceMaterializationReceiptHash: hashRecord(
      'AutonomousResearchWorkspaceMaterializationReceipt',
      materializationPayload,
    ),
  };
  assert.throws(() => buildAutonomousResearchCampaignPlan({
    loopPreparation: prepared,
    materialization: fullyRehashedMaterialization,
    datasetMounts: [datasetMount],
  }), /autonomous_research_empirical_claim_lineage_invalid/);
});

test('converge idempotently launches, settles, and obtains external machine qualification', async (t) => {
  const fixture = testWorkspace(t);
  const datasetMount = authorizedDatasetMount(fixture.runtimeRoot, 'converge-dataset');
  const prepared = await preparation('converge-paper', [datasetMount]);
  const repository = createAutonomousResearchWorkspaceRepository({
    runtimeRoot: fixture.runtimeRoot,
    paperId: prepared.proposal.paperId,
  });
  const materialization = materializeAutonomousResearchWorkspace({
    repository,
    loopPreparation: prepared,
    datasetMounts: [datasetMount],
  });
  const campaignId = 'autonomous-research:converge-paper';
  const authority = releaseAuthority(campaignId, prepared.proposal.paperId, prepared);
  const qualificationStateStore = createAutonomousResearchQualificationStateRepository({
    runtimeRoot: fixture.runtimeRoot,
    paperId: prepared.proposal.paperId,
  });
  const identities = qualificationServiceIdentities('converge');
  let qualificationRequests = 0;
  const common = {
    action: 'converge',
    readinessReport: prepared,
    campaignId,
    datasetMounts: [datasetMount],
    campaignStore: fixture.campaignStore,
    campaignReleaseAuthorityReader: () => authority,
    qualificationStateStore,
    externalQualificationClient: {
      kind: 'ExternalResearchQualificationClient',
      ...identities.client,
      async requestQualification(request) {
        qualificationRequests += 1;
        return Object.freeze({
          ...request,
          signature: 'external-machine-signature',
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
      },
    },
    externalQualificationVerifier: {
      kind: 'IndependentExternalResearchQualificationVerifier',
      ...identities.verifier,
      async verify() {
        return verifiedQualificationInspection({
          campaignId,
          prepared,
          authority,
          label: 'converge',
        });
      },
    },
    qualificationRetry: {
      maximumAttempts: 1,
      maximumEpochs: 1,
      maximumTotalAttempts: 1,
      initialBackoffMs: 0,
    },
    runtime: runtime(fixture.clock),
  };
  const first = await executeAutonomousResearchCampaign({
    ...common,
    executor: fakeExecutor().executor,
    preparedMaterialization: materialization,
  });
  assert.equal(first.status, 'autonomous_research_campaign_completed_and_qualified',
    JSON.stringify(first));
  assert.equal(first.action, 'converge');
  assert.equal(first.automaticBudgetExpansionPerformed, false);
  assert.equal(first.externalSubmissionPerformed, false);
  assert.equal(first.selfSignedExternalQualification, false);
  assert.equal(qualificationRequests, 1);

  const repeated = await executeAutonomousResearchCampaign(common);
  assert.equal(repeated.status, 'autonomous_research_campaign_completed_and_qualified');
  assert.equal(repeated.externalQualification.status, 'qualification_cached_verified_locally');
  assert.equal(qualificationRequests, 1);
});

test('converge never resumes paused or stopped campaigns without caller budget configuration', async (t) => {
  const fixture = testWorkspace(t);
  const datasetMount = authorizedDatasetMount(fixture.runtimeRoot, 'converge-resume-dataset');
  const prepared = await preparation('converge-resume-paper', [datasetMount]);
  const repository = createAutonomousResearchWorkspaceRepository({
    runtimeRoot: fixture.runtimeRoot,
    paperId: prepared.proposal.paperId,
  });
  const materialization = materializeAutonomousResearchWorkspace({
    repository,
    loopPreparation: prepared,
    datasetMounts: [datasetMount],
  });
  const campaignId = 'autonomous-research:converge-resume-paper';
  fixture.campaignStore.createCampaign(buildAutonomousResearchCampaignPlan({
    loopPreparation: prepared,
    materialization,
    datasetMounts: [datasetMount],
    campaignId,
  }));
  fixture.campaignStore.pauseCampaign(campaignId, 'simulated_unattended_restart');
  const common = {
    action: 'converge',
    campaignId,
    campaignStore: fixture.campaignStore,
    executor: fakeExecutor().executor,
    campaignReleaseAuthorityReader:
      () => releaseAuthority(campaignId, prepared.proposal.paperId, prepared),
    qualificationStateStore: createAutonomousResearchQualificationStateRepository({
      runtimeRoot: fixture.runtimeRoot,
      paperId: prepared.proposal.paperId,
    }),
    runtime: runtime(fixture.clock),
  };
  await assert.rejects(
    () => executeAutonomousResearchCampaign(common),
    /autonomous_research_converge_resume_budget_configuration_required/,
  );
  assert.equal(fixture.campaignStore.getCampaign(campaignId).status, 'paused');

  const existingBudget = fixture.campaignStore.getCampaign(campaignId).spec.budgets.maxWallTimeMs;
  await assert.rejects(() => executeAutonomousResearchCampaign({
    ...common,
    executor: null,
    budgets: { maxWallTimeMs: existingBudget },
  }), /autonomous_research_campaign_executor_required/);
  assert.equal(fixture.campaignStore.getCampaign(campaignId).status, 'paused');

  const resumed = await executeAutonomousResearchCampaign({
    ...common,
    budgets: { maxWallTimeMs: existingBudget },
  });
  assert.equal(resumed.status,
    'autonomous_research_campaign_completed_external_qualification_eligible');
  assert.equal(resumed.automaticBudgetExpansionPerformed, false);
  const resumeEvent = fixture.campaignStore.listEvents(campaignId)
    .find((event) => event.kind === 'campaign_resumed');
  assert.deepEqual(resumeEvent.event.detail.budgetOverrides, { maxWallTimeMs: existingBudget });

  const stoppedDataset = authorizedDatasetMount(
    fixture.runtimeRoot,
    'converge-stopped-dataset',
  );
  const stoppedPrepared = await preparation('converge-stopped-paper', [stoppedDataset]);
  const stoppedRepository = createAutonomousResearchWorkspaceRepository({
    runtimeRoot: fixture.runtimeRoot,
    paperId: stoppedPrepared.proposal.paperId,
  });
  const stoppedMaterialization = materializeAutonomousResearchWorkspace({
    repository: stoppedRepository,
    loopPreparation: stoppedPrepared,
    datasetMounts: [stoppedDataset],
  });
  const stoppedCampaignId = 'autonomous-research:converge-stopped-paper';
  fixture.campaignStore.createCampaign(buildAutonomousResearchCampaignPlan({
    loopPreparation: stoppedPrepared,
    materialization: stoppedMaterialization,
    datasetMounts: [stoppedDataset],
    campaignId: stoppedCampaignId,
  }));
  fixture.campaignStore.stopCampaign(
    stoppedCampaignId,
    'campaign_agent_call_budget_exhausted',
  );
  await assert.rejects(() => executeAutonomousResearchCampaign({
    action: 'converge',
    campaignId: stoppedCampaignId,
    campaignStore: fixture.campaignStore,
  }), /autonomous_research_converge_resume_budget_configuration_required/);
  assert.equal(fixture.campaignStore.getCampaign(stoppedCampaignId).status, 'stopped');
});
