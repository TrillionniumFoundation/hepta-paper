import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  evaluateAutonomousResearchLaunchModeGate,
  resolveAutonomousResearchProviderPricing,
} from '../../paper-domain/automation/autonomous-research-launch-mode-policy.mjs';
import {
  createFullResearchQualificationReceiptPointerRepository,
} from '../../paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs';
import {
  createGoldenCampaignQualificationController,
} from '../../paper-application/automation/golden-campaign-qualification-controller.mjs';
import {
  buildAutonomousResearchMachineIntake,
  buildAutonomousResearchRecurringGoldenTemplate,
  materializeAutonomousResearchRecurringGoldenIntake,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  buildAutonomousResearchMachineIntakeAdmission,
} from '../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';
import {
  createAutonomousResearchReleaseBinding,
} from '../../paper-domain/automation/autonomous-research-release-binding-contract.mjs';
import {
  composeAutonomousResearchCampaignAction,
  requireExistingProductionPricingEnvelope,
} from '../../paper-composition/automation/autonomous-research-campaign-composition.mjs';

const H = (label) => hashRecord('AutonomousLaunchModeGoldenControllerTestHash', { label });

function pricing(author = 2, reviewer = 3) {
  return resolveAutonomousResearchProviderPricing({
    researchAuthorProvider: 'codex',
    researchAuthorModel: 'author-model',
    formalReviewerProvider: 'codex',
    formalReviewerModel: 'reviewer-model',
    researchAuthorMaximumCostPerCallUsd: author,
    formalReviewerMaximumCostPerCallUsd: reviewer,
  });
}

const FULL_READY = Object.freeze({
  fullResearchQualificationReady: true,
  campaignFullyQualified: true,
  fullAutomaticResearchWritingReady: true,
  researchExecutionReleaseAttestorProductionReady: true,
  runtimeImageReproducibilityReady: true,
  runtimeImageReproducibility: Object.freeze({
    issuedAt: '2026-07-16T00:00:00.000Z',
    expiresAt: '2026-07-17T00:00:00.000Z',
    remainingValidityMs: 24 * 60 * 60 * 1000,
  }),
  fullResearchQualification: Object.freeze({
    issuedAt: '2026-07-16T00:00:00.000Z',
    expiresAt: '2026-07-17T00:00:00.000Z',
    remainingValidityMs: 24 * 60 * 60 * 1000,
  }),
});

test('golden bootstrap fails closed on unknown pricing and clamps known-price calls', () => {
  const unknown = pricing(null, null);
  const gate = evaluateAutonomousResearchLaunchModeGate({
    launchMode: 'golden-bootstrap',
    action: 'launch',
    budgets: {
      maxWallTimeMs: Number.MAX_SAFE_INTEGER,
      maxAgentCalls: Number.MAX_SAFE_INTEGER,
      maxTokenCount: Number.MAX_SAFE_INTEGER,
      maxCostUsd: Number.MAX_SAFE_INTEGER,
    },
    providerPricingInspection: unknown,
  });
  assert.equal(gate.status, 'autonomous_research_launch_mode_blocked');
  assert.ok(gate.blockers.includes('autonomous_research_provider_pricing_required'));
  assert.equal(gate.unknownProviderCostTreatedAsUnlimited, false);
  assert.equal(gate.budgetPolicy, 'golden-bootstrap-priced-call-cost-and-wall-limits-v2');

  const priced = evaluateAutonomousResearchLaunchModeGate({
    launchMode: 'golden-bootstrap',
    action: 'launch',
    budgets: {
      maxWallTimeMs: Number.MAX_SAFE_INTEGER,
      maxAgentCalls: Number.MAX_SAFE_INTEGER,
      maxTokenCount: Number.MAX_SAFE_INTEGER,
      maxCostUsd: Number.MAX_SAFE_INTEGER,
    },
    providerPricingInspection: pricing(),
  });
  assert.equal(priced.status, 'autonomous_research_launch_mode_ready');
  assert.equal(priced.effectiveBudgets.maxAgentCalls, 33);
  assert.equal(priced.effectiveBudgets.maxCostUsd, 100);
  assert.equal(priced.providerTokenUsageMetered, false);
  assert.equal(priced.tokenBudgetAssurance, 'prompt_only_not_a_hard_provider_limit');
});

