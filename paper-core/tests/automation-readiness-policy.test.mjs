import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  automationReadinessExitCode,
  evaluateAutomationReadiness,
  evaluateAutomationReadinessLevels,
} from '../../paper-application/automation/automation-readiness-policy.mjs';
import {
  createAutomationReadinessSideEffectLedger,
  inspectAutomationAgentProviders,
} from '../../paper-composition/automation/automation-readiness-runtime-probes.mjs';
import {
  deriveFullyAutonomousResearchSystemStatus,
  queryAutomationReadiness,
} from '../../paper-composition/automation/automation-readiness-query.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { probeOsSandbox } from '../../paper-adapters/runtime/sandbox-backend-probe.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  HEPTA_PAPER_COMMAND_REGISTRY,
} from '../src/command-registry.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createGpuScientificCampaignPromotionAuthorityVerifier,
} from '../../paper-adapters/automation/gpu-scientific-campaign-promotion-authority-verifier.mjs';
import {
  inspectPersistedCampaignResearchGpuScientificReleaseChain,
} from '../../paper-composition/automation/automation-readiness-research-assurance-authority-inspection.mjs';
import {
  blockGpuScientificInspectionSnapshot,
  gpuScientificInspectionMatchesResearchNode,
  inspectAutomationReadinessCanonicalAuthorityRows,
  sameGpuScientificInspectionSnapshot,
} from '../../paper-composition/automation/automation-readiness-gpu-scientific-snapshot-binding.mjs';
import {
  GPU_RELEASE_TIME,
  createGpuScientificCampaignReleaseFixture,
} from './support/gpu-scientific-campaign-release-fixture.mjs';

function readyInput() {
  const proofHash = `sha256:${'b'.repeat(64)}`;
  return {
    runtimes: {
      agent: {
        usable: true,
        researchAuthorConfigurationPreflightReady: true,
        formalReviewConfigurationIndependentPrincipalReady: true,
        researchAuthorProviderAvailable: true,
        formalReviewProviderAvailable: true,
      },
      python: { usable: true },
      latex: { usable: true },
      lean: { usable: true },
      gpu: { usable: true },
      gpuContainer: { usable: true },
      images: { pythonGpu: { usable: true } },
      sandbox: {
        usable: true,
        academicEmpiricalReady: true,
        academicEmpiricalReadinessReason: 'academic_empirical_dataset_access_ready',
      },
    },
    campaignQueryReady: true,
    nodeQueryReady: true,
    campaignStoreSchema: { status: 'scoped_schema_version_verified' },
    campaignStoreSchemaBlockers: [],
    operationalIntegrity: { queryReady: true, degraded: false },
    researchExecutionReleaseAttestor: {
      ready: true,
      productionReady: true,
      fullProductionReady: true,
    },
    runtimeImageReproducibility: { ready: true, blockers: [] },
    gpuScientificCapabilityProofInspection: {
      capabilities: {
        pde: {
          operationalProofReady: true,
          operationalReceiptHashes: [proofHash],
          productionQualificationReady: true,
          conformanceReceiptHashes: [proofHash],
        },
        deepLearning: {
          operationalProofReady: true,
          operationalReceiptHashes: [proofHash],
          productionQualificationReady: true,
          conformanceReceiptHashes: [proofHash],
        },
      },
    },
    fullResearchQualification: {
      ready: true,
      qualificationScope: 'bounded-capability-only-v1',
      genericContentCanaryVerified: true,
      independentHypothesisPriorArtReviewVerified: true,
      independentHypothesisPriorArtReceiptHash: `sha256:${'a'.repeat(64)}`,
      blockers: [],
    },
  };
}

test('readiness policy requires every independent runtime and qualification binding', () => {
  const ready = evaluateAutomationReadiness(readyInput());
  assert.equal(ready.fullAutomaticResearchWritingReady, true);
  assert.equal(ready.fullAutomaticResearchWritingStatus, 'full_automatic_research_writing_runtime_ready');
  assert.equal(automationReadinessExitCode(ready, { requireFullResearch: true }), 0);

  for (const mutate of [
    (input) => {
      input.runtimes.agent.formalReviewProviderAvailable = false;
      input.fullResearchQualification.ready = false;
    },
    (input) => { input.researchExecutionReleaseAttestor.ready = false; },
    (input) => { input.researchExecutionReleaseAttestor.productionReady = false; },
    (input) => { input.researchExecutionReleaseAttestor.fullProductionReady = false; },
    (input) => {
      input.runtimeImageReproducibility = {
        ready: false,
        blockers: ['runtime_reproducibility_source_content_hashes_incomplete:r'],
      };
    },
    (input) => { input.fullResearchQualification = { ready: false, blockers: ['qualification_missing'] }; },
    (input) => { input.fullResearchQualification.independentHypothesisPriorArtReviewVerified = false; },
    (input) => { input.fullResearchQualification.independentHypothesisPriorArtReceiptHash = 'invalid'; },
    (input) => { input.runtimes.sandbox.academicEmpiricalReady = false; },
    (input) => { input.runtimes.gpuContainer.usable = false; },
    (input) => {
      input.gpuScientificCapabilityProofInspection.capabilities.pde.operationalProofReady = false;
    },
    (input) => {
      input.gpuScientificCapabilityProofInspection.capabilities.pde.productionQualificationReady = false;
    },
    (input) => {
      input.gpuScientificCapabilityProofInspection.capabilities.deepLearning.operationalReceiptHashes = [];
    },
    (input) => {
      input.gpuScientificCapabilityProofInspection.capabilities.deepLearning.conformanceReceiptHashes = ['invalid'];
    },
  ]) {
    const input = structuredClone(readyInput());
    mutate(input);
    const blocked = evaluateAutomationReadiness(input);
    assert.equal(blocked.fullAutomaticResearchWritingReady, false);
    assert.equal(automationReadinessExitCode(blocked, { requireFullResearch: true }), 3);
    assert.ok(blocked.blockers.length > 0);
  }

  const reproducibilityBlockedInput = readyInput();
  reproducibilityBlockedInput.runtimeImageReproducibility = {
    ready: false,
    blockers: ['runtime_reproducibility_receipt_missing'],
  };
  const reproducibilityBlocked = evaluateAutomationReadiness(reproducibilityBlockedInput);
  assert.equal(reproducibilityBlocked.automationRuntimeReady, true);
  assert.equal(reproducibilityBlocked.fullAutomaticResearchWritingRuntimePreflightReady, false);
  assert.equal(reproducibilityBlocked.fullAutomaticResearchWritingReady, false);
  assert.ok(reproducibilityBlocked.blockers.includes('runtime_image_reproducibility_not_ready'));

  const gpuBlockedInput = readyInput();
  gpuBlockedInput.runtimes.images.pythonGpu.usable = false;
  const gpuBlocked = evaluateAutomationReadiness(gpuBlockedInput);
  assert.equal(gpuBlocked.automationRuntimeReady, true);
  assert.equal(gpuBlocked.gpuScientificRuntimeReady, false);
  assert.equal(gpuBlocked.fullAutomaticResearchWritingRuntimePreflightReady, false);
  assert.ok(gpuBlocked.blockers.includes('gpu_scientific_runtime_not_ready'));

  const legacyBooleanOnlyInput = readyInput();
  delete legacyBooleanOnlyInput.gpuScientificCapabilityProofInspection;
  legacyBooleanOnlyInput.gpuScientificOperationalProofReady = true;
  legacyBooleanOnlyInput.gpuScientificProductionQualificationReady = true;
  const legacyBooleanOnly = evaluateAutomationReadiness(legacyBooleanOnlyInput);
  assert.equal(legacyBooleanOnly.gpuScientificCapabilityProofsReady, false);
  assert.equal(legacyBooleanOnly.fullAutomaticResearchWritingRuntimePreflightReady, false);
  assert.ok(legacyBooleanOnly.blockers.includes('gpu_pde_operational_proof_not_ready'));
  assert.ok(legacyBooleanOnly.blockers.includes(
    'gpu_deep_learning_production_qualification_not_ready',
  ));

  const priorArtBlockedInput = readyInput();
  priorArtBlockedInput.fullResearchQualification.independentHypothesisPriorArtReviewVerified = false;
  const priorArtBlocked = evaluateAutomationReadiness(priorArtBlockedInput);
  assert.equal(priorArtBlocked.independentHypothesisPriorArtQualificationReady, false);
  assert.ok(priorArtBlocked.blockers.includes(
    'independent_hypothesis_prior_art_qualification_not_ready',
  ));
});

