import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCycloneDxLockfileSbom,
  cycloneDxSbomBytes,
} from '../verification/cyclonedx-lockfile-sbom.mjs';
import {
  gitTrackedPaths,
  inspectBoundedSast,
  inspectContainerIdentityPolicy,
  inspectSourceSupplyChainSecurity,
  inspectTrackedSecretScan,
  inspectWorkflowActionPins,
  readTrackedTextFiles,
  SOURCE_SECURITY_ASSURANCE_BOUNDARY,
} from '../verification/source-supply-chain-security.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const securityPathsPendingInThisChange = Object.freeze([
  'paper-core/bin/source-supply-chain-security.mjs',
  'paper-core/config/source-supply-chain-sbom.cdx.json',
  'paper-core/config/source-supply-chain-security-policy.v1.json',
  'paper-core/tests/source-supply-chain-security.test.mjs',
  'paper-core/verification/cyclonedx-lockfile-sbom.mjs',
  'paper-core/verification/source-supply-chain-security.mjs',
]);
const containerIdentityFiles = Object.freeze([
  '.github/workflows/ci.yml',
  'paper-core/deploy/autonomous-research-supervisor.k8s.yaml',
  'runtime-images/python-gpu/Dockerfile',
  'runtime-images/python-scientific/Dockerfile',
  'runtime-images/r-scientific/Dockerfile',
]);

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function trackedText(files) {
  return Object.freeze({
    files: Object.freeze(files.map((entry) => Object.freeze(entry))),
    skipped: Object.freeze([]),
    missing: Object.freeze([]),
  });
}

function withTemporaryDirectory(prefix, callback) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try { return callback(temporary); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function copyContainerIdentityFixture(temporary) {
  for (const relative of containerIdentityFiles) {
    const destination = path.join(temporary, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relative), destination);
    // Release candidates are sealed read-only.  copyFileSync preserves the
    // source mode, so normalize fixture copies before the mutation checks.
    fs.chmodSync(destination, 0o600);
  }
}

test('CycloneDX inventory is deterministic and hash-bound to package and lock bytes', () => {
  const packageJson = {
    name: 'security-fixture',
    version: '1.0.0',
    private: true,
    devDependencies: { 'fixture-library': '1.2.3' },
  };
  const packageLock = {
    name: 'security-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'security-fixture',
        version: '1.0.0',
        devDependencies: { 'fixture-library': '1.2.3' },
      },
      'node_modules/fixture-library': {
        version: '1.2.3',
        resolved: 'https://registry.npmjs.org/fixture-library/-/fixture-library-1.2.3.tgz',
        integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        dev: true,
        license: 'MIT',
      },
    },
  };
  const packageJsonBytes = jsonBytes(packageJson);
  const packageLockBytes = jsonBytes(packageLock);
  const first = buildCycloneDxLockfileSbom({ packageJsonBytes, packageLockBytes });
  const second = buildCycloneDxLockfileSbom({ packageJsonBytes, packageLockBytes });
  assert.deepEqual(cycloneDxSbomBytes(first), cycloneDxSbomBytes(second));
  assert.equal(first.bomFormat, 'CycloneDX');
  assert.equal(first.specVersion, '1.5');
  assert.equal(first.components.length, 1);
  assert.equal(first.dependencies.length, 2);
  const properties = Object.fromEntries(first.metadata.properties.map((entry) => (
    [entry.name, entry.value]
  )));
  assert.equal(properties['hepta:sbom:evidence-class'], 'local_package_lock_inventory');
  assert.equal(properties['hepta:sbom:external-attestation'], 'false');
  assert.equal(properties['hepta:sbom:installed-environment-observed'], 'false');
  const changed = buildCycloneDxLockfileSbom({
    packageJsonBytes: jsonBytes({ ...packageJson, description: 'hash drift' }),
    packageLockBytes,
  });
  assert.notDeepEqual(cycloneDxSbomBytes(first), cycloneDxSbomBytes(changed));
  const unresolved = structuredClone(packageLock);
  unresolved.packages[''].dependencies = { absent: '1.0.0' };
  assert.throws(() => buildCycloneDxLockfileSbom({
    packageJsonBytes,
    packageLockBytes: jsonBytes(unresolved),
  }), /cyclonedx_lockfile_dependency_unresolved/);
});

