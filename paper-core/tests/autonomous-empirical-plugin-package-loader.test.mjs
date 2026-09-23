import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_ABI,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION,
  AUTONOMOUS_EMPIRICAL_REGISTERED_SCALAR_RESPONSE_PROFILE_TEMPLATE,
  AUTONOMOUS_EMPIRICAL_PLUGIN_PROTOCOL_FAMILIES,
  AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES,
  compileAutonomousEmpiricalFamilyPluginPackage,
  compileAutonomousEmpiricalFamilyPluginRegistry,
  verifyAutonomousEmpiricalFamilyPluginPackage,
  verifyAutonomousEmpiricalFamilyPluginSignedBundle,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import {
  buildAutonomousResearchCapabilityScopeManifest,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import {
  AUTONOMOUS_TYPED_NUMERIC_ORACLE_TYPES,
} from '../../paper-domain/automation/autonomous-research-formal-numeric-capability.mjs';
import {
  buildCampaignBenchmarkSelector,
} from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import {
  immutableAuthoritySigningPayload,
  readImmutableJsonDocument,
} from '../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function signedExternalBundle({
  now = new Date('2026-07-19T00:00:00.000Z'),
  profiles = [AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES[0]],
} = {}) {
  const keys = crypto.generateKeyPairSync('ed25519');
  const registry = compileAutonomousEmpiricalFamilyPluginRegistry(
    profiles,
  );
  const pluginPackage = compileAutonomousEmpiricalFamilyPluginPackage({
    packageId: 'organization.empirical-profiles',
    packageVersion: '2.4.1',
    registry,
  });
  const unsignedAuthority = {
    version: 1,
    kind: 'AutonomousEmpiricalFamilyPluginPackageAuthority',
    packageId: pluginPackage.packageId,
    packageVersion: pluginPackage.packageVersion,
    packageHash: pluginPackage.autonomousEmpiricalFamilyPluginPackageHash,
    pluginAbiHash: pluginPackage.pluginAbiHash,
    evaluatorRegistryHash: pluginPackage.evaluatorRegistryHash,
    signedAt: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  };
  const signature = crypto.sign(
    null,
    immutableAuthoritySigningPayload(unsignedAuthority),
    keys.privateKey,
  ).toString('base64');
  const authority = {
    ...unsignedAuthority,
    signatures: [{
      keyId: 'organization-empirical-plugin-key',
      role: 'empirical_plugin_authority',
      algorithm: 'ed25519',
      value: signature,
    }],
  };
  const trustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [{
      keyId: 'organization-empirical-plugin-key',
      subjectId: 'organization-empirical-plugin-authority',
      algorithm: 'ed25519',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
      roles: ['empirical_plugin_authority'],
      status: 'active',
    }],
  };
  return {
    now,
    privateKey: keys.privateKey,
    bundle: {
      version: 1,
      kind: 'AutonomousEmpiricalFamilyPluginSignedBundle',
      package: pluginPackage,
      authority,
    },
    trustStore,
  };
}

test('repository built-in profiles are one signed, content-addressed, immutable data package', () => {
  assert.equal(verifyAutonomousEmpiricalFamilyPluginPackage(
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE,
  ), true);
  assert.equal(AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY.profileCount, 5);
  assert.equal(AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION.signatureVerified, true);
  assert.equal(AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION.dataOnly, true);
  assert.equal(AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION
    .executablePayloadsAllowed, false);
  assert.equal(AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION
    .runtimeRegistryMutationAllowed, false);
  assert.equal(AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION.reloadAllowed, false);
  assert.deepEqual(AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_ABI.pinnedRuntimeLanguages,
    ['python', 'r']);
  assert.equal(AUTONOMOUS_EMPIRICAL_PLUGIN_PROTOCOL_FAMILIES.length, 5);
  assert.deepEqual(AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES, ['python', 'r']);
  const scope = buildAutonomousResearchCapabilityScopeManifest({
    empiricalFamilies: ['rl_stochastic_control_benchmark'],
  });
  assert.equal(scope.empiricalFamilyPluginPackageHash,
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE
      .autonomousEmpiricalFamilyPluginPackageHash);
  assert.equal(scope.empiricalFamilyPluginStartupInspectionHash,
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION
      .autonomousEmpiricalFamilyPluginStartupInspectionHash);
  assert.equal(scope.empiricalPluginStartupAuthorityVerified, true);
  const selector = buildCampaignBenchmarkSelector({
    benchmarkId: 'rl_stochastic_control_benchmark',
    datasetMounts: [],
  });
  assert.equal(
    selector.experimentDesign.benchmarkHarness.empiricalFamilyPluginPackageHash,
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE
      .autonomousEmpiricalFamilyPluginPackageHash,
  );
  assert.equal(
    selector.experimentDesign.benchmarkHarness
      .empiricalFamilyPluginStartupInspectionHash,
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION
      .autonomousEmpiricalFamilyPluginStartupInspectionHash,
  );
});