test('readiness exit codes distinguish runtime, store, degradation, and qualification', () => {
  const runtimeBlockedInput = readyInput();
  runtimeBlockedInput.runtimes.python.usable = false;
  assert.equal(automationReadinessExitCode(evaluateAutomationReadiness(runtimeBlockedInput)), 1);

  const storeBlockedInput = readyInput();
  storeBlockedInput.campaignQueryReady = false;
  assert.equal(automationReadinessExitCode(evaluateAutomationReadiness(storeBlockedInput)), 1);

  const degradedInput = readyInput();
  degradedInput.operationalIntegrity.degraded = true;
  assert.equal(automationReadinessExitCode(evaluateAutomationReadiness(degradedInput)), 2);

  const qualificationBlockedInput = readyInput();
  qualificationBlockedInput.fullResearchQualification = { ready: false, blockers: ['qualification_missing'] };
  const qualificationBlocked = evaluateAutomationReadiness(qualificationBlockedInput);
  assert.equal(automationReadinessExitCode(qualificationBlocked), 0);
  assert.equal(automationReadinessExitCode(qualificationBlocked, { requireFullResearch: true }), 3);
  assert.equal(automationReadinessExitCode(qualificationBlocked, {
    requireFullyAutonomous: true,
    fullyAutonomousResearchSystemReady: false,
  }), 4);
  assert.equal(automationReadinessExitCode(evaluateAutomationReadiness(readyInput()), {
    requireFullyAutonomous: true,
    fullyAutonomousResearchSystemReady: true,
  }), 0);
});

test('top-level readiness levels expose runtime, bounded, generic, and production semantics', () => {
  assert.deepEqual(evaluateAutomationReadinessLevels({
    runtimeReady: false,
    runtimeStatus: 'automation_plane_store_blocked',
    boundedProfileReady: true,
    genericCapabilityReady: true,
    formalSandboxRuntimeReady: true,
    dynamicFormalProjectClosureReady: true,
    submissionDispatcherReady: true,
  }), {
    version: 1,
    kind: 'AutomationReadinessLevels',
    status: 'automation_plane_store_blocked',
    runtimeReady: false,
    boundedProfileReady: false,
    configuredScopeReady: false,
    genericResearchReady: false,
    productionReady: false,
  });

  const boundedBlocked = evaluateAutomationReadinessLevels({ runtimeReady: true });
  assert.equal(boundedBlocked.status, 'automation_plane_bounded_profile_blocked');

  const genericBlocked = evaluateAutomationReadinessLevels({
    runtimeReady: true,
    boundedProfileReady: true,
  });
  assert.equal(genericBlocked.status, 'automation_plane_generic_research_blocked');

  const configuredScopeBlocked = evaluateAutomationReadinessLevels({
    runtimeReady: true,
    boundedProfileReady: true,
    genericCapabilityReady: true,
    formalSandboxRuntimeReady: true,
    dynamicFormalProjectClosureReady: true,
    submissionDispatcherReady: true,
  });
  assert.equal(configuredScopeBlocked.configuredScopeReady, false);
  assert.equal(configuredScopeBlocked.genericResearchReady, false);
  assert.equal(configuredScopeBlocked.productionReady, false);

  const formalSandboxBlocked = evaluateAutomationReadinessLevels({
    runtimeReady: true,
    boundedProfileReady: true,
    configuredScopeReady: true,
    genericCapabilityReady: true,
  });
  assert.equal(formalSandboxBlocked.status, 'automation_plane_generic_research_blocked');
  assert.equal(formalSandboxBlocked.genericResearchReady, false);

  const dynamicFormalClosureBlocked = evaluateAutomationReadinessLevels({
    runtimeReady: true,
    boundedProfileReady: true,
    configuredScopeReady: true,
    genericCapabilityReady: true,
    formalSandboxRuntimeReady: true,
    submissionDispatcherReady: true,
  });
  assert.equal(dynamicFormalClosureBlocked.status,
    'automation_plane_generic_research_blocked');
  assert.equal(dynamicFormalClosureBlocked.genericResearchReady, false);
  assert.equal(dynamicFormalClosureBlocked.productionReady, false);

  const productionBlocked = evaluateAutomationReadinessLevels({
    runtimeReady: true,
    boundedProfileReady: true,
    configuredScopeReady: true,
    genericCapabilityReady: true,
    formalSandboxRuntimeReady: true,
    dynamicFormalProjectClosureReady: true,
  });
  assert.equal(productionBlocked.status, 'automation_plane_production_blocked');
  assert.equal(productionBlocked.genericResearchReady, true);
  assert.equal(productionBlocked.productionReady, false);

  const productionReady = evaluateAutomationReadinessLevels({
    runtimeReady: true,
    boundedProfileReady: true,
    configuredScopeReady: true,
    genericCapabilityReady: true,
    formalSandboxRuntimeReady: true,
    dynamicFormalProjectClosureReady: true,
    autonomousSystemReady: true,
    submissionDispatcherReady: true,
  });
  assert.equal(productionReady.status, 'automation_plane_production_ready');
  assert.equal(productionReady.productionReady, true);

  const autonomousSystemBlocked = evaluateAutomationReadinessLevels({
    runtimeReady: true,
    boundedProfileReady: true,
    configuredScopeReady: true,
    genericCapabilityReady: true,
    formalSandboxRuntimeReady: true,
    dynamicFormalProjectClosureReady: true,
    autonomousSystemReady: false,
    submissionDispatcherReady: true,
  });
  assert.equal(
    autonomousSystemBlocked.status,
    'automation_plane_production_blocked',
  );
  assert.equal(autonomousSystemBlocked.genericResearchReady, true);
  assert.equal(autonomousSystemBlocked.productionReady, false);
});

