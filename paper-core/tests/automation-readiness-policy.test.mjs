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

function readyInput() {
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
    researchExecutionReleaseAttestor: { ready: true, productionReady: true },
    runtimeImageReproducibility: { ready: true, blockers: [] },
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

test('automation-status keeps release-attestor verification behind an explicit live flag', () => {
  const source = fs.readFileSync(new URL('../bin/automation-status.mjs', import.meta.url), 'utf8');
  const packageDocument = JSON.parse(fs.readFileSync(
    new URL('../../package.json', import.meta.url),
    'utf8',
  ));
  assert.match(
    source,
    /activeReleaseAttestorVerification:\s*args\['live-release-attestor'\]\s*===\s*true/,
  );
  assert.doesNotMatch(source, /activeReleaseAttestorVerification:\s*true/);
  assert.doesNotMatch(source, /activeReleaseAttestorVerification:\s*false/);
  assert.match(
    packageDocument.scripts['automation:research-status'],
    /--live-provider-canary --live-release-attestor$/,
  );
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
    usage: 'automation-status [--json] [--root PATH] [--runtime-root PATH] [--require-full-research] [--require-fully-autonomous] [--live-provider-canary] [--live-release-attestor]',
    mutation: 'no-canonical-state-write',
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