test('production mode requires full readiness, known provider price, and a precomputed ceiling', () => {
  const missingCeiling = evaluateAutonomousResearchLaunchModeGate({
    launchMode: 'production-run',
    action: 'launch',
    budgets: {},
    providerPricingInspection: pricing(),
    fullResearchReadiness: FULL_READY,
  });
  assert.ok(missingCeiling.blockers.includes(
    'autonomous_research_production_cost_ceiling_required',
  ));

  const unknownPricing = evaluateAutonomousResearchLaunchModeGate({
    launchMode: 'production-run',
    action: 'launch',
    budgets: { maxCostUsd: 30, maxAgentCalls: 100 },
    providerPricingInspection: pricing(null, null),
    fullResearchReadiness: FULL_READY,
  });
  assert.ok(unknownPricing.blockers.includes(
    'autonomous_research_provider_pricing_required',
  ));

  const unqualified = evaluateAutonomousResearchLaunchModeGate({
    launchMode: 'production-run',
    action: 'launch',
    budgets: { maxCostUsd: 30, maxAgentCalls: 100 },
    providerPricingInspection: pricing(),
    fullResearchReadiness: { ...FULL_READY, campaignFullyQualified: false },
  });
  assert.ok(unqualified.blockers.includes(
    'autonomous_research_production_full_readiness_required',
  ));

  const fileSignerDowngrade = evaluateAutonomousResearchLaunchModeGate({
    launchMode: 'production-run',
    action: 'launch',
    budgets: { maxCostUsd: 30, maxAgentCalls: 100 },
    providerPricingInspection: pricing(),
    fullResearchReadiness: {
      ...FULL_READY,
      researchExecutionReleaseAttestorProductionReady: false,
    },
  });
  assert.ok(fileSignerDowngrade.blockers.includes(
    'autonomous_research_production_full_readiness_required',
  ));

  const reproducibilityDowngrade = evaluateAutonomousResearchLaunchModeGate({
    launchMode: 'production-run',
    action: 'launch',
    budgets: { maxCostUsd: 30, maxAgentCalls: 100 },
    providerPricingInspection: pricing(),
    fullResearchReadiness: {
      ...FULL_READY,
      runtimeImageReproducibilityReady: false,
    },
  });
  assert.ok(reproducibilityDowngrade.blockers.includes(
    'autonomous_research_production_full_readiness_required',
  ));

  const ready = evaluateAutonomousResearchLaunchModeGate({
    launchMode: 'production-run',
    action: 'launch',
    budgets: { maxCostUsd: 30, maxAgentCalls: 100 },
    providerPricingInspection: pricing(),
    fullResearchReadiness: FULL_READY,
  });
  assert.equal(ready.status, 'autonomous_research_launch_mode_ready');
  assert.equal(ready.maximumAffordableAgentCalls, 10);
  assert.equal(ready.effectiveBudgets.maxAgentCalls, 10);
});

test('direct production actions require runtime and qualification receipts to cover the full wall budget', () => {
  const base = {
    launchMode: 'production-run',
    action: 'launch',
    budgets: { maxWallTimeMs: 6 * 60 * 60 * 1000, maxCostUsd: 30, maxAgentCalls: 10 },
    providerPricingInspection: pricing(),
  };
  const staleRuntime = evaluateAutonomousResearchLaunchModeGate({
    ...base,
    fullResearchReadiness: {
      ...FULL_READY,
      runtimeImageReproducibility: {
        ...FULL_READY.runtimeImageReproducibility,
        remainingValidityMs: 16 * 60 * 1000,
      },
    },
  });
  assert.ok(staleRuntime.blockers.includes(
    'autonomous_research_runtime_receipt_validity_window_insufficient',
  ));
  assert.equal(staleRuntime.providerExecutionPermitted, false);

  const staleQualification = evaluateAutonomousResearchLaunchModeGate({
    ...base,
    action: 'resume',
    fullResearchReadiness: {
      ...FULL_READY,
      fullResearchQualification: {
        ...FULL_READY.fullResearchQualification,
        remainingValidityMs: 16 * 60 * 1000,
      },
    },
  });
  assert.ok(staleQualification.blockers.includes(
    'autonomous_research_qualification_receipt_validity_window_insufficient',
  ));
  assert.equal(staleQualification.storeMutationPermitted, false);

  const fresh = evaluateAutonomousResearchLaunchModeGate({
    ...base,
    action: 'converge',
    fullResearchReadiness: FULL_READY,
  });
  assert.equal(fresh.status, 'autonomous_research_launch_mode_ready');

  const longerThanMaximumReceipt = evaluateAutonomousResearchLaunchModeGate({
    ...base,
    budgets: { ...base.budgets, maxWallTimeMs: 24 * 60 * 60 * 1000 },
    fullResearchReadiness: FULL_READY,
  });
  assert.ok(longerThanMaximumReceipt.blockers.includes(
    'autonomous_research_runtime_receipt_validity_window_insufficient',
  ));
  assert.ok(longerThanMaximumReceipt.blockers.includes(
    'autonomous_research_qualification_receipt_validity_window_insufficient',
  ));
});