test('fully autonomous status cannot inherit a ready core while production is blocked', () => {
  assert.equal(deriveFullyAutonomousResearchSystemStatus({
    readinessLevels: {
      status: 'automation_plane_production_blocked',
      productionReady: false,
    },
    coreStatus: 'generic_domain_autonomous_research_system_ready',
  }), 'automation_plane_production_blocked');
  assert.equal(deriveFullyAutonomousResearchSystemStatus({
    readinessLevels: {
      status: 'automation_plane_production_ready',
      productionReady: true,
    },
    coreStatus: 'generic_domain_autonomous_research_system_ready',
  }), 'generic_domain_autonomous_research_system_ready');
  assert.equal(deriveFullyAutonomousResearchSystemStatus({
    readinessLevels: {
      status: 'automation_plane_production_ready',
      productionReady: true,
    },
    coreStatus: 'bounded_profile_autonomous_research_system_ready',
  }), 'automation_plane_production_blocked');
});

test('readiness side-effect ledger rejects remote Docker before any process', () => {
  let spawnCount = 0;
  for (const environment of [
    { DOCKER_HOST: 'tcp://attacker.example:2375' },
    { DOCKER_CONTEXT: 'remote-production' },
  ]) {
    const ledger = createAutomationReadinessSideEffectLedger({
      environment,
      spawnSyncImpl() { spawnCount += 1; return { status: 0 }; },
    });
    let failure = null;
    try { ledger.assertEndpointPolicy(); } catch (error) { failure = error; }
    assert.match(failure?.message || '', /automation_readiness_remote_docker_endpoint_forbidden/);
    assert.equal(
      failure.automationReadinessSideEffectInspection.processActionCount,
      0,
    );
    assert.equal(
      failure.automationReadinessSideEffectInspection.endpointLocality.docker.remote,
      true,
    );
  }
  assert.equal(spawnCount, 0);
});

test('automation readiness query preserves structured failure inspection on endpoint rejection', () => {
  let spawnCount = 0;
  assert.throws(() => queryAutomationReadiness({
    root: '/not-observed-before-endpoint-policy',
    runtimeRoot: '/not-observed-before-endpoint-policy',
    environment: { DOCKER_CONTEXT: 'remote-production' },
    codeProvenance: {},
    spawnSyncImpl() { spawnCount += 1; return { status: 0 }; },
  }), (error) => {
    assert.match(error.message, /automation_readiness_remote_docker_endpoint_forbidden/);
    assert.equal(error.automationReadinessSideEffectInspection.processActionCount, 0);
    assert.equal(
      error.automationReadinessSideEffectInspection.endpointLocality.docker.remote,
      true,
    );
    return true;
  });
  assert.equal(spawnCount, 0);
});

test('automation readiness query completes a passive blocked report with exact side-effect accounting', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-readiness-query-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'assets');
  const runtimeRoot = path.join(base, 'runtime');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const store = createDefaultPaperStore({ root, runtimeRoot });
  store.close();

  const calls = [];
  const query = queryAutomationReadiness({
    root,
    runtimeRoot,
    environment: {},
    spawnSyncImpl(executable, args, options) {
      calls.push({ executable, args, options });
      return {
        status: 1,
        signal: null,
        stdout: '',
        stderr: 'simulated_unavailable',
      };
    },
    now: new Date('2026-07-17T00:00:00.000Z'),
  });

  assert.equal(query.exitCode, 1);
  assert.equal(query.report.version, 2);
  assert.equal(query.report.status, 'automation_plane_runtime_blocked');
  assert.equal(query.report.runtimeStatus, 'automation_plane_runtime_blocked');
  assert.equal(query.report.runtimeReady, false);
  assert.equal(query.report.boundedProfileReady, false);
  assert.equal(query.report.genericResearchReady, false);
  assert.equal(query.report.productionReady, false);
  assert.equal(
    query.report.boundedProfileReady,
    query.report.boundedProfileAutonomousResearchSystemReady,
  );
  assert.equal(query.report.productionReady, query.report.fullyAutonomousResearchSystemReady);
  assert.equal(
    query.report.fullyAutonomousResearchSystemStatus,
    query.report.status,
  );
  assert.equal(
    query.report.fullyAutonomousResearchCoreStatus,
    'autonomous_research_system_blocked',
  );
  assert.equal(query.report.fullAutomaticResearchWritingReady, false);
  assert.equal(query.report.formalSandboxRuntimeReady, false);
  assert.equal(query.report.dynamicFormalProjectClosureReady, false);
  assert.ok(query.report.dynamicFormalProjectClosure.blockers.includes(
    'dynamic_formal_project_root_required',
  ));
  assert.ok(query.report.fullyAutonomousResearchSystemBlockers.some((blocker) => (
    blocker.includes('formal_sandbox') || blocker.includes('trusted_formal_sandbox')
  )));
  assert.equal(query.report.externalActionPerformed, true);
  assert.equal(
    query.report.externalActionScope,
    query.report.readinessSideEffectInspection.externalActionScope,
  );
  assert.equal(
    query.report.readinessSideEffectInspection.processActionCount,
    calls.length,
  );
  assert.equal(
    query.report.readinessSideEffectInspection.failedProcessActionCount,
    calls.length,
  );
  assert.equal(
    query.report.readinessSideEffectInspection.releaseAttestorBackendProbeActionCount,
    0,
  );
  assert.equal(
    query.report.readinessSideEffectInspection.releaseAttestorSignerChallengeActionCount,
    0,
  );
  assert.equal(query.report.readinessSideEffectInspection.providerCanaryActionCount, 0);
  assert.equal(query.report.liveProviderCanaryRequested, false);
  assert.equal(query.report.liveReleaseAttestorVerificationRequested, false);
  assert.equal(query.report.autonomousStateSafety.statusReadOnly, true);
  assert.equal(query.report.autonomousStateSafety.externalActionPerformed, false);
  assert.equal(
    query.report.autonomousStateSafety.coveredWriterCount,
    AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length,
  );
  assert.equal(
    query.report.autonomousStateSafety.requiredWriterCount,
    AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length,
  );
  assert.equal(query.report.autonomousStateRestoreAuthorityConfigured, false);
  assert.equal(query.report.autonomousStateRestoreAuthorityConfigurationHash, null);
  assert.equal(query.report.autonomousStateOnlineAntiRollbackReady, false);
  assert.ok(query.report.fullyAutonomousResearchSystemBlockers.includes(
    'autonomous_research_online_anti_rollback_coordinator_deployment_not_ready',
  ));
  assert.ok(query.report.fullAutomaticResearchWritingBlockers.length > 0);
});

