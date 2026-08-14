import assert from 'node:assert/strict';
import test from 'node:test';
import {
  preflightAutonomousEmpiricalRuntimes,
} from '../../paper-adapters/automation/autonomous-empirical-runtime-preflight.mjs';
import {
  AUTOMATION_RUNTIME_IMAGES,
} from '../../paper-adapters/automation/runtime-image-registry.mjs';
import {
  inspectAutonomousEmpiricalRuntimeKernelExecutionBinding,
} from '../../paper-domain/automation/autonomous-empirical-runtime-kernel-execution-binding.mjs';
import {
  selectAutonomousEmpiricalExecutionProfile,
  verifyAutonomousEmpiricalExecutionProfileSelection,
  verifyAutonomousEmpiricalRuntimeCapabilityInspection,
} from '../../paper-domain/automation/autonomous-empirical-execution-profile-policy.mjs';
import {
  AUTONOMOUS_ANALYSIS_KERNEL_ABI,
  AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY,
  verifyAutonomousLanguageRuntimeKernelRegistry,
  verifyRuntimeReproducibilityInspectionForLanguageRuntimeRegistry,
} from '../../paper-domain/automation/autonomous-language-runtime-kernel-registry.mjs';
import {
  RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE,
} from '../../paper-domain/automation/runtime-image-reproducibility-receipt-contract.mjs';
import {
  buildCampaignBenchmarkSelector,
} from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import {
  buildAutonomousResearchCapabilityScopeManifest,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  executeCampaignEmpiricalNode,
} from '../../paper-application/automation/campaign-empirical-node-orchestrator.mjs';

const H = (label) => hashRecord('AutonomousRuntimeRegistryTestFixture', label);
const OBSERVED_AT = '2026-07-19T12:00:00.000Z';

function runtimeInspection() {
  return preflightAutonomousEmpiricalRuntimes({
    spawnSyncImpl(_command, args) {
      const runtime = Object.values(AUTOMATION_RUNTIME_IMAGES)
        .find((candidate) => candidate.image === args[2]);
      if (!runtime) return { status: 1, stdout: '' };
      return {
        status: 0,
        stdout: JSON.stringify([{
          Id: H('legacy-id'),
          Descriptor: {
            digest: runtime.imageDigest,
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
          },
          Os: 'linux',
          Architecture: 'amd64',
        }]),
      };
    },
  });
}

function reproducibilityInspection(overrides = {}) {
  const profiles = RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.requiredProfiles;
  return Object.freeze({
    version: 2,
    kind: 'RuntimeImageReproducibilityReceiptInspection',
    status: 'runtime_image_reproducibility_verified',
    ready: true,
    receiptAccepted: true,
    receiptHash: H('qualified-runtime-receipt'),
    issuedAt: '2026-07-19T11:00:00.000Z',
    expiresAt: '2026-07-20T11:00:00.000Z',
    remainingValidityMs: 24 * 60 * 60 * 1000,
    requiredProfiles: profiles,
    empiricalFamilyPluginPackageHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .empiricalFamilyPluginPackageHash,
    empiricalFamilyPluginRegistryHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .empiricalFamilyPluginRegistryHash,
    empiricalFamilyPluginStartupInspectionHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .empiricalFamilyPluginStartupInspectionHash,
    activeProductionProfileHashes:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.activeProductionProfileHashes,
    runtimeImageReproducibilityActivePluginScopeHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .runtimeImageReproducibilityActivePluginScopeHash,
    definitionManifestHashes: Object.freeze(Object.fromEntries(
      profiles.map((profile) => [profile, H(`definition:${profile}`)]),
    )),
    inputClosureHashes: Object.freeze(Object.fromEntries(
      profiles.map((profile) => [profile, H(`closure:${profile}`)]),
    )),
    registeredImageDigests: Object.freeze(Object.fromEntries(
      profiles.map((profile) => [profile, AUTOMATION_RUNTIME_IMAGES[profile].imageDigest]),
    )),
    privateSigningKeyLoadedByController: false,
    twoIndependentExternalVerifiersRequired: true,
    ociIndexManifestConfigAndLayerBlobDigestsCompared: true,
    canonicalContextTarMetadataPolicyRequired: true,
    canonicalContextTarMetadataAttested: true,
    blockers: Object.freeze([]),
    ...overrides,
  });
}