test('production resume fails closed when current provider price would shrink the persisted call envelope', () => {
  const gate = evaluateAutonomousResearchLaunchModeGate({
    launchMode: 'production-run',
    action: 'resume',
    budgets: { maxCostUsd: 100, maxAgentCalls: 100 },
    providerPricingInspection: pricing(10, 10),
    fullResearchReadiness: FULL_READY,
  });
  assert.equal(gate.status, 'autonomous_research_launch_mode_ready');
  assert.equal(gate.effectiveBudgets.maxAgentCalls, 10);
  assert.throws(() => requireExistingProductionPricingEnvelope({
    action: 'resume',
    existingCampaign: { spec: { budgets: { maxCostUsd: 100, maxAgentCalls: 100 } } },
    requestedBudgets: { maxCostUsd: 100, maxAgentCalls: 100 },
    launchModeGate: gate,
  }), /autonomous_research_production_provider_price_drift_exceeds_campaign_envelope/);

  assert.doesNotThrow(() => requireExistingProductionPricingEnvelope({
    action: 'resume',
    existingCampaign: { spec: { budgets: { maxCostUsd: 100, maxAgentCalls: 10 } } },
    requestedBudgets: { maxCostUsd: 100, maxAgentCalls: 10 },
    launchModeGate: gate,
  }));
});

function qualificationReceipt({
  issuedAt = '2026-07-16T00:00:00.000Z',
  expiresAt = '2026-07-17T00:00:00.000Z',
  campaignId = 'golden-campaign',
  paperId = 'golden-paper',
  campaignReleaseBundleHash = `sha256:${'b'.repeat(64)}`,
} = {}) {
  const payload = {
    version: 1,
    kind: 'FullResearchGoldenMicroCampaignQualificationReceipt',
    status: 'full_research_golden_micro_campaign_qualified',
    campaignId,
    paperId,
    campaignReleaseBundleHash,
    runtimeImageReproducibilityReceiptHash: `sha256:${'c'.repeat(64)}`,
    runtimeImageReproducibilityRequiredProfiles: ['python', 'pythonGpu', 'r'],
    runtimeImageReproducibilityDefinitionManifestHashes: {
      python: `sha256:${'d'.repeat(64)}`,
      pythonGpu: `sha256:${'e'.repeat(64)}`,
      r: `sha256:${'f'.repeat(64)}`,
    },
    issuedAt,
    expiresAt,
    externalActionPerformed: true,
  };
  return Object.freeze({
    ...payload,
    fullResearchQualificationReceiptHash: hashRecord(
      'FullResearchGoldenMicroCampaignQualificationReceipt',
      payload,
    ),
  });
}