test('external authority verifies a complete package before registry activation', () => {
  const fixture = signedExternalBundle();
  const verified = verifyAutonomousEmpiricalFamilyPluginSignedBundle(fixture.bundle, {
    trustStore: fixture.trustStore,
    now: fixture.now,
  });
  assert.equal(verified.package.packageId, 'organization.empirical-profiles');
  assert.equal(verified.registry.profileCount, 1);
  assert.equal(verified.registry.autonomousEmpiricalFamilyPluginRegistryHash,
    fixture.bundle.package.registry.autonomousEmpiricalFamilyPluginRegistryHash);
  assert.equal(verified.startupInspection.source, 'external-startup-signed-bundle-v1');
  assert.deepEqual(verified.startupInspection.signerKeyIds,
    ['organization-empirical-plugin-key']);
  assert.deepEqual(verified.startupInspection.signerSubjectIds,
    ['organization-empirical-plugin-authority']);
  assert.match(verified.startupInspection.signerPublicKeySpkiHashes[0],
    /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(verified.package), true);
  assert.equal(Object.isFrozen(verified.registry), true);
  assert.equal(Object.isFrozen(verified.registry.profiles[0]), true);
  assert.throws(() => { verified.registry.profiles[0].minimumRepetitions = 999; }, TypeError);
});

test('tamper, executable payloads, incompatible ABI, and forged signatures fail closed', () => {
  const fixture = signedExternalBundle();
  const tampered = structuredClone(fixture.bundle);
  tampered.package.registry.profiles[0].minimumRepetitions += 1;
  assert.throws(() => verifyAutonomousEmpiricalFamilyPluginSignedBundle(tampered, {
    trustStore: fixture.trustStore,
    now: fixture.now,
  }), /signed_bundle_invalid/);

  const executable = structuredClone(fixture.bundle.package);
  executable.module = './arbitrary-code.mjs';
  assert.equal(verifyAutonomousEmpiricalFamilyPluginPackage(executable), false);

  const incompatibleAbi = structuredClone(fixture.bundle.package);
  incompatibleAbi.pluginAbiHash = `sha256:${'0'.repeat(64)}`;
  assert.equal(verifyAutonomousEmpiricalFamilyPluginPackage(incompatibleAbi), false);

  const forged = structuredClone(fixture.bundle);
  forged.authority.signatures[0].value = Buffer.alloc(64, 7).toString('base64');
  assert.throws(() => verifyAutonomousEmpiricalFamilyPluginSignedBundle(forged, {
    trustStore: fixture.trustStore,
    now: fixture.now,
  }), /authority_signature_invalid/);
  assert.throws(() => verifyAutonomousEmpiricalFamilyPluginSignedBundle(fixture.bundle, {
    trustStore: fixture.trustStore,
    now: new Date(fixture.now.getTime() + 120_000),
  }), /authority_time_window_invalid/);
});