test('readiness query never infers campaign lineage from persisted GPU rows',
  (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-readiness-gpu-chain-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const root = path.join(base, 'assets');
    const runtimeRoot = path.join(base, 'runtime');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(runtimeRoot, { recursive: true });
    const campaignId = 'readiness-gpu-chain-campaign';
    const paperId = 'readiness-gpu-chain-paper';
    const observedAt = '2026-07-17T00:00:00.000Z';
    const planPayload = {
      version: 4,
      kind: 'PaperCampaignPlan',
      campaignId,
      paperId,
      autonomousResearchPreparation: { launchMode: 'production-run' },
      gpuScientificExecutionPlan: { status: 'persisted-plan-fixture' },
    };
    const plan = {
      ...planPayload,
      campaignPlanHash: hashRecord('PaperCampaignPlan', planPayload),
    };
    const researchResult = {
      version: 1,
      kind: 'CampaignResearchVerificationResult',
      status: 'campaign_research_verification_completed',
      campaignId,
      paperId,
      researchPromotionStatus: 'research_promotion_ready',
    };
    const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
    const store = createDefaultPaperStore({ root, runtimeRoot });
    const seeded = store.execute(`
INSERT INTO paper_campaigns(
  campaign_id,paper_id,status,max_rounds,spec_json,created_at,updated_at
) VALUES(
  ${quote(campaignId)},${quote(paperId)},'running',1,
  ${quote(JSON.stringify(plan))},${quote(observedAt)},${quote(observedAt)}
);
INSERT INTO campaign_nodes(
  node_id,campaign_id,kind,status,dependencies_json,spec_json,result_json,
  result_sha256,created_at,updated_at
) VALUES(
  ${quote(`${campaignId}:research`)},${quote(campaignId)},'research-verify',
  'completed','[]','{}',${quote(JSON.stringify(researchResult))},
  ${quote(hashRecord('PaperCampaignNodeResult', researchResult))},
  ${quote(observedAt)},${quote(observedAt)}
);`);
    assert.equal(seeded.ok, true, seeded.error);
    store.close();

    const query = queryAutomationReadiness({
      root,
      runtimeRoot,
      environment: {},
      spawnSyncImpl: () => ({
        status: 1,
        signal: null,
        stdout: '',
        stderr: 'simulated_unavailable',
      }),
      now: new Date(observedAt),
    });
    const assurance = query.report.autonomousResearchAssuranceAuthorityInspection;
    assert.equal(assurance.ready, false);
    assert.equal(assurance.gpuScientificReleaseChainInspection.ready, false);
    assert.deepEqual(
      assurance.gpuScientificReleaseChainInspection.blockers,
      ['gpu_scientific_persisted_lineage_required'],
    );
    assert.ok(assurance.blockers.includes(
      'gpu_scientific_persisted_lineage_required',
    ));
  });

test('readiness ignores later noncanonical research rows outside the current plan topology',
  async (t) => {
    const fixture = await createGpuScientificCampaignReleaseFixture(t, {
      campaignId: 'readiness-gpu-generation-binding',
      persistedProductionPlan: true,
    });
    const verifier = createGpuScientificCampaignPromotionAuthorityVerifier({
      trustStoreProvider: () => fixture.qualification.trustStore,
      clock: { now: () => new Date(GPU_RELEASE_TIME) },
    });
    const oldResearchNode = fixture.packageInput.researchVerifyNode;
    const canonicalResearchSpec = fixture.campaign.spec.nodes.find((node) => (
      node.nodeId === oldResearchNode.nodeId
    ));
    const canonicalGpuSpec = fixture.campaign.spec.nodes.find((node) => (
      node.nodeId === fixture.gpu.node.nodeId
    ));
    const canonicalFormalSpec = fixture.campaign.spec.nodes.find((node) => (
      node.kind === 'formal-verify' && node.sourceClosureTerminal === true
    ));
    const latestResearchResult = structuredClone(oldResearchNode.result);
    delete latestResearchResult.gpuScientificQualificationEvidence;
    delete latestResearchResult.gpuScientificCampaignExecutionResultHash;
    delete latestResearchResult.gpuScientificArtifactBodyArchiveManifestHash;
    delete latestResearchResult.gpuScientificCampaignQualificationEvidenceHash;
    const latestResearchRow = {
      campaign_id: fixture.campaign.campaignId,
      paper_id: fixture.campaign.paperId,
      campaign_status: 'running',
      campaign_revision: 1,
      spec_json: JSON.stringify(fixture.campaign.spec),
      node_id: `${oldResearchNode.nodeId}:latest`,
      node_kind: 'research-verify',
      node_status: 'completed',
      attempt_id: `${oldResearchNode.attemptId}:latest`,
      lease_generation: Number(oldResearchNode.leaseGeneration) + 1,
      round_index: canonicalResearchSpec.roundIndex + 1,
      node_revision: 99,
      dependencies_json: JSON.stringify([]),
      node_spec_json: JSON.stringify({
        nodeId: `${oldResearchNode.nodeId}:latest`,
        kind: 'research-verify',
        roundIndex: canonicalResearchSpec.roundIndex + 1,
        dependencies: [],
      }),
      result_json: JSON.stringify(latestResearchResult),
      result_sha256: hashRecord(
        'PaperCampaignNodeResult',
        latestResearchResult,
      ),
      updated_at: '2026-07-14T00:00:01.000Z',
    };
    const oldResearchRow = {
      campaign_id: fixture.campaign.campaignId,
      paper_id: fixture.campaign.paperId,
      campaign_status: 'running',
      campaign_revision: 1,
      spec_json: JSON.stringify(fixture.campaign.spec),
      node_id: oldResearchNode.nodeId,
      node_kind: 'research-verify',
      node_status: 'completed',
      attempt_id: oldResearchNode.attemptId,
      lease_generation: oldResearchNode.leaseGeneration,
      round_index: canonicalResearchSpec.roundIndex,
      node_revision: 8,
      dependencies_json: JSON.stringify(canonicalResearchSpec.dependencies),
      node_spec_json: JSON.stringify(canonicalResearchSpec),
      result_json: JSON.stringify(oldResearchNode.result),
      result_sha256: oldResearchNode.resultSha256,
      updated_at: '2026-07-14T00:00:00.000Z',
    };
    const gpuRow = {
      campaign_id: fixture.campaign.campaignId,
      paper_id: fixture.campaign.paperId,
      campaign_status: 'running',
      campaign_revision: 1,
      spec_json: JSON.stringify(fixture.campaign.spec),
      node_id: fixture.gpu.node.nodeId,
      node_kind: 'gpu-scientific-execution',
      node_status: 'completed',
      attempt_id: fixture.gpu.node.attemptId,
      lease_generation: fixture.gpu.node.leaseGeneration,
      round_index: canonicalGpuSpec.roundIndex,
      node_revision: 6,
      dependencies_json: JSON.stringify(canonicalGpuSpec.dependencies),
      node_spec_json: JSON.stringify(canonicalGpuSpec),
      result_json: JSON.stringify(fixture.gpu.node.result),
      result_sha256: fixture.gpu.node.resultSha256,
      updated_at: '2026-07-13T23:59:59.000Z',
    };
    const formalResult = { status: 'formal-fixture-completed' };
    const formalRow = {
      campaign_id: fixture.campaign.campaignId,
      paper_id: fixture.campaign.paperId,
      campaign_status: 'running',
      campaign_revision: 1,
      spec_json: JSON.stringify(fixture.campaign.spec),
      node_id: canonicalFormalSpec.nodeId,
      node_kind: canonicalFormalSpec.kind,
      node_status: 'completed',
      attempt_id: 'formal-fixture-attempt',
      lease_generation: 1,
      round_index: canonicalFormalSpec.roundIndex,
      node_revision: 5,
      dependencies_json: JSON.stringify(canonicalFormalSpec.dependencies),
      node_spec_json: JSON.stringify(canonicalFormalSpec),
      result_json: JSON.stringify(formalResult),
      result_sha256: hashRecord('PaperCampaignNodeResult', formalResult),
      updated_at: '2026-07-13T23:59:58.000Z',
    };
    const inspectRows = (rows) => (
      inspectPersistedCampaignResearchGpuScientificReleaseChain({
        store: {
          query(statement, parameters) {
            assert.match(statement, /gpu-scientific-execution/);
            assert.deepEqual(parameters, [fixture.campaign.campaignId]);
            return { ok: true, rows };
          },
        },
        campaignId: fixture.campaign.campaignId,
        paperId: fixture.campaign.paperId,
        gpuScientificPromotionAuthorityVerifier: verifier,
        runtimeRoot: fixture.runtimeRoot,
        now: new Date(GPU_RELEASE_TIME),
      })
    );
    const oldInspection = inspectRows([oldResearchRow, gpuRow, formalRow]);
    assert.equal(
      oldInspection.ready,
      true,
      JSON.stringify(oldInspection, null, 2),
    );
    assert.equal(oldInspection.researchNodeId, oldResearchRow.node_id);

    const inspection = inspectRows([
      latestResearchRow,
      oldResearchRow,
      gpuRow,
      formalRow,
    ]);
    assert.equal(inspection.ready, true, JSON.stringify(inspection, null, 2));
    assert.equal(inspection.researchNodeId, oldResearchRow.node_id);
    assert.equal(inspection.researchAttemptId, oldResearchRow.attempt_id);
    assert.equal(
      inspection.researchLeaseGeneration,
      oldResearchRow.lease_generation,
    );
    assert.equal(
      inspection.researchResultHash,
      oldResearchRow.result_sha256,
    );
  });