test('qualification pointer publication is atomic, durable, and rejects the 24-hour boundary', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-qualification-pointer-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createFullResearchQualificationReceiptPointerRepository({ runtimeRoot });
  const receipt = qualificationReceipt();
  const lease = repository.tryAcquirePublicationLease({
    ownerId: 'qualification-pointer-test',
    now: new Date('2026-07-16T12:00:00.000Z'),
  });
  const publicationBinding = {
    lease,
    qualificationStateHash: `sha256:${'1'.repeat(64)}`,
    qualificationStateGeneration: 1,
    expectedRuntimeReceiptHash: receipt.runtimeImageReproducibilityReceiptHash,
    publisherFence: {
      scope: 'qualification-pointer-test',
      ownerId: lease.ownerId,
      leaseGeneration: lease.leaseGeneration,
    },
  };
  const publication = repository.publish({
    ...publicationBinding,
    receipt,
    now: new Date('2026-07-16T12:00:00.000Z'),
  });
  assert.equal(publication.atomicPublication, true);
  assert.equal(publication.environmentVariable, 'HEPTA_FULL_RESEARCH_QUALIFICATION_RECEIPT');
  assert.equal(fs.lstatSync(publication.qualificationReceiptPath).isSymbolicLink(), false);
  assert.equal(repository.read().receipt.fullResearchQualificationReceiptHash,
    receipt.fullResearchQualificationReceiptHash);
  assert.throws(() => repository.publish({
    ...publicationBinding,
    receipt,
    now: new Date('2026-07-17T00:00:00.000Z'),
  }), /full_research_qualification_pointer_receipt_expired/);
});

test('qualification pointer SQLite authority fences stale publishers and repairs a commit-before-mirror crash', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-qualification-pointer-cas-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const now = new Date('2026-07-16T12:00:00.000Z');
  const first = createFullResearchQualificationReceiptPointerRepository({ runtimeRoot });
  const contender = createFullResearchQualificationReceiptPointerRepository({ runtimeRoot });
  const stale = first.tryAcquirePublicationLease({ ownerId: 'pointer-owner-one', leaseMs: 1000, now });
  assert.equal(contender.tryAcquirePublicationLease({
    ownerId: 'pointer-owner-two', leaseMs: 1000, now,
  }), null);
  const replacementNow = new Date(now.getTime() + 1001);
  const replacement = contender.tryAcquirePublicationLease({
    ownerId: 'pointer-owner-two', leaseMs: 60_000, now: replacementNow,
  });
  const receipt = qualificationReceipt({
    issuedAt: replacementNow.toISOString(),
    expiresAt: new Date(replacementNow.getTime() + 60_000).toISOString(),
  });
  const publicationInput = (lease) => ({
    lease,
    receipt,
    qualificationStateHash: `sha256:${'2'.repeat(64)}`,
    qualificationStateGeneration: 2,
    expectedRuntimeReceiptHash: receipt.runtimeImageReproducibilityReceiptHash,
    publisherFence: {
      scope: 'qualification-pointer-test',
      ownerId: lease.ownerId,
      leaseGeneration: lease.leaseGeneration,
    },
    now: replacementNow,
  });
  assert.throws(() => first.publish(publicationInput(stale)), /qualification_pointer_lease_lost/);

  let crashed = false;
  const crashy = createFullResearchQualificationReceiptPointerRepository({
    runtimeRoot,
    afterAuthorityCommit() {
      if (!crashed) { crashed = true; throw new Error('simulated_commit_before_mirror_crash'); }
    },
  });
  assert.throws(() => crashy.publish(publicationInput(replacement)),
    /simulated_commit_before_mirror_crash/);
  assert.throws(() => contender.read(), /qualification_pointer_mirror_drift/);
  const reconciliation = contender.reconcileMirror();
  assert.equal(reconciliation.qualificationReceiptHash,
    receipt.fullResearchQualificationReceiptHash);
  assert.equal(contender.read().qualificationStateGeneration, 2);
  fs.rmSync(`${contender.databasePath}-wal`, { force: true });
  fs.rmSync(`${contender.databasePath}-shm`, { force: true });
  const directory = path.dirname(contender.databasePath);
  const beforeEntries = fs.readdirSync(directory).sort();
  const before = fs.statSync(contender.databasePath).mtimeMs;
  const mirrorBefore = fs.statSync(contender.qualificationReceiptPath).mtimeMs;
  assert.equal(contender.read().receipt.fullResearchQualificationReceiptHash,
    receipt.fullResearchQualificationReceiptHash);
  assert.equal(fs.statSync(contender.databasePath).mtimeMs, before);
  assert.equal(fs.statSync(contender.qualificationReceiptPath).mtimeMs, mirrorBefore);
  assert.deepEqual(fs.readdirSync(directory).sort(), beforeEntries);
  assert.equal(fs.existsSync(`${contender.databasePath}-wal`), false);
  assert.equal(fs.existsSync(`${contender.databasePath}-shm`), false);
});

