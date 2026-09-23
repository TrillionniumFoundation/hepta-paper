import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  AUTONOMOUS_ADVANCED_NUMERICAL_ORACLE_TYPES,
  buildAutonomousEmpiricalPluginReleasePlan,
  createAutonomousAdvancedNumericalPluginReleaseTemplate,
  verifyAutonomousEmpiricalPluginReleasePlan,
} from '../../paper-domain/automation/autonomous-empirical-plugin-release-contract.mjs';
import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import {
  STRICT_FULL_AUTO_ACCEPTANCE_NUMERICAL_FAMILIES,
} from '../../paper-domain/automation/strict-full-auto-acceptance-policy.mjs';
import {
  buildAutonomousResearchCapabilityScopeManifest,
  evaluateAutonomousResearchCapabilityRequestCoverage,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import {
  inspectConfiguredAutonomousEmpiricalPluginRelease,
  publishConfiguredAutonomousEmpiricalPluginRelease,
} from '../../paper-composition/automation/autonomous-empirical-plugin-release-composition.mjs';
import {
  parseAutonomousEmpiricalPluginReleaseArguments,
} from '../bin/autonomous-empirical-plugin-release.mjs';

function writeJson(candidate, value, mode = 0o600) {
  fs.writeFileSync(candidate, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.chmodSync(candidate, mode);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-numeric-plugin-release-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keys = crypto.generateKeyPairSync('ed25519');
  const privateKeyPath = path.join(root, 'plugin-authority-private.pem');
  fs.writeFileSync(privateKeyPath, keys.privateKey.export({
    type: 'pkcs8', format: 'pem',
  }), { mode: 0o600 });
  const trustStorePath = path.join(root, 'trust-store.json');
  writeJson(trustStorePath, {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [{
      keyId: 'test-advanced-numeric-authority',
      subjectId: 'test-external-release-authority',
      algorithm: 'ed25519',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
      roles: ['empirical_plugin_authority'],
      status: 'active',
    }],
  }, 0o644);
  const signerPath = path.join(root, 'external-signer.mjs');
  fs.writeFileSync(signerPath, [
    '#!/usr/bin/node',
    "import crypto from 'node:crypto';",
    "import fs from 'node:fs';",
    "const request = JSON.parse(fs.readFileSync(0, 'utf8'));",
    "const privateKey = fs.readFileSync(process.env.HEPTA_TEST_PLUGIN_SIGNING_KEY, 'utf8');",
    "const signature = crypto.sign(null, Buffer.from(request.payloadBase64, 'base64'), privateKey).toString('base64');",
    'process.stdout.write(JSON.stringify({',
    "  version: 1, kind: 'AutonomousEmpiricalPluginSigningResponse',",
    '  keyId: request.keyId, role: request.role, algorithm: request.algorithm,',
    '  payloadHash: request.payloadHash, signature,',
    '}));',
  ].join('\n'), { mode: 0o700 });
  fs.chmodSync(signerPath, 0o700);
  const configurationPath = path.join(root, 'signing-authority.json');
  writeJson(configurationPath, {
    version: 1,
    kind: 'AutonomousEmpiricalPluginSigningAuthorityConfiguration',
    authorityLifetimeMs: 24 * 60 * 60 * 1_000,
    trustStorePath,
    signer: {
      backendKind: 'external-command-ed25519-v1',
      command: signerPath,
      arguments: [],
      environmentAllowlist: ['HEPTA_TEST_PLUGIN_SIGNING_KEY'],
      timeoutMs: 10_000,
      keyId: 'test-advanced-numeric-authority',
      role: 'empirical_plugin_authority',
      algorithm: 'ed25519',
    },
  });
  return {
    root,
    privateKeyPath,
    trustStorePath,
    configurationPath,
    installRoot: path.join(root, 'installed'),
  };
}

test('canonical advanced numerical template compiles to a hash-bound release plan', () => {
  const template = createAutonomousAdvancedNumericalPluginReleaseTemplate({
    packageId: 'organization.advanced-numerical-profile',
    packageVersion: '3.1.4',
  });
  const plan = buildAutonomousEmpiricalPluginReleasePlan(template);
  assert.equal(verifyAutonomousEmpiricalPluginReleasePlan(plan), true);
  assert.equal(plan.advancedNumericalCoverage.allProfilesAdvancedNumericalCoverage, true);
  assert.equal(plan.advancedNumericalCoverage.fullCoverageProfileCount, 1);
  assert.deepEqual(
    plan.package.registry.profiles[0].typedOracleKinds.filter((kind) => (
      AUTONOMOUS_ADVANCED_NUMERICAL_ORACLE_TYPES.includes(kind)
    )),
    AUTONOMOUS_ADVANCED_NUMERICAL_ORACLE_TYPES,
  );
  assert.equal(plan.releaseRequiresConfiguredExternalEd25519Authority, true);
  assert.equal(plan.unsignedRepositoryTemplateIsAuthority, false);
});

test('release tooling publishes the registered scalar family without executable plugin code', () => {
  const template = createAutonomousAdvancedNumericalPluginReleaseTemplate({
    packageId: 'organization.registered-scalar-profile',
    packageVersion: '1.0.0',
    benchmarkFamilies: ['registered_scalar_response_benchmark'],
  });
  const plan = buildAutonomousEmpiricalPluginReleasePlan(template);
  assert.equal(verifyAutonomousEmpiricalPluginReleasePlan(plan), true);
  assert.equal(plan.package.dataOnly, true);
  assert.equal(plan.package.executablePayloadsAllowed, false);
  assert.equal(plan.package.registry.profiles[0].benchmarkFamily,
    'registered_scalar_response_benchmark');
  assert.equal(plan.advancedNumericalCoverage.allProfilesAdvancedNumericalCoverage, true);
});

test('production coverage rejects a signed core-only package until advanced kinds are authorized', () => {
  assert.equal(AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION.signatureVerified, true);
  assert.equal(AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION
    .allProductionProfilesAdvancedNumericalAnalysisCovered, false);
  const manifest = buildAutonomousResearchCapabilityScopeManifest({
    empiricalFamilies: ['ml_algorithm_benchmark'],
  });
  const coverage = evaluateAutonomousResearchCapabilityRequestCoverage({
    manifest,
    requestedProtocolFamily: 'ml_algorithm_benchmark',
    requireAdvancedNumericalAnalysis: true,
  });
  assert.equal(coverage.ready, false);
  assert.deepEqual(coverage.blockers, AUTONOMOUS_ADVANCED_NUMERICAL_ORACLE_TYPES
    .map((kind) => `autonomous_research_capability_numeric_oracle_not_covered:${kind}`));
});

test('external Ed25519 signer publishes, verifies, and atomically installs an immutable release', (t) => {
  const selected = fixture(t);
  const releaseTemplate = createAutonomousAdvancedNumericalPluginReleaseTemplate({
    packageId: 'organization.advanced-numerical-profile',
    packageVersion: '3.1.4',
    benchmarkFamilies: STRICT_FULL_AUTO_ACCEPTANCE_NUMERICAL_FAMILIES,
  });
  const now = new Date();
  const input = {
    releaseTemplate,
    signingConfigurationPath: selected.configurationPath,
    installRoot: selected.installRoot,
    environment: { HEPTA_TEST_PLUGIN_SIGNING_KEY: selected.privateKeyPath },
    clock: { now: () => now },
  };
  const published = publishConfiguredAutonomousEmpiricalPluginRelease(input);
  assert.equal(published.ready, true);
  assert.equal(published.externalEd25519AuthorityVerified, true);
  assert.equal(published.advancedNumericalCoverageVerified, true);
  assert.equal(published.strictProductionAdvancedNumericalFamilySetVerified, true);
  assert.equal(published.privateKeyMaterialLoadedByHepta, false);
  assert.equal(published.installation.atomicallyInstalled, true);
  assert.equal(published.installation.immutableContentAddressedInstall, true);
  assert.equal(fs.statSync(published.installation.installedReleasePath).isDirectory(), true);

  const activationPath = path.join(
    published.installation.installedReleasePath, 'activation.json',
  );
  const inspected = inspectConfiguredAutonomousEmpiricalPluginRelease({
    activationPath,
    now,
  });
  assert.equal(inspected.ready, true);
  assert.deepEqual(inspected.activationEnvironment,
    published.installation.activationEnvironment);
  const repeated = publishConfiguredAutonomousEmpiricalPluginRelease(input);
  assert.equal(repeated.installation.installedReleasePath,
    published.installation.installedReleasePath);
  assert.deepEqual(fs.readdirSync(published.installation.installedReleasePath).sort(),
    ['activation.json', 'bundle.json', 'trust-store.json']);

  const program = [
    "const plugin = await import('./paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs');",
    'console.log(JSON.stringify({',
    '  source: plugin.AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION.source,',
    '  signatureVerified: plugin.AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION.signatureVerified,',
    '  allAdvanced: plugin.AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION.allProductionProfilesAdvancedNumericalAnalysisCovered,',
    '  families: plugin.AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION.advancedNumericalAnalysisFamilies,',
    '}));',
  ].join('\n');
  const startup = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
    encoding: 'utf8',
    env: { ...process.env, ...inspected.activationEnvironment },
  });
  assert.equal(startup.status, 0, startup.stderr);
  assert.deepEqual(JSON.parse(startup.stdout), {
    source: 'external-startup-signed-bundle-v1',
    signatureVerified: true,
    allAdvanced: true,
    families: STRICT_FULL_AUTO_ACCEPTANCE_NUMERICAL_FAMILIES,
  });
});