test('persisted GPU readiness requires explicit campaign and paper lineage before querying', () => {
  let queryCount = 0;
  const store = {
    query() {
      queryCount += 1;
      return { ok: true, rows: [] };
    },
  };
  for (const input of [
    { campaignId: null, paperId: 'lineage-paper' },
    { campaignId: 'lineage-campaign', paperId: null },
  ]) {
    const inspection = inspectPersistedCampaignResearchGpuScientificReleaseChain({
      store,
      ...input,
    });
    assert.equal(inspection.ready, false);
    assert.deepEqual(inspection.blockers, [
      'gpu_scientific_persisted_lineage_required',
    ]);
  }
  assert.equal(queryCount, 0);
});

test('real SQLite readiness fails closed on the current plan research node state',
  async (t) => {
    const fixture = await createGpuScientificCampaignReleaseFixture(t, {
      campaignId: 'readiness-gpu-sqlite-canonical-head',
      persistedProductionPlan: true,
    });
    const verifier = createGpuScientificCampaignPromotionAuthorityVerifier({
      trustStoreProvider: () => fixture.qualification.trustStore,
      clock: { now: () => new Date(GPU_RELEASE_TIME) },
    });
    const plan = fixture.campaign.spec;
    const researchSpec = plan.nodes.find((node) => node.kind === 'research-verify');
    const gpuSpec = plan.nodes.find((node) => node.kind === 'gpu-scientific-execution');
    const formalSpec = plan.nodes.find((node) => node.kind === 'formal-verify');
    const canonicalResearch = fixture.packageInput.researchVerifyNode;
    const staleNodeId = `${canonicalResearch.nodeId}:superseded`;
    const staleAttemptId = `${canonicalResearch.attemptId}:superseded`;
    const currentLeaseThreeResult = structuredClone(canonicalResearch.result);
    currentLeaseThreeResult.researchLeaseGeneration = 3;
    const staleSpec = {
      nodeId: staleNodeId,
      kind: 'research-verify',
      roundIndex: researchSpec.roundIndex - 1,
      dependencies: [...researchSpec.dependencies],
    };
    const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
    const sqlValue = (value) => value === null ? 'NULL' : quote(value);
    const cases = [
      {
        name: 'running', status: 'running', attemptId: 'current-running-attempt',
        leaseGeneration: 2, nodeRevision: 12, result: null, ready: false,
        staleLeaseGeneration: 99, staleNodeRevision: 99,
        staleUpdatedAt: '2026-08-15T00:00:00.000Z',
      },
      {
        name: 'failed-terminal', status: 'failed_terminal', attemptId: null,
        leaseGeneration: 3, nodeRevision: 13, result: null, ready: false,
        staleLeaseGeneration: 99, staleNodeRevision: 99,
        staleUpdatedAt: '2026-08-15T00:00:00.000Z',
      },
      {
        name: 'low-lease-later-touch', status: 'completed',
        attemptId: canonicalResearch.attemptId,
        leaseGeneration: 3,
        nodeRevision: 8, result: currentLeaseThreeResult, ready: true,
        staleStatus: 'completed', staleLeaseGeneration: 1,
        staleNodeRevision: 1, staleUpdatedAt: '2026-08-15T00:00:00.000Z',
      },
    ];
    for (const scenario of cases) {
      const root = path.join(fixture.root, `readiness-store-${scenario.name}`);
      fs.mkdirSync(root, { recursive: true });
      const store = createDefaultPaperStore({
        root,
        runtimeRoot: fixture.runtimeRoot,
        dbPath: path.join(root, 'hepta-paper.sqlite'),
      });
      const formalResult = { status: 'formal-fixture-completed' };
      const staleResearchResult = structuredClone(canonicalResearch.result);
      staleResearchResult.researchNodeId = staleNodeId;
      staleResearchResult.researchAttemptId = staleAttemptId;
      staleResearchResult.researchLeaseGeneration =
        scenario.staleLeaseGeneration;
      const currentResultJson = scenario.result
        ? JSON.stringify(scenario.result) : null;
      const currentResultHash = scenario.result
        ? hashRecord('PaperCampaignNodeResult', scenario.result) : null;
      const seeded = store.execute(`
INSERT INTO paper_campaigns(
  campaign_id,paper_id,status,max_rounds,spec_json,created_at,updated_at
) VALUES(
  ${quote(fixture.campaign.campaignId)},${quote(fixture.campaign.paperId)},
  'running',3,${quote(JSON.stringify(plan))},
  '2026-08-14T00:00:00.000Z','2026-08-14T00:00:00.000Z'
);
INSERT INTO campaign_nodes(
  node_id,campaign_id,kind,round_index,status,dependencies_json,spec_json,
  attempt_id,lease_generation,node_revision,result_json,result_sha256,
  created_at,updated_at
) VALUES
(${quote(researchSpec.nodeId)},${quote(fixture.campaign.campaignId)},
 'research-verify',${researchSpec.roundIndex},${quote(scenario.status)},
 ${quote(JSON.stringify(researchSpec.dependencies))},${quote(JSON.stringify(researchSpec))},
 ${sqlValue(scenario.attemptId)},${scenario.leaseGeneration},${scenario.nodeRevision},
 ${sqlValue(currentResultJson)},${sqlValue(currentResultHash)},
 '2026-08-14T00:00:00.000Z','2026-08-14T00:01:00.000Z'),
(${quote(staleNodeId)},${quote(fixture.campaign.campaignId)},
 'research-verify',${staleSpec.roundIndex},${quote(scenario.staleStatus || 'completed')},
 ${quote(JSON.stringify(staleSpec.dependencies))},${quote(JSON.stringify(staleSpec))},
 ${sqlValue(scenario.staleAttemptId || staleAttemptId)},
 ${scenario.staleLeaseGeneration},${scenario.staleNodeRevision},
 ${quote(JSON.stringify(staleResearchResult))},
 ${quote(hashRecord('PaperCampaignNodeResult', staleResearchResult))},
 '2026-08-13T00:00:00.000Z',${quote(scenario.staleUpdatedAt
    || '2026-08-13T00:01:00.000Z')}),
(${quote(gpuSpec.nodeId)},${quote(fixture.campaign.campaignId)},
 'gpu-scientific-execution',${gpuSpec.roundIndex},'completed',
 ${quote(JSON.stringify(gpuSpec.dependencies))},${quote(JSON.stringify(gpuSpec))},
 ${quote(fixture.gpu.node.attemptId)},${fixture.gpu.node.leaseGeneration},6,
 ${quote(JSON.stringify(fixture.gpu.node.result))},
 ${quote(fixture.gpu.node.resultSha256)},
 '2026-08-13T00:00:00.000Z','2026-08-13T00:01:00.000Z'),
(${quote(formalSpec.nodeId)},${quote(fixture.campaign.campaignId)},
 'formal-verify',${formalSpec.roundIndex},'completed',
 ${quote(JSON.stringify(formalSpec.dependencies))},${quote(JSON.stringify(formalSpec))},
 'formal-fixture-attempt',1,5,${quote(JSON.stringify(formalResult))},
 ${quote(hashRecord('PaperCampaignNodeResult', formalResult))},
 '2026-08-13T00:00:00.000Z','2026-08-13T00:01:00.000Z');`);
      assert.equal(seeded.ok, true, seeded.error);
      const inspection = inspectPersistedCampaignResearchGpuScientificReleaseChain({
        store,
        campaignId: fixture.campaign.campaignId,
        paperId: fixture.campaign.paperId,
        gpuScientificPromotionAuthorityVerifier: verifier,
        runtimeRoot: fixture.runtimeRoot,
        now: new Date(GPU_RELEASE_TIME),
      });
      assert.equal(inspection.ready, scenario.ready, JSON.stringify(inspection, null, 2));
      assert.equal(inspection.researchNodeId, researchSpec.nodeId);
      assert.equal(inspection.researchNodeStatus, scenario.status);
      if (!scenario.ready) assert.ok(inspection.blockers.includes(
        'gpu_scientific_research_canonical_node_not_completed',
      ));
      store.close();
    }
  });

