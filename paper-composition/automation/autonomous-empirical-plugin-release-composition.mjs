import {
  readImmutableJsonDocument,
} from '../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
import {
  buildAutonomousEmpiricalPluginReleasePlan,
  createAutonomousAdvancedNumericalPluginReleaseTemplate,
} from '../../paper-domain/automation/autonomous-empirical-plugin-release-contract.mjs';
import {
  verifyAutonomousEmpiricalFamilyPluginSignedBundle,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import {
  STRICT_FULL_AUTO_ACCEPTANCE_NUMERICAL_FAMILIES,
} from '../../paper-domain/automation/strict-full-auto-acceptance-policy.mjs';
import {
  readAutonomousEmpiricalPluginSigningAuthorityConfiguration,
  signAutonomousEmpiricalPluginAuthorityDocument,
} from '../../paper-adapters/automation/autonomous-empirical-plugin-signing-authority.mjs';
import {
  assertAutonomousEmpiricalPluginActivationPointerTarget,
  inspectInstalledAutonomousEmpiricalPluginRelease,
  installAutonomousEmpiricalPluginRelease,
} from '../../paper-adapters/automation/autonomous-empirical-plugin-release-repository.mjs';

export function composeAutonomousAdvancedNumericalPluginReleaseTemplate(options = {}) {
  const template = createAutonomousAdvancedNumericalPluginReleaseTemplate(options);
  const plan = buildAutonomousEmpiricalPluginReleasePlan(template);
  return Object.freeze({ template, plan });
}

function selectedTemplate({ templatePath, releaseTemplate }) {
  if (Boolean(templatePath) === Boolean(releaseTemplate)) {
    throw new Error('autonomous_empirical_plugin_release_template_source_invalid');
  }
  return templatePath ? readImmutableJsonDocument(templatePath) : releaseTemplate;
}

function strictProductionFamilySetVerified(profiles) {
  const actual = new Set((profiles || []).map((profile) => profile.benchmarkFamily));
  return STRICT_FULL_AUTO_ACCEPTANCE_NUMERICAL_FAMILIES.every((family) => (
    actual.has(family)
  ));
}

export function planConfiguredAutonomousEmpiricalPluginRelease({
  templatePath,
  releaseTemplate,
  signingConfigurationPath,
} = {}) {
  const template = selectedTemplate({ templatePath, releaseTemplate });
  const plan = buildAutonomousEmpiricalPluginReleasePlan(template);
  const signingAuthority = readAutonomousEmpiricalPluginSigningAuthorityConfiguration({
    configurationPath: signingConfigurationPath,
  });
  return Object.freeze({
    ready: true,
    status: 'autonomous_empirical_plugin_release_plan_ready',
    plan,
    signingAuthorityInspection: signingAuthority.inspection,
    signatureProduced: false,
    installed: false,
  });
}

export function publishConfiguredAutonomousEmpiricalPluginRelease({
  templatePath,
  releaseTemplate,
  signingConfigurationPath,
  installRoot,
  activationPointerPath = null,
  environment = process.env,
  clock = { now: () => new Date() },
  spawnSyncImpl,
} = {}) {
  if (activationPointerPath) {
    assertAutonomousEmpiricalPluginActivationPointerTarget(activationPointerPath);
  }
  const template = selectedTemplate({ templatePath, releaseTemplate });
  const plan = buildAutonomousEmpiricalPluginReleasePlan(template);
  const signingAuthority = readAutonomousEmpiricalPluginSigningAuthorityConfiguration({
    configurationPath: signingConfigurationPath,
  });
  const now = new Date(clock.now());
  if (!Number.isFinite(now.getTime())) {
    throw new Error('autonomous_empirical_plugin_release_time_invalid');
  }
  const unsignedAuthority = Object.freeze({
    version: 1,
    kind: 'AutonomousEmpiricalFamilyPluginPackageAuthority',
    packageId: plan.packageId,
    packageVersion: plan.packageVersion,
    packageHash: plan.packageHash,
    pluginAbiHash: plan.pluginAbiHash,
    evaluatorRegistryHash: plan.evaluatorRegistryHash,
    signedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + signingAuthority.authorityLifetimeMs,
    ).toISOString(),
  });
  const signature = signAutonomousEmpiricalPluginAuthorityDocument({
    document: unsignedAuthority,
    signingAuthority,
    environment,
    ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
  });
  const bundle = Object.freeze({
    version: 1,
    kind: 'AutonomousEmpiricalFamilyPluginSignedBundle',
    package: plan.package,
    authority: Object.freeze({
      ...unsignedAuthority,
      signatures: Object.freeze([signature]),
    }),
  });
  const verified = verifyAutonomousEmpiricalFamilyPluginSignedBundle(bundle, {
    trustStore: signingAuthority.trustStore,
    source: 'external-startup-signed-bundle-v1',
    now,
  });
  if (verified.startupInspection.signatureVerified !== true
    || verified.registry.autonomousEmpiricalFamilyPluginRegistryHash !== plan.registryHash
    || verified.package.autonomousEmpiricalFamilyPluginPackageHash !== plan.packageHash) {
    throw new Error('autonomous_empirical_plugin_release_verification_failed');
  }
  const installed = installAutonomousEmpiricalPluginRelease({
    bundle,
    trustStore: signingAuthority.trustStore,
    startupInspection: verified.startupInspection,
    installRoot,
    activationPointerPath,
    acceptancePlanHash:
      environment.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH || null,
    acceptanceStepIdempotencyKey:
      environment.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY || null,
    now,
  });
  return Object.freeze({
    ready: true,
    status: 'autonomous_empirical_plugin_release_published',
    plan,
    signingAuthorityInspection: signingAuthority.inspection,
    startupInspection: verified.startupInspection,
    signatureProduced: true,
    installed: true,
    installation: installed,
    externalEd25519AuthorityVerified: true,
    advancedNumericalCoverageVerified:
      plan.advancedNumericalCoverage.allProfilesAdvancedNumericalCoverage,
    strictProductionAdvancedNumericalFamilySetVerified:
      strictProductionFamilySetVerified(plan.package.registry.profiles),
    privateKeyMaterialLoadedByHepta: false,
  });
}

export function inspectConfiguredAutonomousEmpiricalPluginRelease({
  activationPath,
  now = new Date(),
  environment = process.env,
} = {}) {
  const inspection = inspectInstalledAutonomousEmpiricalPluginRelease({
    activationPath,
    now,
    expectedAcceptancePlanHash:
      environment.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH || null,
    expectedAcceptanceStepIdempotencyKey:
      environment.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY || null,
  });
  return Object.freeze({
    ...inspection,
    strictProductionAdvancedNumericalFamilySetVerified:
      strictProductionFamilySetVerified(inspection.bundle?.package?.registry?.profiles),
  });
}