test('a signed production plugin cannot claim GPU without a signed GPU runtime pin', () => {
  const fixture = signedExternalBundle();
  const gpuBundle = structuredClone(fixture.bundle);
  const profile = gpuBundle.package.registry.profiles[0];
  profile.executionProfile.requiresGpu = true;
  const {
    autonomousEmpiricalFamilyPluginProfileHash: ignoredProfileHash,
    ...profilePayload
  } = profile;
  void ignoredProfileHash;
  profile.autonomousEmpiricalFamilyPluginProfileHash = hashRecord(
    'AutonomousEmpiricalFamilyPluginProfile',
    profilePayload,
  );
  const {
    autonomousEmpiricalFamilyPluginRegistryHash: ignoredRegistryHash,
    ...registryPayload
  } = gpuBundle.package.registry;
  void ignoredRegistryHash;
  gpuBundle.package.registry.autonomousEmpiricalFamilyPluginRegistryHash = hashRecord(
    'AutonomousEmpiricalFamilyPluginRegistry',
    registryPayload,
  );
  const {
    autonomousEmpiricalFamilyPluginPackageHash: ignoredPackageHash,
    ...packagePayload
  } = gpuBundle.package;
  void ignoredPackageHash;
  gpuBundle.package.autonomousEmpiricalFamilyPluginPackageHash = hashRecord(
    'AutonomousEmpiricalFamilyPluginPackage',
    packagePayload,
  );
  gpuBundle.authority.packageHash =
    gpuBundle.package.autonomousEmpiricalFamilyPluginPackageHash;
  const { signatures: ignoredSignatures, ...unsignedAuthority } = gpuBundle.authority;
  void ignoredSignatures;
  gpuBundle.authority.signatures[0].value = crypto.sign(
    null,
    immutableAuthoritySigningPayload(unsignedAuthority),
    fixture.privateKey,
  ).toString('base64');

  assert.equal(crypto.verify(
    null,
    immutableAuthoritySigningPayload(unsignedAuthority),
    fixture.trustStore.keys[0].publicKeyPem,
    Buffer.from(gpuBundle.authority.signatures[0].value, 'base64'),
  ), true);
  assert.throws(() => verifyAutonomousEmpiricalFamilyPluginSignedBundle(gpuBundle, {
    trustStore: fixture.trustStore,
    now: fixture.now,
  }), /autonomous_empirical_family_plugin_signed_bundle_invalid/);
});

test('duplicate identities and unpinned Node or Julia runtimes cannot enter a package', () => {
  assert.throws(() => compileAutonomousEmpiricalFamilyPluginRegistry([
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES[0],
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES[0],
  ]), /registry_duplicate/);

  for (const language of ['node', 'julia']) {
    const profile = structuredClone(
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES[0],
    );
    profile.profileId = `${language}-runtime-profile-v1`;
    profile.executionProfile = { label: language, language, requiresGpu: false };
    assert.throws(() => compileAutonomousEmpiricalFamilyPluginRegistry([profile]),
      /profile_invalid/);
  }
});

test('startup loader reads regular files once and module caching prevents reload mutation', (t) => {
  const fixture = signedExternalBundle({ now: new Date() });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-empirical-plugin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundlePath = path.join(root, 'bundle.json');
  const trustStorePath = path.join(root, 'trust.json');
  fs.writeFileSync(bundlePath, JSON.stringify(fixture.bundle));
  fs.writeFileSync(trustStorePath, JSON.stringify(fixture.trustStore));
  assert.equal(readImmutableJsonDocument(bundlePath).package.packageId,
    'organization.empirical-profiles');

  const program = [
    "const modulePath = './paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';",
    'const first = await import(modulePath);',
    "const analysis = await import('./paper-domain/automation/analysis-protocol-contract.mjs');",
    "const capability = await import('./paper-domain/automation/autonomous-research-capability-scope-manifest.mjs');",
    "const benchmark = await import('./paper-domain/automation/campaign-benchmark-selector.mjs');",
    "const scope = capability.buildAutonomousResearchCapabilityScopeManifest({ empiricalFamilies: ['rl_stochastic_control_benchmark'] });",
    "const selector = benchmark.buildCampaignBenchmarkSelector({ benchmarkId: 'rl_stochastic_control_benchmark', datasetMounts: [] });",
    "process.env.HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE = '/does/not/exist.json';",
    'const second = await import(modulePath);',
    'console.log(JSON.stringify({',
    '  packageId: first.AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE.packageId,',
    '  sameRegistry: first.AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY === second.AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,',
    '  reloadAllowed: first.AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION.reloadAllowed,',
    '  protocolFamilies: Object.keys(analysis.ANALYSIS_PROTOCOL_FAMILY_PROFILES),',
    '  capabilityPackageBound: scope.empiricalFamilyPluginPackageHash === first.AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE.autonomousEmpiricalFamilyPluginPackageHash,',
    '  harnessPackageBound: selector.experimentDesign.benchmarkHarness.empiricalFamilyPluginPackageHash === first.AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE.autonomousEmpiricalFamilyPluginPackageHash,',
    '}));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE: bundlePath,
      HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE: trustStorePath,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    packageId: 'organization.empirical-profiles',
    sameRegistry: true,
    reloadAllowed: false,
    protocolFamilies: ['rl_stochastic_control_benchmark'],
    capabilityPackageBound: true,
    harnessPackageBound: true,
  });

  const symlinkPath = path.join(root, 'bundle-link.json');
  fs.symlinkSync(bundlePath, symlinkPath);
  assert.throws(() => readImmutableJsonDocument(symlinkPath));
});