test('missing authority, incomplete numeric coverage, and forged signer output fail closed', (t) => {
  const selected = fixture(t);
  const template = createAutonomousAdvancedNumericalPluginReleaseTemplate({
    packageVersion: '1.2.3',
  });
  const incomplete = structuredClone(template);
  incomplete.profiles[0].typedOracleKinds = ['property-oracle-v1', 'residual-bound-v1'];
  assert.throws(() => buildAutonomousEmpiricalPluginReleasePlan(incomplete),
    /advanced_numerical_coverage_required/);
  assert.throws(() => publishConfiguredAutonomousEmpiricalPluginRelease({
    releaseTemplate: template,
    signingConfigurationPath: path.join(selected.root, 'missing.json'),
    installRoot: selected.installRoot,
  }), /signing_integrity_file_invalid/);
  assert.throws(() => publishConfiguredAutonomousEmpiricalPluginRelease({
    releaseTemplate: template,
    signingConfigurationPath: selected.configurationPath,
    installRoot: selected.installRoot,
    clock: { now: () => new Date() },
    spawnSyncImpl(_command, _args, options) {
      const request = JSON.parse(options.input);
      return {
        status: 0,
        signal: null,
        error: null,
        stderr: '',
        stdout: JSON.stringify({
          version: 1,
          kind: 'AutonomousEmpiricalPluginSigningResponse',
          keyId: request.keyId,
          role: request.role,
          algorithm: request.algorithm,
          payloadHash: request.payloadHash,
          signature: Buffer.alloc(64, 7).toString('base64'),
        }),
      };
    },
  }), /authority_signature_invalid/);
});

test('CLI supports unattended generated-template publish inputs without a private-key option', () => {
  const parsed = parseAutonomousEmpiricalPluginReleaseArguments([
    '--action', 'publish',
    '--package-version', '4.0.0',
    '--benchmark-family', 'ml_algorithm_benchmark',
    '--signing-config', '/run/hepta/plugin-signer.json',
    '--install-root', '/run/hepta/plugin-releases',
  ]);
  assert.equal(parsed.action, 'publish');
  assert.equal(parsed.releaseTemplate.packageVersion, '4.0.0');
  assert.equal(parsed.releaseTemplate.profiles[0].benchmarkFamily,
    'ml_algorithm_benchmark');
  assert.equal(Object.hasOwn(parsed, 'privateKeyPath'), false);
  assert.throws(() => parseAutonomousEmpiricalPluginReleaseArguments([
    '--action', 'publish', '--package-version', '4.0.0',
    '--install-root', '/run/hepta/plugin-releases',
  ]), /signing_configuration_required/);
});