test('outer assurance selects the plan-canonical formal dependency before receipt binding', () => {
  const formalOld = {
    nodeId: 'formal-old', kind: 'formal-verify', roundIndex: 1,
    dependencies: [],
  };
  const formalCurrent = {
    nodeId: 'formal-current', kind: 'formal-verify', roundIndex: 2,
    dependencies: [], sourceClosureTerminal: true,
  };
  const gpu = {
    nodeId: 'gpu-current', kind: 'gpu-scientific-execution', roundIndex: 2,
    dependencies: [],
  };
  const finalCompile = {
    nodeId: 'final-compile-current', kind: 'final-compile', roundIndex: 3,
    dependencies: [formalCurrent.nodeId],
    sourceClosureTerminal: true, sourceMutationPolicy: 'forbid',
  };
  const research = {
    nodeId: 'research-current', kind: 'research-verify', roundIndex: 3,
    dependencies: [
      formalOld.nodeId,
      formalCurrent.nodeId,
      gpu.nodeId,
      finalCompile.nodeId,
    ],
  };
  const packageNode = {
    nodeId: 'package-current', kind: 'release-package', roundIndex: 4,
    dependencies: [finalCompile.nodeId, research.nodeId],
  };
  const payload = {
    version: 4,
    kind: 'PaperCampaignPlan',
    campaignId: 'outer-canonical-campaign',
    paperId: 'outer-canonical-paper',
    gpuScientificExecutionPlan: { nodeId: gpu.nodeId },
    nodes: [
      formalOld,
      formalCurrent,
      gpu,
      finalCompile,
      research,
      packageNode,
    ],
  };
  const plan = {
    ...payload,
    campaignPlanHash: hashRecord('PaperCampaignPlan', payload),
  };
  const row = (node, status, revision) => ({
    campaign_id: plan.campaignId,
    paper_id: plan.paperId,
    node_id: node.nodeId,
    node_kind: node.kind,
    node_status: status,
    attempt_id: `${node.nodeId}:attempt`,
    round_index: node.roundIndex,
    lease_generation: 1,
    node_revision: revision,
    dependencies_json: JSON.stringify(node.dependencies),
    node_spec_json: JSON.stringify(node),
    result_json: JSON.stringify({ status: `${node.nodeId}:result` }),
    result_sha256: hashRecord(
      'PaperCampaignNodeResult', { status: `${node.nodeId}:result` },
    ),
  });
  const inspected = inspectAutomationReadinessCanonicalAuthorityRows(plan, [
    row(formalOld, 'completed', 50),
    row(formalCurrent, 'running', 2),
    row(gpu, 'completed', 3),
    row(research, 'completed', 4),
  ], { requireFormal: true });
  assert.equal(inspected.ready, false);
  assert.equal(inspected.formal.row.node_id, formalCurrent.nodeId);
  assert.ok(inspected.formal.blockers.includes(
    'autonomous_research_formal_canonical_node_not_completed',
  ));
});