function verifiedInspection(receipt) {
  return Object.freeze({
    version: 1,
    kind: 'FullResearchQualificationInspection',
    status: 'full_research_qualification_verified',
    ready: true,
    receiptAccepted: true,
    fullDomainVerificationReady: true,
    campaignId: receipt.campaignId,
    paperId: receipt.paperId,
    campaignReleaseBundleHash: receipt.campaignReleaseBundleHash,
    qualificationReceiptHash: receipt.fullResearchQualificationReceiptHash,
    blockers: Object.freeze([]),
  });
}

function qualificationAuthorityFixture({ launchMode = 'golden-bootstrap' } = {}) {
  const providerConfigurationHash = H(`provider:${launchMode}`);
  const sourceAuthorityHash = H(`intake-configuration:${launchMode}`);
  const datasetMounts = [Object.freeze({
    name: `dataset-${launchMode}`,
    source: `/datasets/${launchMode}`,
    readOnly: true,
    manifestHash: H(`dataset:${launchMode}`),
    licenseId: 'CC0-1.0',
    benchmarkFamily: 'ml_algorithm_benchmark',
  })];
  let intake;
  if (launchMode === 'golden-bootstrap') {
    const template = buildAutonomousResearchRecurringGoldenTemplate({
      templateId: 'global-qualification',
      epochDurationMs: 12 * 60 * 60 * 1000,
      objective: 'Qualify the recurring unattended research authority.',
      protocolFamily: 'ml_algorithm_benchmark',
      datasetMounts,
      providerConfigurationHash,
      revisionRounds: 1,
      refereeCount: 2,
    });
    intake = materializeAutonomousResearchRecurringGoldenIntake({
      template,
      now: new Date('2026-07-16T00:00:00.000Z'),
      sourceAuthorityHash,
    });
  } else {
    intake = buildAutonomousResearchMachineIntake({
      intakeId: 'intake:production-substitution',
      paperId: 'production-substitution',
      campaignId: 'autonomous-research:production-substitution',
      launchMode: 'production-run',
      objective: 'Verify that production qualification remains campaign local.',
      protocolFamily: 'ml_algorithm_benchmark',
      datasetMounts,
      budgets: {
        maxWallTimeMs: 60 * 60 * 1000,
        maxAgentCalls: 8,
        maxCpuJobs: 8,
        maxGpuJobs: 0,
        maxTokenCount: 10_000,
        maxCostUsd: 10,
        maxMemoryMiB: 2048,
      },
      providerConfigurationHash,
      revisionRounds: 1,
      refereeCount: 2,
      admissionCreatedAt: '2026-07-16T00:00:00.000Z',
    });
  }
  const admission = buildAutonomousResearchMachineIntakeAdmission({
    intake,
    sourceKind: launchMode === 'golden-bootstrap' ? 'recurring-golden' : 'machine',
    sourceAuthorityHash,
  });
  const preparation = Object.freeze({
    autonomousResearchLoopPreparationReportHash: H(`preparation:${launchMode}`),
    launchMode,
    autonomousResearchProviderConfigurationHash: providerConfigurationHash,
    autonomousResearchMachineIntakeAdmissionHash:
      admission.autonomousResearchMachineIntakeAdmissionHash,
    proposal: Object.freeze({
      machineProposedScientificClaimSetHash: H(`proposal:${launchMode}`),
    }),
    policyAuthorization: Object.freeze({
      autonomousResearchPolicyAuthorizationHash: H(`policy:${launchMode}`),
    }),
    seedBinding: Object.freeze({
      autonomousResearchSeedBindingHash: H(`seed:${launchMode}`),
    }),
  });
  const planPayload = Object.freeze({
    version: 4,
    kind: 'PaperCampaignPlan',
    campaignId: intake.campaignId,
    paperId: intake.paperId,
    autonomousResearchPreparation: preparation,
    autonomousResearchMachineIntake: intake,
    autonomousResearchMachineIntakeHash: intake.intakeHash,
    autonomousResearchMachineIntakeAdmission: admission,
    autonomousResearchMachineIntakeAdmissionHash:
      admission.autonomousResearchMachineIntakeAdmissionHash,
  });
  const campaignPlanHash = hashRecord('PaperCampaignPlan', planPayload);
  const releaseBinding = createAutonomousResearchReleaseBinding({
    campaignId: intake.campaignId,
    paperId: intake.paperId,
    campaignPlanHash,
    preparation,
    machineIntake: intake,
    machineIntakeAdmission: admission,
  });
  const campaignReleaseBundleHash = H(`release:${launchMode}`);
  const campaign = Object.freeze({
    campaignId: intake.campaignId,
    paperId: intake.paperId,
    status: 'completed',
    spec: Object.freeze({ ...planPayload, campaignPlanHash }),
  });
  const authority = Object.freeze({
    status: 'current_completed_release',
    campaignStatus: 'completed',
    packageNodeStatus: 'completed',
    campaignId: intake.campaignId,
    paperId: intake.paperId,
    campaignReleaseBundleHash,
    releaseBundle: Object.freeze({
      campaignId: intake.campaignId,
      paperId: intake.paperId,
      campaignPlanHash,
      campaignReleaseBundleHash,
      autonomousResearchReleaseBindingHash:
        releaseBinding.autonomousResearchReleaseBindingHash,
      autonomousResearchReleaseBinding: releaseBinding,
    }),
  });
  return Object.freeze({ campaign, authority, preparation, releaseBinding });
}