function rehashCapabilityInspection(value, mutate) {
  const {
    autonomousEmpiricalRuntimeCapabilityInspectionHash: _hash,
    ...payload
  } = structuredClone(value);
  mutate(payload);
  return Object.freeze({
    ...payload,
    autonomousEmpiricalRuntimeCapabilityInspectionHash:
      hashRecord('AutonomousEmpiricalRuntimeCapabilityInspection', payload),
  });
}

function rehashSelection(value, mutate) {
  const {
    autonomousEmpiricalExecutionProfileSelectionHash: _hash,
    ...payload
  } = structuredClone(value);
  mutate(payload);
  return Object.freeze({
    ...payload,
    autonomousEmpiricalExecutionProfileSelectionHash:
      hashRecord('AutonomousEmpiricalExecutionProfileSelection', payload),
  });
}

test('empirical registry binds language, toolchain, image digest, kernel ABI, and plugins', () => {
  const registry = AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY;
  assert.equal(verifyAutonomousLanguageRuntimeKernelRegistry(registry), true);
  assert.equal(registry.scope, 'empirical-analysis-python-r-only-v1');
  assert.equal(registry.formalAndManuscriptRuntimesCovered, false);
  assert.deepEqual(registry.languages, ['python', 'r']);
  assert.equal(registry.analysisKernelAbiHash, AUTONOMOUS_ANALYSIS_KERNEL_ABI.analysisKernelAbiHash);
  for (const entry of registry.entries) {
    assert.match(entry.imageManifestDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(entry.toolchainIdentityHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(entry.analysisKernelAbiHash, registry.analysisKernelAbiHash);
    assert.ok(entry.allowedEmpiricalPluginProfiles.length > 0);
    assert.equal(entry.runtimeFallbackAllowed, false);
  }
  const manifest = buildAutonomousResearchCapabilityScopeManifest({
    empiricalFamilies: ['ml_algorithm_benchmark'],
  });
  assert.equal(manifest.empiricalRuntimeRegistryScope,
    'empirical-analysis-python-r-only-v1');
  assert.equal(manifest.formalAndManuscriptRuntimeQualificationCoveredByEmpiricalRegistry,
    false);
  assert.equal(manifest.empiricalLanguageRuntimeKernelRegistryHash,
    registry.autonomousLanguageRuntimeKernelRegistryHash);
});

test('strong selection consumes runtime preflight and external reproducibility qualification', () => {
  const runtime = runtimeInspection();
  const reproducibility = reproducibilityInspection();
  assert.equal(verifyAutonomousEmpiricalRuntimeCapabilityInspection(runtime, {
    requireRegisteredRuntime: true,
  }), true);
  assert.equal(verifyRuntimeReproducibilityInspectionForLanguageRuntimeRegistry(
    reproducibility,
    { now: OBSERVED_AT },
  ), true);
  assert.equal(verifyRuntimeReproducibilityInspectionForLanguageRuntimeRegistry(
    reproducibility,
  ), false);
  const selection = selectAutonomousEmpiricalExecutionProfile({
    protocolFamily: 'ml_algorithm_benchmark',
    runtimeCapabilityInspection: runtime,
    runtimeReproducibilityInspection: reproducibility,
    requireRegisteredRuntime: true,
    observedAt: OBSERVED_AT,
  });
  assert.equal(selection.status, 'autonomous_empirical_execution_profile_ready');
  assert.equal(selection.registeredRuntimeRequired, true);
  assert.equal(selection.runtimeRegistryBindingVerified, true);
  assert.equal(verifyAutonomousEmpiricalExecutionProfileSelection(selection, {
    protocolFamily: 'ml_algorithm_benchmark',
    requireReady: true,
    runtimeCapabilityInspection: runtime,
    requireRuntimeCapabilityInspection: true,
    runtimeReproducibilityInspection: reproducibility,
    requireRegisteredRuntime: true,
    observedAt: OBSERVED_AT,
  }), true);

  const forgedRuntime = rehashCapabilityInspection(runtime, (payload) => {
    payload.languages.python.toolchainIdentityHash = H('forged-toolchain');
  });
  assert.equal(verifyAutonomousEmpiricalRuntimeCapabilityInspection(forgedRuntime, {
    requireRegisteredRuntime: true,
  }), false);
  const forgedSelection = rehashSelection(selection, (payload) => {
    payload.analysisKernelAbiHash = H('forged-kernel');
  });
  assert.equal(verifyAutonomousEmpiricalExecutionProfileSelection(forgedSelection, {
    protocolFamily: 'ml_algorithm_benchmark',
    requireReady: true,
    runtimeCapabilityInspection: runtime,
    requireRuntimeCapabilityInspection: true,
    runtimeReproducibilityInspection: reproducibility,
    requireRegisteredRuntime: true,
    observedAt: OBSERVED_AT,
  }), false);
  assert.equal(verifyRuntimeReproducibilityInspectionForLanguageRuntimeRegistry(
    reproducibilityInspection({
      registeredImageDigests: { ...reproducibility.registeredImageDigests, python: H('wrong') },
    }),
    { now: OBSERVED_AT },
  ), false);
});

test('production execution binding rejects unknown language, expired receipt, and ABI downgrade', () => {
  const runtime = runtimeInspection();
  const reproducibility = reproducibilityInspection();
  const selection = selectAutonomousEmpiricalExecutionProfile({
    protocolFamily: 'ml_algorithm_benchmark',
    runtimeCapabilityInspection: runtime,
    runtimeReproducibilityInspection: reproducibility,
    requireRegisteredRuntime: true,
    observedAt: OBSERVED_AT,
  });
  const benchmarkSelector = buildCampaignBenchmarkSelector({
    benchmarkId: 'ml_algorithm_benchmark',
  });
  const base = {
    launchMode: 'production-run',
    protocolFamily: 'ml_algorithm_benchmark',
    language: 'python',
    datasetMounts: [],
    benchmarkSelector,
    empiricalExecutionProfileSelection: selection,
    empiricalRuntimeCapabilityInspection: runtime,
    runtimeImageReproducibilityInspection: reproducibility,
    observedAt: OBSERVED_AT,
  };
  const bound = inspectAutonomousEmpiricalRuntimeKernelExecutionBinding(base);
  assert.equal(bound.ready, true);
  assert.equal(bound.status, 'autonomous_empirical_runtime_kernel_execution_bound');
  assert.equal(bound.declarationAloneTreatedAsRuntimeQualification, false);

  const unknown = inspectAutonomousEmpiricalRuntimeKernelExecutionBinding({
    ...base,
    language: 'julia',
  });
  assert.equal(unknown.ready, false);
  assert.ok(unknown.blockers.includes('autonomous_empirical_execution_runtime_unregistered'));

  const expired = inspectAutonomousEmpiricalRuntimeKernelExecutionBinding({
    ...base,
    observedAt: '2026-07-21T00:00:00.000Z',
  });
  assert.equal(expired.ready, false);
  assert.ok(expired.blockers.includes(
    'autonomous_empirical_execution_reproducibility_receipt_invalid',
  ));

  const downgraded = inspectAutonomousEmpiricalRuntimeKernelExecutionBinding({
    ...base,
    empiricalExecutionProfileSelection: rehashSelection(selection, (payload) => {
      payload.registeredRuntimeRequired = false;
      payload.runtimeRegistryQualificationBinding = null;
      payload.runtimeRegistryQualificationBindingHash = null;
    }),
  });
  assert.equal(downgraded.ready, false);
  assert.ok(downgraded.blockers.includes(
    'autonomous_empirical_execution_profile_registry_binding_invalid',
  ));
});

test('bounded golden remains compatible without external runtime qualification', () => {
  const runtime = runtimeInspection();
  const selection = selectAutonomousEmpiricalExecutionProfile({
    protocolFamily: 'ml_algorithm_benchmark',
    runtimeCapabilityInspection: runtime,
  });
  assert.equal(selection.status, 'autonomous_empirical_execution_profile_ready');
  assert.equal(selection.registeredRuntimeRequired, false);
  assert.equal(selection.runtimeRegistryQualificationBinding, null);
  for (const language of ['node', 'julia']) {
    const binding = inspectAutonomousEmpiricalRuntimeKernelExecutionBinding({
      launchMode: 'golden-bootstrap',
      language,
    });
    assert.equal(binding.ready, true);
    assert.equal(binding.required, false);
    assert.equal(binding.status, 'autonomous_empirical_runtime_kernel_execution_not_required');
  }
});

test('production node guard blocks ABI, digest, Node, and Julia downgrades before providers', async () => {
  const runtime = runtimeInspection();
  const reproducibility = reproducibilityInspection();
  const selection = selectAutonomousEmpiricalExecutionProfile({
    protocolFamily: 'ml_algorithm_benchmark',
    runtimeCapabilityInspection: runtime,
    runtimeReproducibilityInspection: reproducibility,
    requireRegisteredRuntime: true,
    observedAt: OBSERVED_AT,
  });
  const abiDowngrade = rehashSelection(selection, (payload) => {
    payload.analysisKernelAbiHash = H('downgraded-analysis-kernel-abi');
  });
  const digestDowngrade = rehashCapabilityInspection(runtime, (payload) => {
    payload.languages.python.observedDigest = H('unqualified-python-image');
    payload.languages.python.exactDigestVerified = false;
    payload.languages.python.available = false;
    payload.unavailableLanguages = ['python'];
    payload.status = 'autonomous_empirical_runtime_capability_partial_or_blocked';
  });
  const cases = [
    {
      name: 'analysis-kernel ABI',
      language: 'python',
      runtimeCapabilityInspection: runtime,
      executionProfileSelection: abiDowngrade,
      expectedBlocker: 'autonomous_empirical_execution_profile_registry_binding_invalid',
    },
    {
      name: 'runtime image digest',
      language: 'python',
      runtimeCapabilityInspection: digestDowngrade,
      executionProfileSelection: selection,
      expectedBlocker: 'autonomous_empirical_execution_runtime_identity_mismatch',
    },
    ...['node', 'julia'].map((language) => ({
      name: `${language} runtime`,
      language,
      runtimeCapabilityInspection: runtime,
      executionProfileSelection: selection,
      expectedBlocker: 'autonomous_empirical_execution_runtime_unregistered',
    })),
  ];
  for (const candidate of cases) {
    let agentExecuteCalls = 0;
    let empiricalExecuteCalls = 0;
    let datasetChecks = 0;
    await assert.rejects(() => executeCampaignEmpiricalNode({
      primitives: {
        workspace: {
          findEmpiricalEntrypoint: () => `analysis.${candidate.language}`,
          outputDirectory: () => '/tmp/hepta-runtime-downgrade-test-output',
          hashFile: () => H(`source:${candidate.name}`),
        },
        empirical: {
          evaluateDatasetConsumption() {
            datasetChecks += 1;
            return { blockers: [] };
          },
          execute() {
            empiricalExecuteCalls += 1;
            return { status: 'empirical_execution_completed' };
          },
        },
        agent: {
          execute() {
            agentExecuteCalls += 1;
            return { status: 'agent_execution_completed' };
          },
        },
      },
      campaign: {
        campaignId: `runtime-registry-${candidate.language}-downgrade`,
        spec: {
          datasetMounts: [],
          autonomousResearchPreparation: {
            launchMode: 'production-run',
            proposal: { protocolFamily: 'ml_algorithm_benchmark' },
            empiricalExecutionProfileSelection: candidate.executionProfileSelection,
            empiricalRuntimeCapabilityInspection: candidate.runtimeCapabilityInspection,
            runtimeImageReproducibilityInspection: reproducibility,
          },
        },
      },
      node: {
        nodeId: 'empirical',
        kind: 'empirical',
        spec: { language: candidate.language },
      },
      context: {
        empirical: {
          empirical: true,
          primary: true,
          reproduction: false,
          revalidate: false,
          revalidateCode: false,
          compile: false,
        },
      },
      workspace: '/tmp/hepta-runtime-downgrade-test-source',
      manuscript: 'main.tex',
      executionBudget: { remainingWallTimeMs: 60_000 },
    }), (error) => {
      assert.match(error.message, /autonomous_empirical_runtime_kernel_execution_blocked/);
      assert.ok(error.receipt.blockers.includes(candidate.expectedBlocker), candidate.name);
      return true;
    });
    assert.equal(datasetChecks, 0, candidate.name);
    assert.equal(agentExecuteCalls, 0, candidate.name);
    assert.equal(empiricalExecuteCalls, 0, candidate.name);
  }
});

test('production node guard runs before the first repair provider or empirical executor call', async () => {
  let datasetChecks = 0;
  let executorCalls = 0;
  let providerCalls = 0;
  const primitives = {
    workspace: {
      findEmpiricalEntrypoint: () => 'analysis.py',
      outputDirectory: () => '/tmp/hepta-runtime-registry-test-output',
      hashFile: () => H('source-lineage'),
    },
    empirical: {
      evaluateDatasetConsumption() {
        datasetChecks += 1;
        return { blockers: [] };
      },
      execute() {
        executorCalls += 1;
        return { status: 'empirical_execution_completed' };
      },
    },
    agent: {
      execute() {
        providerCalls += 1;
        return { status: 'agent_execution_completed' };
      },
    },
  };
  await assert.rejects(() => executeCampaignEmpiricalNode({
    primitives,
    campaign: {
      campaignId: 'runtime-registry-guard',
      spec: {
        sourceWorkspace: '/tmp/hepta-runtime-registry-test-source',
        datasetMounts: [],
        autonomousResearchPreparation: {
          launchMode: 'production-run',
          proposal: { protocolFamily: 'ml_algorithm_benchmark' },
        },
      },
    },
    node: { nodeId: 'empirical', kind: 'empirical', spec: { language: 'python' } },
    context: {
      empirical: {
        empirical: true,
        primary: true,
        reproduction: false,
        revalidate: false,
        revalidateCode: false,
        compile: false,
      },
    },
    workspace: '/tmp/hepta-runtime-registry-test-source',
    manuscript: 'main.tex',
    executionBudget: { remainingWallTimeMs: 60_000 },
  }), /autonomous_empirical_runtime_kernel_execution_blocked/);
  assert.equal(datasetChecks, 0);
  assert.equal(executorCalls, 0);
  assert.equal(providerCalls, 0);
});

test('persisted preparation cannot reuse a reproducibility receipt after it expires', async () => {
  const runtime = runtimeInspection();
  const onceValid = reproducibilityInspection({
    issuedAt: '2026-07-17T00:00:00.000Z',
    expiresAt: '2026-07-18T00:00:00.000Z',
  });
  const selection = selectAutonomousEmpiricalExecutionProfile({
    protocolFamily: 'ml_algorithm_benchmark',
    runtimeCapabilityInspection: runtime,
    runtimeReproducibilityInspection: onceValid,
    requireRegisteredRuntime: true,
    observedAt: '2026-07-17T12:00:00.000Z',
  });
  assert.equal(selection.status, 'autonomous_empirical_execution_profile_ready');
  let datasetChecks = 0;
  let executorCalls = 0;
  let providerCalls = 0;
  await assert.rejects(() => executeCampaignEmpiricalNode({
    primitives: {
      workspace: {
        findEmpiricalEntrypoint: () => 'analysis.py',
        outputDirectory: () => '/tmp/hepta-runtime-expiry-test-output',
        hashFile: () => H('expiry-source-lineage'),
      },
      empirical: {
        evaluateDatasetConsumption() {
          datasetChecks += 1;
          return { blockers: [] };
        },
        execute() {
          executorCalls += 1;
          return { status: 'empirical_execution_completed' };
        },
      },
      agent: {
        execute() {
          providerCalls += 1;
          return { status: 'agent_execution_completed' };
        },
      },
    },
    campaign: {
      campaignId: 'runtime-registry-expired-restart',
      spec: {
        datasetMounts: [],
        autonomousResearchPreparation: {
          launchMode: 'production-run',
          proposal: { protocolFamily: 'ml_algorithm_benchmark' },
          empiricalExecutionProfileSelection: selection,
          empiricalRuntimeCapabilityInspection: runtime,
          runtimeImageReproducibilityInspection: onceValid,
        },
      },
    },
    node: { nodeId: 'empirical', kind: 'empirical', spec: { language: 'python' } },
    context: {
      empirical: {
        empirical: true,
        primary: true,
        reproduction: false,
        revalidate: false,
        revalidateCode: false,
        compile: false,
      },
    },
    workspace: '/tmp/hepta-runtime-expiry-test-source',
    manuscript: 'main.tex',
    executionBudget: { remainingWallTimeMs: 60_000 },
  }), (error) => {
    assert.match(error.message, /autonomous_empirical_runtime_kernel_execution_blocked/);
    assert.ok(error.receipt.blockers.includes(
      'autonomous_empirical_execution_reproducibility_receipt_invalid',
    ));
    return true;
  });
  assert.equal(datasetChecks, 0);
  assert.equal(executorCalls, 0);
  assert.equal(providerCalls, 0);
});