test('canonical authority rejects hash-valid plans with ambiguous source-closure formal nodes', () => {
  const formalA = {
    nodeId: 'formal-terminal-a', kind: 'formal-verify', roundIndex: 2,
    dependencies: [], sourceClosureTerminal: true,
  };
  const formalB = {
    nodeId: 'formal-terminal-b', kind: 'formal-verify', roundIndex: 2,
    dependencies: [], sourceClosureTerminal: true,
  };
  const gpu = {
    nodeId: 'gpu-current', kind: 'gpu-scientific-execution', roundIndex: 2,
    dependencies: [],
  };
  const finalCompile = {
    nodeId: 'final-compile-current', kind: 'final-compile', roundIndex: 3,
    dependencies: [formalB.nodeId],
    sourceClosureTerminal: true, sourceMutationPolicy: 'forbid',
  };
  const research = {
    nodeId: 'research-current', kind: 'research-verify', roundIndex: 3,
    dependencies: [
      formalA.nodeId,
      formalB.nodeId,
      gpu.nodeId,
      finalCompile.nodeId,
    ],
  };
  const packageNode = {
    nodeId: 'package-current', kind: 'release-package', roundIndex: 4,
    dependencies: [finalCompile.nodeId, research.nodeId],
  };
  const payload = {
    version: 4,
    kind: 'PaperCampaignPlan',
    campaignId: 'ambiguous-formal-campaign',
    paperId: 'ambiguous-formal-paper',
    gpuScientificExecutionPlan: { nodeId: gpu.nodeId },
    nodes: [formalA, formalB, gpu, finalCompile, research, packageNode],
  };
  const plan = {
    ...payload,
    campaignPlanHash: hashRecord('PaperCampaignPlan', payload),
  };
  const row = (node) => ({
    campaign_id: plan.campaignId,
    paper_id: plan.paperId,
    node_id: node.nodeId,
    node_kind: node.kind,
    node_status: 'completed',
    attempt_id: `${node.nodeId}:attempt`,
    round_index: node.roundIndex,
    lease_generation: 1,
    node_revision: 1,
    dependencies_json: JSON.stringify(node.dependencies),
    node_spec_json: JSON.stringify(node),
  });
  const inspected = inspectAutomationReadinessCanonicalAuthorityRows(plan, [
    row(formalA),
    row(formalB),
    row(gpu),
    row(research),
  ], { requireFormal: true });

  assert.equal(inspected.ready, false);
  assert.equal(inspected.topology.formalNode, null);
  assert.ok(inspected.blockers.includes(
    'automation_readiness_canonical_plan_topology_invalid',
  ));
  assert.ok(inspected.blockers.includes(
    'campaign_release_formal_source_closure_invalid:package-current',
  ));

  const priorFormal = { ...formalA, sourceClosureTerminal: false };
  const detachedFinalCompile = { ...finalCompile, dependencies: [] };
  const detachedPayload = {
    ...payload,
    nodes: [
      priorFormal,
      formalB,
      gpu,
      detachedFinalCompile,
      research,
      packageNode,
    ],
  };
  const detachedPlan = {
    ...detachedPayload,
    campaignPlanHash: hashRecord('PaperCampaignPlan', detachedPayload),
  };
  const detached = inspectAutomationReadinessCanonicalAuthorityRows(
    detachedPlan,
    [row(priorFormal), row(formalB), row(gpu), row(research)],
    { requireFormal: true },
  );
  assert.equal(detached.ready, false);
  assert.ok(detached.blockers.includes(
    'campaign_release_final_compile_formal_source_closure_dependency_missing:'
      + 'package-current',
  ));
});

test('two-query GPU inspection snapshots cannot splice research generations', () => {
  const oldResult = Object.freeze({
    generation: 'old',
    researchNodeId: 'research-old',
    researchAttemptId: 'attempt-old',
    researchLeaseGeneration: 4,
  });
  const latestResult = Object.freeze({
    generation: 'latest',
    researchNodeId: 'research-latest',
    researchAttemptId: 'attempt-latest',
    researchLeaseGeneration: 5,
  });
  const oldNode = Object.freeze({
    node_id: 'research-old',
    attempt_id: 'attempt-old',
    lease_generation: 4,
    round_index: 4,
    node_revision: 9,
    node_status: 'completed',
    result_sha256: hashRecord('PaperCampaignNodeResult', oldResult),
  });
  const latestNode = Object.freeze({
    node_id: 'research-latest',
    attempt_id: 'attempt-latest',
    lease_generation: 5,
    round_index: 5,
    node_revision: 11,
    node_status: 'completed',
    result_sha256: hashRecord('PaperCampaignNodeResult', latestResult),
  });
  const oldInspection = Object.freeze({
    ready: true,
    campaignId: 'campaign-generation-snapshot',
    paperId: 'paper-generation-snapshot',
    researchNodeId: oldNode.node_id,
    researchAttemptId: oldNode.attempt_id,
    researchLeaseGeneration: oldNode.lease_generation,
    researchRoundIndex: oldNode.round_index,
    researchNodeRevision: oldNode.node_revision,
    researchNodeStatus: oldNode.node_status,
    researchResultHash: oldNode.result_sha256,
    nodeId: 'gpu-node',
    executionResultHash: hashRecord(
      'ReadinessGpuSnapshotFixture',
      { value: 'gpu-execution' },
    ),
    artifactArchiveManifestHash: hashRecord(
      'ReadinessGpuSnapshotFixture',
      { value: 'gpu-archive' },
    ),
    qualificationEvidenceHash: hashRecord(
      'ReadinessGpuSnapshotFixture',
      { value: 'gpu-qualification' },
    ),
    producerArchiveManifestHash: hashRecord(
      'ReadinessGpuSnapshotFixture',
      { value: 'gpu-archive' },
    ),
    gpuScientificCampaignQualificationAuthorityInspectionHash: hashRecord(
      'ReadinessGpuSnapshotFixture',
      { value: 'current-authority' },
    ),
    blockers: Object.freeze([]),
  });
  const latestInspection = Object.freeze({
    ...oldInspection,
    researchNodeId: latestNode.node_id,
    researchAttemptId: latestNode.attempt_id,
    researchLeaseGeneration: latestNode.lease_generation,
    researchRoundIndex: latestNode.round_index,
    researchNodeRevision: latestNode.node_revision,
    researchNodeStatus: latestNode.node_status,
    researchResultHash: latestNode.result_sha256,
  });
  assert.equal(
    gpuScientificInspectionMatchesResearchNode(
      oldInspection,
      oldNode,
      oldResult,
    ),
    true,
  );
  assert.equal(
    gpuScientificInspectionMatchesResearchNode(
      oldInspection,
      latestNode,
      latestResult,
    ),
    false,
  );
  assert.equal(
    sameGpuScientificInspectionSnapshot(oldInspection, latestInspection),
    false,
  );
  assert.equal(sameGpuScientificInspectionSnapshot(oldInspection, {
    ...oldInspection,
    gpuScientificCampaignQualificationAuthorityInspectionHash: hashRecord(
      'ReadinessGpuSnapshotFixture',
      { value: 'rotated-current-authority' },
    ),
  }), false);
  const blocked = blockGpuScientificInspectionSnapshot(latestInspection);
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blockers.includes(
    'gpu_scientific_release_chain_snapshot_mismatch',
  ));
});

test('handoff readiness can inspect an uninitialized store without weakening default status', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-readiness-missing-store-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'assets');
  const runtimeRoot = path.join(base, 'runtime');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });

  assert.throws(() => queryAutomationReadiness({
    root,
    runtimeRoot,
    environment: {},
    codeProvenance: {},
  }), /Read-only paper store missing/);

  const query = queryAutomationReadiness({
    root,
    runtimeRoot,
    environment: {},
    allowMissingStore: true,
    spawnSyncImpl() {
      return {
        status: 1,
        signal: null,
        stdout: '',
        stderr: 'simulated_unavailable',
      };
    },
    now: new Date('2026-07-28T00:00:00.000Z'),
    codeProvenance: {},
  });

  assert.equal(query.report.kind, 'AutomationPlaneStatus');
  assert.equal(query.report.productionReady, false);
  assert.equal(query.report.campaignStoreReady, false);
  assert.equal(query.report.operationalIntegrity.queryReady, false);
  assert.ok(query.report.operationalIntegrity.blockers.includes(
    'automation_store_quick_check_query_failed',
  ));
});