test('secret scan is tracked-file-only, redacted, and exact-hash allowlisted', () => {
  withTemporaryDirectory('hepta-source-secret-', (temporary) => {
    const syntheticAccessKey = ['AK', 'IA', 'A'.repeat(16)].join('');
    fs.writeFileSync(path.join(temporary, 'tracked.mjs'), `const credential = '${syntheticAccessKey}';\n`);
    fs.writeFileSync(path.join(temporary, 'untracked.mjs'), `const credential = '${syntheticAccessKey}';\n`);
    const selected = readTrackedTextFiles({
      workspaceRoot: temporary,
      trackedPaths: ['tracked.mjs'],
    });
    const blocked = inspectTrackedSecretScan({ trackedText: selected });
    assert.equal(blocked.status, 'tracked_secret_scan_blocked');
    assert.equal(blocked.findingCount, 1);
    assert.equal(blocked.findings[0].ruleId, 'aws-access-key-id');
    assert.equal(blocked.findings[0].path, 'tracked.mjs');
    assert.equal(JSON.stringify(blocked).includes(syntheticAccessKey), false);
    const allowed = {
      path: blocked.findings[0].path,
      ruleId: blocked.findings[0].ruleId,
      lineSha256: blocked.findings[0].lineSha256,
      reason: 'Synthetic test-only credential marker.',
    };
    const ready = inspectTrackedSecretScan({ trackedText: selected, allowlist: [allowed] });
    assert.equal(ready.status, 'tracked_secret_scan_ready');
    assert.equal(ready.allowedFindingCount, 1);
    const stale = inspectTrackedSecretScan({
      trackedText: selected,
      allowlist: [{ ...allowed, lineSha256: `sha256:${'0'.repeat(64)}` }],
    });
    assert.match(stale.blockers.join('\n'), /tracked_secret_allowlist_stale/);
    assert.match(stale.blockers.join('\n'), /tracked_secret_finding/);
  });
});

test('bounded SAST rejects selected high-confidence active-source patterns', () => {
  const dynamicEvaluation = ['ev', 'al(userInput);'].join('');
  const report = inspectBoundedSast({
    trackedText: trackedText([{
      path: 'paper-core/bin/unsafe-example.mjs',
      text: `export function run(userInput) { return ${dynamicEvaluation} }\n`,
    }]),
  });
  assert.equal(report.status, 'bounded_sast_blocked');
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['dynamic-eval']);
  assert.equal(report.scope, SOURCE_SECURITY_ASSURANCE_BOUNDARY.sast);
});

test('workflow policy accepts local or exact commits and rejects mutable references', () => {
  const commit = 'a'.repeat(40);
  const report = inspectWorkflowActionPins({
    trackedText: trackedText([{
      path: '.github/workflows/security.yml',
      text: [
        'steps:',
        `  - uses: actions/checkout@${commit}`,
        '  - uses: ./local-action',
        'jobs:',
        '  reusable:',
        '    uses: owner/repository/.github/workflows/reusable.yml@main',
      ].join('\n'),
    }]),
  });
  assert.equal(report.status, 'workflow_action_pin_policy_blocked');
  assert.equal(report.remoteActionCount, 2);
  assert.equal(report.localActionCount, 1);
  assert.equal(report.actions.filter((entry) => entry.pinned).length, 2);
  assert.equal(report.blockers.length, 1);
});