test('golden controller locally re-verifies current state before publishing and drift fails closed', async () => {
  const fixture = qualificationAuthorityFixture();
  const receipt = qualificationReceipt({
    campaignId: fixture.campaign.campaignId,
    paperId: fixture.campaign.paperId,
    campaignReleaseBundleHash: fixture.authority.campaignReleaseBundleHash,
  });
  const inspection = verifiedInspection(receipt);
  const authority = fixture.authority;
  const state = {
    ...authority,
    receipt,
    verifiedInspection: inspection,
    recovery: { status: 'qualification_verified' },
    generation: 1,
    autonomousExternalQualificationStateHash: `sha256:${'9'.repeat(64)}`,
  };
  const calls = [];
  const pointer = {
    kind: 'FullResearchQualificationReceiptPointerRepository',
    tryAcquirePublicationLease() {
      return { ownerId: 'golden-controller', leaseToken: 'golden-controller-token', leaseGeneration: 1 };
    },
    releasePublicationLease() { return true; },
    publish(input) {
      calls.push(['publish', input.receipt.fullResearchQualificationReceiptHash]);
      return { status: 'full_research_qualification_receipt_pointer_published' };
    },
  };
  const verifier = {
    kind: 'IndependentExternalResearchQualificationVerifier',
    async verifyLocally() {
      calls.push(['verify']);
      return inspection;
    },
  };
  const controller = createGoldenCampaignQualificationController({
    localQualificationVerifier: verifier,
    receiptPointerRepository: pointer,
  });
  const result = await controller.finalize({
    externalQualification: { status: 'qualification_external_service_verified', inspection },
    campaign: fixture.campaign,
    campaignReleaseAuthority: authority,
    preparation: fixture.preparation,
    qualificationStateStore: { readExternalQualificationState: () => state },
    evaluateEligibility: () => ({ fullAutomaticResearchWritingReady: true }),
  });
  assert.equal(result.status, 'golden_campaign_qualification_published');
  assert.deepEqual(calls.map(([name]) => name), ['verify', 'publish']);

  calls.length = 0;
  verifier.verifyLocally = async () => ({
    ...inspection,
    status: 'full_research_qualification_blocked',
    ready: false,
    blockers: ['golden_micro_campaign_code_worktree_identity_mismatch'],
  });
  const drifted = await controller.finalize({
    externalQualification: { status: 'qualification_cached_verified_locally', inspection },
    campaign: fixture.campaign,
    campaignReleaseAuthority: authority,
    preparation: fixture.preparation,
    qualificationStateStore: { readExternalQualificationState: () => state },
    evaluateEligibility: () => ({ fullAutomaticResearchWritingReady: false }),
  });
  assert.equal(drifted.status, 'golden_campaign_local_reverification_blocked');
  assert.deepEqual(calls, []);
});