test('a signed registered scalar profile executes arbitrary operator data with independent recomputation', (t) => {
  const fixture = signedExternalBundle({
    now: new Date(),
    profiles: [AUTONOMOUS_EMPIRICAL_REGISTERED_SCALAR_RESPONSE_PROFILE_TEMPLATE],
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-registered-scalar-plugin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundlePath = path.join(root, 'bundle.json');
  const trustStorePath = path.join(root, 'trust.json');
  fs.writeFileSync(bundlePath, JSON.stringify(fixture.bundle));
  fs.writeFileSync(trustStorePath, JSON.stringify(fixture.trustStore));

  const program = [
    "const plugin = await import('./paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs');",
    "const arm = await import('./paper-domain/automation/system-benchmark-arm-protocol.mjs');",
    "const challenge = await import('./paper-domain/automation/system-benchmark-challenge.mjs');",
    "const harness = await import('./paper-domain/automation/operator-dataset-harness-contract.mjs');",
    "const independent = await import('./paper-adapters/research-verify/independent-system-benchmark-recomputation.mjs');",
    "const formal = await import('./paper-domain/automation/autonomous-formal-support-registry.mjs');",
    "const hash = await import('./workflow-kernel/record-hash.mjs');",
    'const profile = plugin.AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY.profiles[0];',
    "const benchmarkId = 'operator-generic-scalar-dataset';",
    'const definition = {',
    "  version: 1, kind: 'OperatorAuthorizedDatasetBenchmarkHarness', benchmarkId,",
    '  benchmarkFamily: profile.benchmarkFamily, seedSchedule: profile.seedSchedule,',
    '  minimumRepetitions: profile.minimumRepetitions,',
    '  cells: profile.seedSchedule.flatMap((seed) => Array.from({ length: profile.minimumRepetitions }, (_, repetitionIndex) => ({',
    '    seed, repetition: repetitionIndex + 1,',
    '    cases: Array.from({ length: 8 }, (_, caseIndex) => {',
    '      const target = (caseIndex - 3) / 4;',
    '      return {',
    "        caseId: hash.hashRecord('RegisteredScalarPluginCase', { seed, repetition: repetitionIndex + 1, caseIndex }),",
    '        input: { feature: target, metadata: { seed } },',
    '        ablationInput: { metadata: { seed } }, referenceResponse: 0,',
    '        oracle: { lowerBound: -2, robustTarget: target + 0.1, target, upperBound: 2 },',
    '      };',
    '    }),',
    '  }))),',
    '};',
    'const validated = harness.validateOperatorDatasetHarnessDefinition(definition, { benchmarkId });',
    'const protocols = arm.buildSystemBenchmarkArmProtocolSet({',
    '  benchmarkId, datasetBacked: true, benchmarkFamily: profile.benchmarkFamily,',
    '});',
    "const protocol = protocols.protocols.find((item) => item.arm === 'treatment');",
    'const produced = challenge.buildSystemBenchmarkCellChallenge({',
    '  protocol, seed: profile.seedSchedule[0], repetition: 1,',
    '  operatorDatasetHarnessDefinition: definition,',
    '});',
    'const recomputed = independent.buildIndependentSystemBenchmarkCellFixture({',
    '  protocol, seed: profile.seedSchedule[0], repetition: 1,',
    '  operatorDatasetHarnessDefinition: definition,',
    '});',
    'const responses = produced.oracle.cases.map((item) => ({',
    '  caseId: item.caseId, response: item.oracle.target,',
    '}));',
    'const producerEvents = challenge.evaluateSystemBenchmarkCellResponses({',
    '  protocol, challenge: produced.challenge, oracle: produced.oracle,',
    "  document: { version: 1, kind: 'CampaignBenchmarkCellResponses',",
    '    systemBenchmarkCellChallengeHash: produced.challenge.systemBenchmarkCellChallengeHash, responses },',
    '  operatorDatasetHarnessDefinition: definition,',
    '});',
    'const independentEvents = independent.independentlyEvaluateSystemBenchmarkCellResponses({',
    '  protocol, challenge: recomputed.challenge, oracle: recomputed.oracle, responses,',
    '});',
    'const producerMetrics = arm.evaluateSystemBenchmarkArmRawObservation({',
    "  protocol, document: { version: 1, kind: 'CampaignBenchmarkCellRawEvents', events: producerEvents.events },",
    '  requiredMetrics: profile.requiredMetrics, metricSpecs: profile.metricSpecs,',
    '});',
    'const independentMetrics = independent.independentlyAggregateSystemBenchmarkEvents({',
    '  protocol, events: independentEvents.events,',
    '  requiredMetrics: profile.requiredMetrics, metricSpecs: profile.metricSpecs,',
    '});',
    'const formalTemplate = formal.selectAutonomousFormalSupportTemplate(profile.benchmarkFamily);',
    'console.log(JSON.stringify({',
    '  family: profile.benchmarkFamily, definitionHash: validated.operatorDatasetHarnessDefinitionHash,',
    '  producerStatus: producerEvents.status, independentFixtureStatus: recomputed.status,',
    '  independentStatus: independentEvents.status, producerMetricStatus: producerMetrics.status,',
    '  independentMetricStatus: independentMetrics.status,',
    '  fixtureAgreement: JSON.stringify(produced) === JSON.stringify({ challenge: recomputed.challenge, oracle: recomputed.oracle }),',
    '  eventAgreement: JSON.stringify(producerEvents.events) === JSON.stringify(independentEvents.events),',
    '  metricAgreement: JSON.stringify(producerMetrics.metrics) === JSON.stringify(independentMetrics.metrics),',
    '  inputPolicy: produced.challenge.inputPolicy, formalFamily: formalTemplate.protocolFamily,',
    '}));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE: bundlePath,
      HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE: trustStorePath,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.family, 'registered_scalar_response_benchmark');
  assert.match(report.definitionHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(report.producerStatus, 'system_benchmark_cell_response_evaluated');
  assert.equal(report.independentFixtureStatus, 'independent_fixture_built');
  assert.equal(report.independentStatus, 'independent_response_evaluation_verified');
  assert.equal(report.producerMetricStatus, 'system_benchmark_arm_observation_computed');
  assert.equal(report.independentMetricStatus, 'independent_event_aggregation_verified');
  assert.equal(report.fixtureAgreement, true);
  assert.equal(report.eventAgreement, true);
  assert.equal(report.metricAgreement, true);
  assert.equal(report.inputPolicy, 'operator-authorized-fixed-input-v1');
  assert.equal(report.formalFamily, 'registered_scalar_response_benchmark');
});

test('a Python-only signed bundle constrains generic readiness, agenda, and runtime scope', (t) => {
  const fixture = signedExternalBundle({ now: new Date() });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-python-plugin-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundlePath = path.join(root, 'bundle.json');
  const trustStorePath = path.join(root, 'trust.json');
  fs.writeFileSync(bundlePath, JSON.stringify(fixture.bundle));
  fs.writeFileSync(trustStorePath, JSON.stringify(fixture.trustStore));

  const program = [
    "const plugin = await import('./paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs');",
    "const external = await import('./paper-composition/automation/autonomous-research-external-capability-composition.mjs');",
    "const capability = await import('./paper-domain/automation/autonomous-research-capability-scope-manifest.mjs');",
    "const agenda = await import('./paper-domain/automation/autonomous-research-agenda-production-contract.mjs');",
    "const runtimePreflight = await import('./paper-adapters/automation/autonomous-empirical-runtime-preflight.mjs');",
    "const execution = await import('./paper-domain/automation/autonomous-empirical-execution-profile-policy.mjs');",
    "const runtimeRegistry = await import('./paper-adapters/automation/runtime-image-registry.mjs');",
    'const selectedFamily = plugin.AUTONOMOUS_EMPIRICAL_PLUGIN_PROTOCOL_FAMILIES[0];',
    'const configured = external.inspectConfiguredAutonomousResearchCapabilityScope({ environment: {} });',
    'const composed = external.composeAutonomousResearchExternalCapabilities({',
    "  paperId: 'python-only-scope', refereeCount: 3,",
    "  requestedContentMode: 'agent-evidence-bound', dynamicFormalClaimsEnabled: true,",
    '  requestedProtocolFamily: selectedFamily,',
    '  reviewerPrincipalPoolInspection: { pool: { reviewerPrincipalCount: 3, reviewerTrustDomainCount: 3 } },',
    '  venueProfileRegistry: { profiles: [{ externalSubmissionEnabled: false }] },',
    '  priorArtRetriever: {}, externalResearchReplay: {}, environment: {},',
    '});',
    'const agendaRequest = agenda.buildAutonomousResearchAgendaProductionRequest({',
    "  paperId: 'python-only-scope', protocolFamilyHint: selectedFamily,",
    '  allowedProtocolFamilies: composed.empiricalFamilies,',
    '});',
    'const dockerImages = [];',
    'const runtime = runtimePreflight.preflightAutonomousEmpiricalRuntimes({',
    '  spawnSyncImpl(_executable, args) {',
    '    const image = args[2]; dockerImages.push(image);',
    '    const digest = runtimeRegistry.AUTOMATION_RUNTIME_IMAGES.python.imageDigest;',
    '    return { status: 0, signal: null, error: null, stdout: JSON.stringify([{',
    "      Descriptor: { digest, mediaType: 'application/vnd.oci.image.manifest.v1+json' },",
    "      Id: digest, Os: 'linux', Architecture: 'amd64',",
    '    }]) };',
    '  },',
    '});',
    'const selection = execution.selectAutonomousEmpiricalExecutionProfile({',
    '  protocolFamily: selectedFamily, runtimeCapabilityInspection: runtime,',
    '});',
    'const fullCoverage = capability.evaluateAutonomousResearchCapabilityRequestCoverage({',
    '  manifest: composed.contentCapabilityScopeManifest, requestedProtocolFamily: selectedFamily,',
    '  requireMachineGeneratedAgenda: true, requireDynamicFormalClaims: true,',
    '  requireStructuredPriorArt: true, requiredReviewerTrustDomains: 3,',
    '  requireExternalReplay: true, requireVenueProfile: true,',
    '});',
    'const unknownFamily = "finance_asset_pricing_benchmark";',
    'const unknownCoverage = capability.evaluateAutonomousResearchCapabilityRequestCoverage({',
    '  manifest: composed.contentCapabilityScopeManifest, requestedProtocolFamily: unknownFamily,',
    '});',
    'let unknownSelectionError = null;',
    'try { execution.selectAutonomousEmpiricalExecutionProfile({ protocolFamily: unknownFamily, runtimeCapabilityInspection: runtime }); }',
    'catch (error) { unknownSelectionError = error.message; }',
    'let unknownAgendaError = null;',
    'try { agenda.buildAutonomousResearchAgendaProductionRequest({',
    "  paperId: 'python-only-unknown', protocolFamilyHint: unknownFamily,",
    '  allowedProtocolFamilies: composed.empiricalFamilies,',
    '}); } catch (error) { unknownAgendaError = error.message; }',
    'console.log(JSON.stringify({',
    '  pluginFamilies: plugin.AUTONOMOUS_EMPIRICAL_PLUGIN_PROTOCOL_FAMILIES,',
    '  pluginRuntimeLanguages: plugin.AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES,',
    '  configuredFamilies: configured.manifest.empiricalFamilies,',
    '  composedFamilies: composed.empiricalFamilies,',
    '  manifestFamilies: composed.contentCapabilityScopeManifest.empiricalFamilies,',
    '  agendaAllowedFamilies: agendaRequest.allowedProtocolFamilies,',
    '  genericDeclaredCapability: composed.contentCapabilityScopeManifest.genericDeclaredCapability,',
    '  compositionCoverageReady: composed.capabilityRequestCoverage.ready,',
    '  fullCoverageReady: fullCoverage.ready,',
    '  runtimeLanguages: Object.keys(runtime.languages),',
    '  unavailableLanguages: runtime.unavailableLanguages, runtimeStatus: runtime.status,',
    '  dockerImages, campaignRuntimeLanguages: Object.keys(runtimeRegistry.runtimeImagesForCampaign()),',
    '  selectionStatus: selection.status,',
    '  unknownCoverageBlockers: unknownCoverage.blockers,',
    '  unknownSelectionError, unknownAgendaError,',
    '}));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE: bundlePath,
      HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE: trustStorePath,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const family = 'rl_stochastic_control_benchmark';
  assert.deepEqual(report.pluginFamilies, [family]);
  assert.deepEqual(report.pluginRuntimeLanguages, ['python']);
  assert.deepEqual(report.configuredFamilies, [family]);
  assert.deepEqual(report.composedFamilies, [family]);
  assert.deepEqual(report.manifestFamilies, [family]);
  assert.deepEqual(report.agendaAllowedFamilies, [family]);
  // This fixture deliberately supplies no signed submission configuration or
  // live portal, so it is a bounded profile even though its requested Python
  // family is fully covered.
  assert.equal(report.genericDeclaredCapability, false);
  assert.equal(report.compositionCoverageReady, true);
  assert.equal(report.fullCoverageReady, false);
  assert.deepEqual(report.runtimeLanguages, ['python']);
  assert.deepEqual(report.unavailableLanguages, []);
  assert.equal(report.runtimeStatus, 'autonomous_empirical_runtime_capability_ready');
  assert.deepEqual(report.dockerImages, ['hepta/python-scientific:0.14.0']);
  assert.deepEqual(report.campaignRuntimeLanguages, ['python']);
  assert.equal(report.selectionStatus, 'autonomous_empirical_execution_profile_ready');
  assert.deepEqual(report.unknownCoverageBlockers,
    ['autonomous_research_capability_protocol_family_not_covered']);
  assert.equal(report.unknownSelectionError,
    'autonomous_empirical_execution_profile_family_unsupported');
  assert.equal(report.unknownAgendaError,
    'autonomous_research_agenda_production_request_invalid');
});

test('an externally signed advanced profile activates formal numerical coverage', (t) => {
  const source = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES[1];
  const fixture = signedExternalBundle({
    now: new Date(),
    profiles: [{
      ...source,
      typedOracleKinds: AUTONOMOUS_TYPED_NUMERIC_ORACLE_TYPES,
    }],
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-advanced-plugin-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundlePath = path.join(root, 'bundle.json');
  const trustStorePath = path.join(root, 'trust.json');
  fs.writeFileSync(bundlePath, JSON.stringify(fixture.bundle));
  fs.writeFileSync(trustStorePath, JSON.stringify(fixture.trustStore));
  const program = [
    "const plugin = await import('./paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs');",
    "const capability = await import('./paper-domain/automation/autonomous-research-capability-scope-manifest.mjs');",
    'const family = plugin.AUTONOMOUS_EMPIRICAL_PLUGIN_PROTOCOL_FAMILIES[0];',
    'const manifest = capability.buildAutonomousResearchCapabilityScopeManifest({',
    "  agendaMode: 'machine-generated',",
    "  manuscriptMode: 'agent-authored-evidence-bound-ir-v1',",
    "  formalClaimClasses: ['dynamic-lean-type-v1', 'registered-template-v1'],",
    '  empiricalFamilies: [family],',
    "  priorArtMode: 'structured-ranked-deduplicated-v2',",
    '  reviewerPrincipalCount: 3, reviewerTrustDomainCount: 3,',
    "  replayMode: 'external-trust-domain-v1', venueMode: 'submission-enabled-v1',",
    '  externalPrerequisites: [],',
    '});',
    'const coverage = capability.evaluateAutonomousResearchCapabilityRequestCoverage({',
    '  manifest, requestedProtocolFamily: family,',
    '  requireKernelCheckedFormalProof: true, requireIndependentFormalReview: true,',
    '  requireFreshFormalReplay: true, requireAdvancedNumericalAnalysis: true,',
    '});',
    'console.log(JSON.stringify({',
    '  source: plugin.AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION.source,',
    '  signatureVerified: plugin.AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION.signatureVerified,',
    '  advancedNumericalAnalysisDeclaredCapability: manifest.advancedNumericalAnalysisDeclaredCapability,',
    '  generalPurposeFormalNumericalCapability: manifest.generalPurposeFormalNumericalCapability,',
    '  theoremDiscoveryGuaranteed: manifest.theoremDiscoveryGuaranteed,',
    '  coverageReady: coverage.ready, blockers: coverage.blockers,',
    '}));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE: bundlePath,
      HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE: trustStorePath,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    source: 'external-startup-signed-bundle-v1',
    signatureVerified: true,
    advancedNumericalAnalysisDeclaredCapability: true,
    generalPurposeFormalNumericalCapability: true,
    theoremDiscoveryGuaranteed: false,
    coverageReady: true,
    blockers: [],
  });
});