test('container gate verifies identities and explicitly does not claim a CVE scan', () => {
  withTemporaryDirectory('hepta-container-identity-', (temporary) => {
    copyContainerIdentityFixture(temporary);
    const ready = inspectContainerIdentityPolicy({ workspaceRoot: temporary });
    assert.equal(ready.status, 'container_source_identity_policy_ready');
    assert.equal(ready.cveDatabaseScanPerformed, false);
    assert.equal(ready.registryManifestFetched, false);
    assert.equal(ready.runtimeImages.every((entry) => entry.pinned), true);
    assert.equal(ready.dockerfiles.every((entry) => entry.blockers.length === 0), true);
    assert.equal(ready.deploymentTemplateStatus, 'deployment_template_explicitly_non_deployable');
    assert.equal(ready.deploymentTemplateInstantiationReady, false);
    assert.ok(ready.deploymentImages.length > 0);
    assert.equal(ready.deploymentImages.every((entry) => (
      entry.placeholder
        && !entry.pinned
        && !entry.deployable
        && entry.sourcePolicyCompliant
        && entry.disposition === 'explicit_non_deployable_placeholder'
    )), true);
    const dockerfilePath = path.join(temporary, 'runtime-images/python-scientific/Dockerfile');
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
    const unpinned = dockerfile.replace(/^FROM\s+[^\n]+$/mu, 'FROM ubuntu:latest');
    assert.notEqual(unpinned, dockerfile);
    fs.writeFileSync(dockerfilePath, unpinned);
    const blocked = inspectContainerIdentityPolicy({ workspaceRoot: temporary });
    assert.match(blocked.blockers.join('\n'), /dockerfile_base_not_digest_pinned/);
    fs.writeFileSync(dockerfilePath, dockerfile);
    const deploymentPath = path.join(temporary, 'paper-core/deploy/autonomous-research-supervisor.k8s.yaml');
    const deployment = fs.readFileSync(deploymentPath, 'utf8');
    fs.writeFileSync(deploymentPath, deployment.replace(
      'REPLACE_WITH_PINNED_HEPTA_IMAGE_DIGEST',
      'example.invalid/hepta:latest',
    ));
    const mutableDeployment = inspectContainerIdentityPolicy({ workspaceRoot: temporary });
    assert.match(mutableDeployment.blockers.join('\n'), /deployment_container_image_not_digest_pinned_or_explicit_placeholder/);
    fs.writeFileSync(deploymentPath, deployment.replace(
      /^\s*image:\s*REPLACE_WITH_PINNED_HEPTA_IMAGE_DIGEST\s*$/mu,
      '',
    ));
    const missingDeploymentSlot = inspectContainerIdentityPolicy({ workspaceRoot: temporary });
    assert.match(missingDeploymentSlot.blockers.join('\n'), /deployment_container_image_count_mismatch/);
  });
});

test('repository source and supply-chain gate is ready for this complete change surface', () => {
  const trackedPaths = [...new Set([
    ...gitTrackedPaths({ workspaceRoot: root }),
    ...securityPathsPendingInThisChange,
  ])].sort();
  const report = inspectSourceSupplyChainSecurity({ workspaceRoot: root, trackedPaths });
  assert.equal(report.status, 'source_supply_chain_security_ready', report.blockers.join('\n'));
  assert.equal(report.sbom.status, 'cyclonedx_lockfile_sbom_verified');
  assert.equal(report.secrets.status, 'tracked_secret_scan_ready');
  assert.equal(report.sast.status, 'bounded_sast_ready');
  assert.equal(report.workflows.status, 'workflow_action_pin_policy_ready');
  assert.equal(report.containers.status, 'container_source_identity_policy_ready');
  assert.equal(report.containers.deploymentTemplateInstantiationReady, false);
  assert.equal(report.containers.cveDatabaseScanPerformed, false);
  assert.equal(report.sbom.evidenceClass, 'local_package_lock_inventory_not_external_attestation');
  assert.equal(report.deploymentProfile, 'source-inspection');
  assert.equal(report.kubernetesProfileSelected, false);

  const systemdHostProfile = inspectSourceSupplyChainSecurity({
    workspaceRoot: root,
    trackedPaths,
    deploymentProfile: 'systemd-host',
  });
  assert.equal(systemdHostProfile.status, 'source_supply_chain_security_ready');
  assert.equal(systemdHostProfile.deploymentProfile, 'systemd-host');
  assert.equal(systemdHostProfile.deployableTemplatesRequired, false);
  assert.equal(systemdHostProfile.kubernetesProfileSelected, false);

  const releaseProfile = inspectSourceSupplyChainSecurity({
    workspaceRoot: root,
    trackedPaths,
    deploymentProfile: 'kubernetes',
  });
  assert.equal(releaseProfile.status, 'source_supply_chain_security_blocked');
  assert.equal(releaseProfile.deploymentProfile, 'kubernetes');
  assert.equal(releaseProfile.deployableTemplatesRequired, true);
  assert.equal(releaseProfile.kubernetesProfileSelected, true);
  assert.deepEqual(releaseProfile.blockers, ['deployment_container_templates_not_instantiated']);

  assert.throws(
    () => inspectSourceSupplyChainSecurity({
      workspaceRoot: root,
      trackedPaths,
      deploymentProfile: 'systemd-host',
      requireDeployableTemplates: true,
    }),
    /source_supply_chain_security_deployment_profile_invalid/u,
  );
});