test('global golden publication rejects production substitution and authority tampering', async () => {
  let publications = 0;
  let localVerifications = 0;
  const controller = createGoldenCampaignQualificationController({
    localQualificationVerifier: {
      kind: 'IndependentExternalResearchQualificationVerifier',
      async verifyLocally() { localVerifications += 1; return null; },
    },
    receiptPointerRepository: {
      kind: 'FullResearchQualificationReceiptPointerRepository',
      tryAcquirePublicationLease() { return null; },
      releasePublicationLease() { return true; },
      publish() { publications += 1; return null; },
    },
  });
  const production = qualificationAuthorityFixture({ launchMode: 'production-run' });
  const productionResult = await controller.finalize({
    externalQualification: { status: 'qualification_external_service_verified' },
    campaign: production.campaign,
    campaignReleaseAuthority: production.authority,
    preparation: production.preparation,
    qualificationStateStore: {
      readExternalQualificationState() {
        throw new Error('production_substitution_must_block_before_state_read');
      },
    },
    evaluateEligibility: () => ({ fullAutomaticResearchWritingReady: true }),
  });
  assert.equal(productionResult.status, 'golden_campaign_global_authority_blocked');
  assert.match(productionResult.blockers.join(','), /recurring_machine_intake_required/);

  const golden = qualificationAuthorityFixture();
  const {
    autonomousResearchGlobalGoldenQualificationAuthorityHash: _authorityHash,
    ...globalPayload
  } = golden.releaseBinding.globalGoldenQualificationAuthority;
  const tamperedGlobalPayload = Object.freeze({
    ...globalPayload,
    recurringGoldenTemplateHash: H('attacker-template'),
  });
  const tamperedGlobal = Object.freeze({
    ...tamperedGlobalPayload,
    autonomousResearchGlobalGoldenQualificationAuthorityHash: hashRecord(
      'AutonomousResearchGlobalGoldenQualificationAuthority',
      tamperedGlobalPayload,
    ),
  });
  const {
    autonomousResearchReleaseBindingHash: _releaseBindingHash,
    ...releaseBindingPayload
  } = golden.releaseBinding;
  const tamperedReleaseBindingPayload = Object.freeze({
    ...releaseBindingPayload,
    globalGoldenQualificationAuthorityHash:
      tamperedGlobal.autonomousResearchGlobalGoldenQualificationAuthorityHash,
    globalGoldenQualificationAuthority: tamperedGlobal,
  });
  const tamperedReleaseBinding = Object.freeze({
    ...tamperedReleaseBindingPayload,
    autonomousResearchReleaseBindingHash: hashRecord(
      'AutonomousResearchReleaseBinding',
      tamperedReleaseBindingPayload,
    ),
  });
  const tamperedAuthority = Object.freeze({
    ...golden.authority,
    releaseBundle: Object.freeze({
      ...golden.authority.releaseBundle,
      autonomousResearchReleaseBindingHash:
        tamperedReleaseBinding.autonomousResearchReleaseBindingHash,
      autonomousResearchReleaseBinding: tamperedReleaseBinding,
    }),
  });
  const tamperedResult = await controller.finalize({
    externalQualification: { status: 'qualification_external_service_verified' },
    campaign: golden.campaign,
    campaignReleaseAuthority: tamperedAuthority,
    preparation: golden.preparation,
    qualificationStateStore: { readExternalQualificationState: () => null },
    evaluateEligibility: () => ({ fullAutomaticResearchWritingReady: true }),
  });
  assert.equal(tamperedResult.status, 'golden_campaign_global_authority_blocked');
  assert.match(
    tamperedResult.blockers.join(','),
    /globalGoldenQualificationAuthorityHash_mismatch|current_release_authority_mismatch/,
  );
  assert.equal(localVerifications, 0);
  assert.equal(publications, 0);
});