test('automation-status keeps release-attestor verification behind an explicit live flag', () => {
  const source = fs.readFileSync(new URL('../bin/automation-status.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /activeReleaseAttestorVerification:\s*args\['live-release-attestor'\]\s*===\s*true/,
  );
  assert.doesNotMatch(source, /activeReleaseAttestorVerification:\s*true/);
  assert.doesNotMatch(source, /activeReleaseAttestorVerification:\s*false/);
  assert.match(
    source,
    /activeFormalSandboxProbe:\s*args\['live-formal-sandbox-probe'\]\s*===\s*true/,
  );
  assert.doesNotMatch(source, /activeFormalSandboxProbe:\s*true/);
  const readinessRoute = HEPTA_PAPER_COMMAND_REGISTRY.operator['research-readiness'];
  assert.deepEqual(readinessRoute.argv.slice(-2), [
    '--live-provider-canary',
    '--live-release-attestor',
  ]);
});

test('automation-status help exits without performing readiness actions', () => {
  const run = spawnSync(process.execPath, [
    fileURLToPath(new URL('../bin/automation-status.mjs', import.meta.url)),
    '--json',
    '--help',
  ], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    version: 2,
    kind: 'AutomationStatusUsage',
    usage: 'automation-status [--json] [--handoff] [--deployment-environment-file PATH] [--root PATH] [--runtime-root PATH] [--require-full-research] [--require-fully-autonomous] [--live-formal-sandbox-probe] [--live-provider-canary] [--live-release-attestor]',
    mutation: 'formal probe qualification receipt only with --live-formal-sandbox-probe',
    localObservationEffects: 'runtime-metadata-and-daemon-probes-may-change',
    externalAction: 'argument-dependent',
  });
});

test('readiness side-effect ledger records controlled process, daemon, canary, KMS, and failure actions', () => {
  const calls = [];
  const ledger = createAutomationReadinessSideEffectLedger({
    environment: {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'https://ambient-proxy.example',
      SECRET_TOKEN: 'must-not-leak',
    },
    spawnSyncImpl(executable, args, options) {
      calls.push({ executable, args, options });
      if (executable === 'broken-runtime') throw new Error('simulated_spawn_failure');
      return { status: 0, signal: null, stdout: '', stderr: '' };
    },
  });
  const runtime = ledger.spawnSyncFor('runtime-sandbox');
  const provider = ledger.spawnSyncFor('provider-readiness');
  const release = ledger.spawnSyncFor('release-attestor');
  runtime('which', ['python3']);
  runtime('docker', ['image', 'inspect', 'runtime@sha256:test']);
  runtime('docker', ['run', '--rm', 'runtime@sha256:test']);
  runtime('docker', ['ps', '--all', '--filter', 'label=io.hepta.probe.kind=test']);
  runtime('docker', ['container', 'inspect', 'probe-container']);
  runtime('docker', ['rm', '--force', 'probe-container']);
  provider('codex', ['login', 'status']);
  provider('codex', ['exec', '--model', 'test-model']);
  release('/opt/kms/backend-probe', ['--probe']);
  let failure = null;
  try { runtime('broken-runtime', ['--version']); } catch (error) { failure = error; }
  const failedInspection = ledger.attachFailureInspection(failure, {
    releaseAttestorInspection: {
      backendProbeExternalActionAttempted: true,
      activeSignerChallengeExternalActionAttempted: true,
      researchExecutionReleaseAttestorConfigurationInspectionHash:
        `sha256:${'a'.repeat(64)}`,
    },
  }).automationReadinessSideEffectInspection;
  assert.equal(failedInspection.processActionCount, 10);
  assert.equal(failedInspection.failedProcessActionCount, 1);
  assert.equal(failedInspection.credentialStatusActionCount, 1);
  assert.equal(failedInspection.dockerDaemonActionCount, 5);
  assert.equal(failedInspection.dockerContainerActionCount, 4);
  assert.equal(failedInspection.providerCanaryActionCount, 1);
  assert.equal(failedInspection.releaseAttestorProcessActionCount, 1);
  assert.equal(failedInspection.releaseAttestorBackendProbeActionCount, 1);
  assert.equal(failedInspection.releaseAttestorSignerChallengeActionCount, 1);
  assert.equal(failedInspection.externalActionPerformed, true);
  assert.match(failedInspection.externalActionScope, /credential_status/);
  assert.match(failedInspection.externalActionScope, /docker_container_cleanup/);
  assert.match(failedInspection.externalActionScope, /docker_container_inspection/);
  assert.match(failedInspection.externalActionScope, /docker_container_probe/);
  assert.match(failedInspection.externalActionScope, /docker_container_reconciliation/);
  assert.match(failedInspection.externalActionScope, /docker_image_inspection/);
  assert.equal(calls[0].options.env.SECRET_TOKEN, undefined);
  assert.equal(calls[0].options.env.HTTPS_PROXY, undefined);
  assert.equal(calls[1].options.env.DOCKER_HOST, 'unix:///var/run/docker.sock');
});

test('Codex full-research provider inspection omits unrelated OpenClaw and Ollama probes', () => {
  const calls = [];
  const runtimes = {};
  inspectAutomationAgentProviders({
    runtimes,
    configuration: {
      formalReviewAgentId: null,
      formalReviewProvider: 'codex',
      researchAuthorCodexHome: null,
      researchAuthorModel: 'author-model',
      researchAuthorCodexBinary: 'codex',
      formalReviewCodexHome: null,
      formalReviewModel: 'reviewer-model',
      formalReviewCodexBinary: 'codex',
    },
    liveProviderCanaryRequested: false,
    legacyAgentFallbackProbesRequested: false,
    spawnSyncImpl(executable) {
      calls.push(executable);
      return { status: 1, signal: null, stdout: '', stderr: '' };
    },
    environment: {},
    canaryClock: { now: () => new Date('2026-07-17T00:00:00.000Z') },
  });
  assert.deepEqual(calls, []);
  assert.equal(runtimes.agent.legacyAgentFallbackProbesPerformed, false);
  assert.equal(runtimes.agent.researchDefaultProvider, 'codex');
});

test('sandbox probe rejects remote Docker before which, daemon, or container actions', () => {
  let spawnCount = 0;
  assert.throws(() => probeOsSandbox({
    refresh: true,
    environment: { DOCKER_HOST: 'ssh://remote.example' },
    spawnSyncImpl() { spawnCount += 1; return { status: 0 }; },
  }), /sandbox_remote_docker_endpoint_forbidden/);
  assert.equal(spawnCount, 0);
});

test('a cached qualification cannot substitute for live canaries when a direct provider action requires them', () => {
  for (const unavailableRoles of [
    ['researchAuthorProviderAvailable'],
    ['formalReviewProviderAvailable'],
    ['researchAuthorProviderAvailable', 'formalReviewProviderAvailable'],
  ]) {
    const cachedQualificationOnly = readyInput();
    for (const role of unavailableRoles) {
      cachedQualificationOnly.runtimes.agent[role] = false;
    }

    const passiveStatus = evaluateAutomationReadiness(cachedQualificationOnly);
    assert.equal(passiveStatus.fullAutomaticResearchWritingReady, true);
    assert.equal(passiveStatus.liveProviderCanaryRequired, false);

    const directProduction = evaluateAutomationReadiness({
      ...cachedQualificationOnly,
      liveProviderCanaryRequired: true,
    });
    assert.equal(directProduction.liveProviderCanaryReady, false);
    assert.equal(directProduction.fullAutomaticResearchWritingReady, false);
    assert.ok(directProduction.blockers.includes('qualified_provider_canaries_not_ready'));
    assert.equal(automationReadinessExitCode(directProduction, { requireFullResearch: true }), 3);
  }
});
