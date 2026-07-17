import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { prepareAutonomousResearchLoop } from '../../paper-application/automation/autonomous-research-readiness.mjs';
import {
  enqueuePreparedAutonomousResearchCampaign,
  executeAutonomousResearchCampaign,
} from '../../paper-application/automation/autonomous-research-campaign.mjs';
import {
  createAutonomousResearchSupervisor,
} from '../../paper-application/automation/autonomous-research-supervisor.mjs';
import {
  issueAutonomousResearchSupervisorDispatchAuthorization,
} from '../../paper-application/automation/autonomous-research-supervisor-dispatch-authorization.mjs';
import {
  createGoldenCampaignQualificationController,
} from '../../paper-application/automation/golden-campaign-qualification-controller.mjs';
import {
  createAutonomousResearchMachineIntakeRepository,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-repository.mjs';
import {
  buildAutonomousResearchMachineIntakeConfiguration,
  loadConfiguredAutonomousResearchMachineIntakes,
  readAutonomousResearchMachineIntakeConfiguration,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-loader.mjs';
import {
  createAutonomousResearchQualificationStateRepository,
} from '../../paper-adapters/automation/autonomous-research-qualification-state-repository.mjs';
import {
  createAutonomousResearchSupervisorStateRepository,
} from '../../paper-adapters/automation/autonomous-research-supervisor-state-repository.mjs';
import {
  createAutonomousResearchWorkspaceRepository,
} from '../../paper-adapters/automation/autonomous-research-workspace-repository.mjs';
import {
  materializeAutonomousResearchWorkspace,
} from '../../paper-adapters/automation/autonomous-research-workspace-materializer.mjs';
import {
  createFullResearchQualificationReceiptPointerRepository,
} from '../../paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import {
  createAutonomousResearchReleaseBinding,
} from '../../paper-domain/automation/autonomous-research-release-binding-contract.mjs';
import {
  buildAutonomousResearchRecurringGoldenTemplate,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  createFencedAutonomousResearchProviderCanary,
} from '../../paper-composition/automation/autonomous-research-supervisor-composition.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from '../../paper-composition/automation/autonomous-research-provider-configuration.mjs';
import {
  H,
  READY_EMPIRICAL_RUNTIME_CAPABILITY_INSPECTION,
  authorizedDatasetMount,
  fakeExecutor,
  principals,
  qualificationServiceIdentities,
  runtime,
  trustedDatasetAuthorityReceipt,
  verifiedQualificationInspection,
} from './autonomous-research-cold-start-e2e-support.mjs';
import {
  buildCanonicalAdmissionPreflightExecutionInspection,
} from './autonomous-research-supervisor-enqueue-test-support.mjs';

test('empty-runtime recurring intake survives restart and publishes only its bound Golden pointer', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-autonomous-cold-start-e2e-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'paper');
  const runtimeRoot = path.join(base, 'runtime');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const datasetMount = authorizedDatasetMount(runtimeRoot, 'cold-start-e2e-dataset');
  const providerConfiguration = resolveAutonomousResearchProviderConfiguration({ environment: {} });
  const providerConfigurationHash =
    providerConfiguration.autonomousResearchProviderConfigurationHash;
  const template = buildAutonomousResearchRecurringGoldenTemplate({
    templateId: 'cold-start-e2e',
    epochDurationMs: 12 * 60 * 60 * 1000,
    objective: 'Continuously verify the crash-recoverable autonomous research path.',
    protocolFamily: 'ml_algorithm_benchmark',
    datasetMounts: [datasetMount],
    providerConfigurationHash,
    revisionRounds: 1,
    refereeCount: 2,
  });
  const configuration = buildAutonomousResearchMachineIntakeConfiguration({
    recurringGoldenTemplates: [template],
    machineAppendEnabled: false,
  });
  const configPath = path.join(base, 'machine-intake.json');
  fs.writeFileSync(configPath, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  let observedAt = new Date('2026-07-15T12:00:00.000Z');
  const clock = {
    now: () => new Date(observedAt),
    nowIso: () => observedAt.toISOString(),
  };
  const supervisorScheduler = {
    async sleep() {}, setInterval() { return {}; }, clearInterval() {}, unref() {},
  };
  const opened = [];
  t.after(() => opened.reverse().forEach((value) => {
    try { value.close?.(); } catch { /* already closed to simulate a process crash */ }
  }));
  const openCampaignStore = () => {
    const store = createDefaultPaperStore({ root, runtimeRoot });
    opened.push(store);
    return { store, campaignStore: createSqliteCampaignStore({ store, clock }) };
  };
  const openMachineRepository = (configurationHash = configuration.configurationHash) => {
    const repository = createAutonomousResearchMachineIntakeRepository({
      runtimeRoot,
      authorizedSourceAuthorityHash: configurationHash,
    });
    opened.push(repository);
    return repository;
  };
  const machineIntakeServices = (repository, campaignStore) => ({
    repository,
    loadConfiguredIntakes({ now }) {
      const current = readAutonomousResearchMachineIntakeConfiguration({
        configPath,
        validateStaticContent: false,
      }).configuration;
      return loadConfiguredAutonomousResearchMachineIntakes({
        configuration: current,
        repository,
        now,
      });
    },
    async enqueueIntake({ intake, machineIntakeAdmission }) {
      const prepared = await prepareAutonomousResearchLoop({
        paperId: intake.paperId,
        objective: intake.objective,
        protocolFamily: intake.protocolFamily,
        ...principals(),
        datasetMounts: intake.datasetMounts,
        datasetAuthorityReceipt: trustedDatasetAuthorityReceipt(datasetMount),
        empiricalRuntimeCapabilityInspection: READY_EMPIRICAL_RUNTIME_CAPABILITY_INSPECTION,
        autonomousResearchProviderConfigurationHash: providerConfigurationHash,
        machineIntake: intake,
        machineIntakeAdmission,
        launchMode: intake.launchMode,
        revisionRounds: intake.revisionRounds,
        refereeCount: intake.refereeCount,
        createdAt: intake.admissionCreatedAt,
      });
      const workspaceRepository = createAutonomousResearchWorkspaceRepository({
        runtimeRoot,
        paperId: intake.paperId,
      });
      const materialization = materializeAutonomousResearchWorkspace({
        repository: workspaceRepository,
        loopPreparation: prepared,
        datasetMounts: intake.datasetMounts,
      });
      return enqueuePreparedAutonomousResearchCampaign({
        readinessReport: prepared,
        campaignId: intake.campaignId,
        datasetMounts: intake.datasetMounts,
        budgets: intake.budgets,
        campaignStore,
        preparedMaterialization: materialization,
        machineIntake: intake,
        machineIntakeAdmission,
        admissionPreflightExecutionInspection:
          buildCanonicalAdmissionPreflightExecutionInspection(),
      });
    },
  });

  const firstStore = openCampaignStore();
  const firstMachineRepository = openMachineRepository();
  const firstStateRepository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  opened.push(firstStateRepository);
  const firstSupervisor = createAutonomousResearchSupervisor({
    campaignStore: firstStore.campaignStore,
    stateRepository: firstStateRepository,
    machineIntake: machineIntakeServices(firstMachineRepository, firstStore.campaignStore),
    async reconcileRuntime() { return null; },
    async ensureRuntimeReproducibility() {
      return {
        ready: false,
        reason: 'cold_start_runtime_reproducibility_pending',
        deferUntil: new Date(observedAt.getTime() + 1000),
      };
    },
    async readQualificationState() { return null; },
    async runProviderCanary() { throw new Error('cold_start_gate_must_precede_canary'); },
    async renewQualification() { throw new Error('cold_start_gate_must_precede_renewal'); },
    async dispatchCampaign() { throw new Error('cold_start_gate_must_precede_dispatch'); },
    clock,
    scheduler: supervisorScheduler,
    ownerId: 'supervisor:cold-start-before-crash',
    pollMs: 1000,
    lifecyclePolicy: { maximumLifetimeMs: 60_000 },
  });
  const firstCycle = await firstSupervisor.runCycle();
  assert.equal(firstCycle.machineIntake.loaded.configurationHash, configuration.configurationHash);
  assert.equal(firstCycle.machineIntake.loaded.insertedCount, 1);
  assert.equal(firstCycle.machineIntake.results[0].status, 'machine_intake_enqueued',
    JSON.stringify(firstCycle.machineIntake.results[0]));
  const enqueuedRecord = firstMachineRepository.listEnqueuedIntakes()[0];
  const campaignId = enqueuedRecord.campaignId;
  assert.equal(enqueuedRecord.sourceKind, 'recurring-golden');
  assert.equal(firstStore.campaignStore.getCampaign(campaignId).spec
    .autonomousResearchMachineIntakeAdmission.sourceKind, 'recurring-golden');
  assert.equal(createFullResearchQualificationReceiptPointerRepository({ runtimeRoot }).read(), null);

  firstStateRepository.close();
  firstMachineRepository.close();
  firstStore.store.close();

  const replacementTemplate = buildAutonomousResearchRecurringGoldenTemplate({
    ...template,
    objective: 'Continuously verify an attacker-substituted configuration.',
  });
  const replacementConfiguration = buildAutonomousResearchMachineIntakeConfiguration({
    recurringGoldenTemplates: [replacementTemplate],
    machineAppendEnabled: false,
  });
  fs.writeFileSync(configPath, `${JSON.stringify(replacementConfiguration, null, 2)}\n`, {
    mode: 0o600,
  });
  assert.throws(() => openMachineRepository(replacementConfiguration.configurationHash),
    /configuration_authority_mismatch/);
  fs.writeFileSync(configPath, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });

  observedAt = new Date(observedAt.getTime() + 2000);
  const replacementStore = openCampaignStore();
  const replacementMachineRepository = openMachineRepository();
  const replacementStateRepository = createAutonomousResearchSupervisorStateRepository({
    runtimeRoot,
  });
  opened.push(replacementStateRepository);
  const pointerRepository = createFullResearchQualificationReceiptPointerRepository({ runtimeRoot });
  let providerCanaries = 0;
  const runProviderCanary = createFencedAutonomousResearchProviderCanary({
    stateRepository: replacementStateRepository,
    providerConfiguration,
    environment: {},
    clock,
    async providerCanaryRunner() {
      providerCanaries += 1;
      return {
        verified: true,
        providerCanaryPairReceiptHash: H('cold-start-e2e-provider-canary'),
      };
    },
  });
  const runtimeReceiptHash = H('cold-start-e2e-runtime');
  const fake = fakeExecutor();
  const pricedFakeExecutor = {
    async execute(input) {
      return Object.freeze({
        ...await fake.executor.execute(input),
        usage: Object.freeze({ totalTokens: 0, costUsd: 0 }),
      });
    },
  };
  const readPersistedQualificationState = async (campaign) => {
    const repository = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: campaign.paperId,
    });
    try {
      repository.reconcileStaleQualificationAttemptLease({ now: clock.now() });
      return repository.readExternalQualificationState();
    } finally { repository.close(); }
  };
  const replacementSupervisor = createAutonomousResearchSupervisor({
    campaignStore: replacementStore.campaignStore,
    stateRepository: replacementStateRepository,
    machineIntake: machineIntakeServices(
      replacementMachineRepository,
      replacementStore.campaignStore,
    ),
    async reconcileRuntime() { return null; },
    async ensureRuntimeReproducibility() {
      return {
        ready: true,
        receiptHash: runtimeReceiptHash,
        expiresAt: new Date(observedAt.getTime() + 2 * 60 * 60 * 1000).toISOString(),
        renewAt: new Date(observedAt.getTime() + 90 * 60 * 1000).toISOString(),
      };
    },
    readQualificationState: readPersistedQualificationState,
    runProviderCanary,
    async renewQualification() {
      return {
        ready: true,
        preReleaseExecutionAuthorized: true,
        reason: 'golden_bootstrap_requires_fresh_release',
      };
    },
    async dispatchCampaign({ action, campaign, supervisorDispatchEvidence }) {
      const qualificationStateStore = createAutonomousResearchQualificationStateRepository({
        runtimeRoot,
        paperId: enqueuedRecord.paperId,
      });
      const identities = qualificationServiceIdentities('cold-start-e2e');
      let currentAuthority = null;
      const receiptFor = () => {
        const preparation = replacementStore.campaignStore.getCampaign(campaignId)
          .spec.autonomousResearchPreparation;
        const payload = {
          version: 1,
          kind: 'FullResearchGoldenMicroCampaignQualificationReceipt',
          status: 'full_research_golden_micro_campaign_qualified',
          campaignId,
          paperId: enqueuedRecord.paperId,
          campaignReleaseBundleHash: currentAuthority.campaignReleaseBundleHash,
          runtimeImageReproducibilityReceiptHash: runtimeReceiptHash,
          runtimeImageReproducibilityRequiredProfiles: ['python', 'pythonGpu', 'r'],
          runtimeImageReproducibilityDefinitionManifestHashes: {
            python: H('cold-start-e2e-python'),
            pythonGpu: H('cold-start-e2e-python-gpu'),
            r: H('cold-start-e2e-r'),
          },
          proposalHash: preparation.proposal.machineProposedScientificClaimSetHash,
          policyAuthorizationHash:
            preparation.policyAuthorization.autonomousResearchPolicyAuthorizationHash,
          seedBindingHash: preparation.seedBinding.autonomousResearchSeedBindingHash,
          independentHypothesisPriorArtReviewVerified: true,
          independentHypothesisPriorArtReceiptHash: H('cold-start-e2e-prior-art'),
          signer: {
            keyId: 'external-kms:test',
            keyVersion: 'v1',
            subjectId: 'external-qualification:test',
            role: 'research_execution_release_attestor',
            algorithm: 'ed25519',
          },
          signature: 'external-kms-test-signature',
          issuedAt: observedAt.toISOString(),
          expiresAt: new Date(observedAt.getTime() + 60 * 60 * 1000).toISOString(),
          externalActionPerformed: true,
        };
        return Object.freeze({
          ...payload,
          fullResearchQualificationReceiptHash: hashRecord(
            'FullResearchGoldenMicroCampaignQualificationReceipt',
            payload,
          ),
        });
      };
      const inspectionFor = (receipt) => {
        const preparation = replacementStore.campaignStore.getCampaign(campaignId)
          .spec.autonomousResearchPreparation;
        return Object.freeze({
          ...verifiedQualificationInspection({
            campaignId,
            prepared: preparation,
            authority: currentAuthority,
            label: 'cold-start-e2e',
          }),
          qualificationReceiptHash: receipt.fullResearchQualificationReceiptHash,
        });
      };
      const verifier = {
        kind: 'IndependentExternalResearchQualificationVerifier',
        ...identities.verifier,
        async verify({ receipt }) { return inspectionFor(receipt); },
        async verifyLocally({ receipt }) { return inspectionFor(receipt); },
      };
      const client = {
        kind: 'ExternalResearchQualificationClient',
        ...identities.client,
        async requestQualification() { return receiptFor(); },
      };
      const goldenQualificationController = createGoldenCampaignQualificationController({
        localQualificationVerifier: verifier,
        receiptPointerRepository: pointerRepository,
        clock,
      });
      const residentLease = Object.freeze({
        ownerId: supervisorDispatchEvidence.campaignLease.ownerId,
        leaseToken: 'resident-lease:cold-start-e2e',
        leaseGeneration: 1,
        expiresAt: new Date(observedAt.getTime() + 10 * 60 * 1000).toISOString(),
      });
      const residentLeaseContext = Object.freeze({
        version: 1,
        kind: 'AutonomousResearchResidentLeaseContext',
        stage: 'before_campaign_dispatch',
        ownerId: residentLease.ownerId,
        leaseGeneration: residentLease.leaseGeneration,
        leaseExpiresAt: residentLease.expiresAt,
        lease: residentLease,
        assertCurrent() { return residentLease; },
      });
      const supervisorDispatchAuthorization =
        issueAutonomousResearchSupervisorDispatchAuthorization({
          campaignId,
          campaignPlanHash: campaign.spec.campaignPlanHash,
          launchMode: 'golden-bootstrap',
          action,
          providerConfigurationHash,
          campaignLease: supervisorDispatchEvidence.campaignLease,
          residentLeaseContext,
          providerCanaryState: supervisorDispatchEvidence.providerCanaryState,
          now: clock.now(),
          assertCampaignLease: ({ lease, now }) =>
            replacementStateRepository.assertCampaignLease({ lease, now }),
          readCampaignState: (id) => replacementStateRepository.getCampaign(id),
        });
      try {
        return await executeAutonomousResearchCampaign({
          action,
          campaignId,
          campaignStore: replacementStore.campaignStore,
          executor: pricedFakeExecutor,
          campaignReleaseAuthorityReader() {
            const completed = replacementStore.campaignStore.getCampaign(campaignId);
            const binding = createAutonomousResearchReleaseBinding({
              campaignId,
              paperId: completed.paperId,
              campaignPlanHash: completed.spec.campaignPlanHash,
              preparation: completed.spec.autonomousResearchPreparation,
              machineIntake: completed.spec.autonomousResearchMachineIntake,
              machineIntakeAdmission: completed.spec.autonomousResearchMachineIntakeAdmission,
            });
            currentAuthority = Object.freeze({
              status: 'current_completed_release',
              campaignStatus: 'completed',
              packageNodeStatus: 'completed',
              campaignId,
              paperId: completed.paperId,
              campaignReleaseBundleHash: H('cold-start-e2e-release'),
              releaseBundle: Object.freeze({
                campaignReleaseBundleHash: H('cold-start-e2e-release'),
                campaignPlanHash: completed.spec.campaignPlanHash,
                autonomousResearchReleaseBindingHash:
                  binding.autonomousResearchReleaseBindingHash,
                autonomousResearchReleaseBinding: binding,
                researchReport: {
                  promotionEligibility: { status: 'research_promotion_ready', blockers: [] },
                },
              }),
            });
            return currentAuthority;
          },
          externalQualificationClient: client,
          externalQualificationVerifier: verifier,
          qualificationStateStore,
          qualificationRetry: {
            maximumAttempts: 1,
            maximumEpochs: 1,
            initialBackoffMs: 0,
            epochCooldownMs: 0,
            deadlineMs: 5000,
          },
          goldenQualificationController,
          supervisorDispatchAuthorization,
          runtime: runtime(clock),
        });
      } finally { qualificationStateStore.close(); }
    },
    clock,
    scheduler: supervisorScheduler,
    ownerId: 'supervisor:cold-start-after-crash',
    pollMs: 1000,
    lifecyclePolicy: { maximumLifetimeMs: 60_000 },
  });
  const replacementCycle = await replacementSupervisor.runCycle();
  const settled = replacementCycle.results.find((result) => result.campaignId === campaignId);
  assert.equal(settled.status, 'settled', JSON.stringify(settled));
  assert.equal(settled.outcome.campaignFullyQualified, true);
  assert.equal(providerCanaries, 1);
  const pointer = pointerRepository.read();
  assert.equal(pointer.receipt.campaignId, campaignId);
  assert.equal(pointer.receipt.paperId, enqueuedRecord.paperId);
  assert.equal(replacementMachineRepository.readIntake(enqueuedRecord.intakeId)
    .sourceAuthorityHash, configuration.configurationHash);

  replacementStateRepository.close();
  replacementMachineRepository.close();
  replacementStore.store.close();
  const afterRestart = createFullResearchQualificationReceiptPointerRepository({ runtimeRoot }).read();
  assert.equal(afterRestart.receipt.campaignId, campaignId);
  assert.equal(afterRestart.qualificationStateGeneration, pointer.qualificationStateGeneration);
});