test('composition blocks direct production before runtime state or live readiness', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-production-launch-gate-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'paper');
  const runtimeRoot = path.join(base, 'runtime');
  const readyInspector = () => ({ report: FULL_READY });
  await assert.rejects(() => composeAutonomousResearchCampaignAction({
    action: 'launch',
    paperId: 'implicit-mode-paper',
    root,
    runtimeRoot,
    environment: {},
    productionReadinessInspector: readyInspector,
  }), /autonomous_research_launch_mode_invalid:<empty>/);
  assert.equal(fs.existsSync(runtimeRoot), false);

  await assert.rejects(() => composeAutonomousResearchCampaignAction({
    action: 'launch',
    launchMode: 'production-run',
    paperId: 'production-paper',
    root,
    runtimeRoot,
    environment: {},
    productionReadinessInspector: readyInspector,
  }), /autonomous_research_production_readiness_authorization_required/);
  assert.equal(fs.existsSync(runtimeRoot), false);

  await assert.rejects(() => composeAutonomousResearchCampaignAction({
    action: 'launch',
    launchMode: 'production-run',
    paperId: 'production-paper',
    root,
    runtimeRoot,
    environment: {
      HEPTA_RESEARCH_AUTHOR_MAXIMUM_COST_PER_CALL_USD: '1',
      HEPTA_FORMAL_REVIEWER_MAXIMUM_COST_PER_CALL_USD: '1',
    },
    productionReadinessInspector: () => ({
      report: { ...FULL_READY, fullResearchQualificationReady: false },
    }),
  }), /autonomous_research_production_readiness_authorization_required/);
  assert.equal(fs.existsSync(runtimeRoot), false);
});

test('every direct production mutation is rejected before a live provider canary pair', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-production-live-canary-gate-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const requests = [];
  for (const action of ['launch', 'resume', 'converge']) {
    await assert.rejects(() => composeAutonomousResearchCampaignAction({
      action,
      launchMode: 'production-run',
      paperId: `production-live-canary-${action}`,
      root: path.join(base, 'paper'),
      runtimeRoot: path.join(base, 'runtime'),
      budgets: { maxCostUsd: 10 },
      environment: {
        HEPTA_RESEARCH_AUTHOR_MAXIMUM_COST_PER_CALL_USD: '1',
        HEPTA_FORMAL_REVIEWER_MAXIMUM_COST_PER_CALL_USD: '1',
      },
      productionReadinessInspector(input) {
        requests.push({ action, ...input });
        return { report: { ...FULL_READY, fullAutomaticResearchWritingReady: false } };
      },
    }), /autonomous_research_production_readiness_authorization_required/);
  }
  assert.deepEqual(requests, []);
  assert.equal(fs.existsSync(path.join(base, 'runtime')), false);
});

test('caller-created timestamps cannot bypass direct production authorization', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-production-trusted-clock-gate-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const trustedNow = new Date('2026-07-17T04:00:00.000Z');
  const observations = [];
  for (const action of ['launch', 'resume', 'converge']) {
    for (const createdAt of [
      '2025-01-01T00:00:00.000Z',
      '2099-01-01T00:00:00.000Z',
    ]) {
      await assert.rejects(() => composeAutonomousResearchCampaignAction({
        action,
        launchMode: 'production-run',
        paperId: `production-clock-${action}`,
        root: path.join(base, 'paper'),
        runtimeRoot: path.join(base, 'runtime'),
        createdAt,
        readinessClock: { now: () => trustedNow },
        budgets: { maxCostUsd: 10 },
        environment: {
          HEPTA_RESEARCH_AUTHOR_MAXIMUM_COST_PER_CALL_USD: '1',
          HEPTA_FORMAL_REVIEWER_MAXIMUM_COST_PER_CALL_USD: '1',
        },
        productionReadinessInspector(input) {
          observations.push({ action, createdAt, observedAt: input.now.toISOString() });
          return { report: { ...FULL_READY, fullAutomaticResearchWritingReady: false } };
        },
      }), /autonomous_research_production_readiness_authorization_required/);
    }
  }
  assert.deepEqual(observations, []);
  assert.equal(fs.existsSync(path.join(base, 'runtime')), false);
});
