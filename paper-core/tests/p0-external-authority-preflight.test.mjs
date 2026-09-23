import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  runP0ExternalAuthorityPreflight,
} from '../bin/p0-external-authority-preflight.mjs';
import {
  buildOperationalSloAlertPolicy,
  buildProductionIntegrityPin,
} from '../../paper-domain/operations/production-integrity-contract.mjs';

function directorySnapshot(root) {
  return JSON.stringify(fs.readdirSync(root, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
  })));
}

test('P0 external-authority preflight is read-only and fails closed without evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-p0-preflight-'));
  const workspaceRoot = path.join(root, 'workspace');
  const runtimeRoot = path.join(root, 'runtime');
  const assetRoot = path.join(root, 'assets');
  for (const directory of [workspaceRoot, runtimeRoot, assetRoot]) fs.mkdirSync(directory);
  const before = [workspaceRoot, runtimeRoot, assetRoot].map(directorySnapshot);

  const report = runP0ExternalAuthorityPreflight({
    workspaceRoot,
    runtimeRoot,
    assetRoot,
    environment: Object.freeze({}),
    now: '2026-08-23T14:00:00.000Z',
  });

  assert.equal(report.kind, 'P0ExternalAuthorityPreflight');
  assert.equal(report.status, 'p0_external_authority_preflight_blocked');
  assert.equal(report.readOnly, true);
  assert.equal(report.secretsRead, false);
  assert.equal(report.credentialsGenerated, false);
  assert.equal(report.hashesGenerated, false);
  assert.equal(report.acceptanceGenerated, false);
  assert.equal(report.externalActionPerformed, false);
  assert.ok(report.blockers.includes('authority_trust_store_missing'));
  assert.ok(report.blockers.includes('single_venue_rollout_configuration_missing_or_invalid'));
  assert.ok(report.blockers.includes('restore_drill_passed_receipt_missing'));
  assert.equal(report.sections.capabilityProofCoverage.requiredCapabilityCount, 16);
  assert.equal(report.sections.capabilityProofCoverage.releaseBoundConformanceCount, 0);
  assert.equal(report.sections.capabilityProofCoverage.independentProductionProofCount, 0);
  assert.ok(report.blockers.includes('release_bound_conformance_not_complete:0/16'));
  assert.ok(report.blockers.includes('independent_production_proof_not_complete:0/16'));
  assert.deepEqual(
    [workspaceRoot, runtimeRoot, assetRoot].map(directorySnapshot),
    before,
  );
});

test('P0 preflight rejects a sandbox evidence document that claims external action', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-p0-canary-'));
  const workspaceRoot = path.join(root, 'workspace');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(runtimeRoot);
  const configPath = path.join(root, 'single-venue.json');
  const evidencePath = path.join(root, 'sandbox-evidence.json');
  fs.writeFileSync(configPath, JSON.stringify({
    kind: 'SingleVenueSubmissionRolloutConfiguration',
    enabled: true,
    venueId: 'fixture-venue',
    targetInstanceId: 'fixture-target',
    credentialsPresent: true,
    productionReady: true,
    liveCommitEnabled: true,
    humanSingleUseAuthorizationRequired: true,
    externalActionPerformed: false,
    sandboxCanaryEvidencePath: evidencePath,
  }));
  fs.writeFileSync(evidencePath, JSON.stringify({
    kind: 'SandboxCanaryEvidence',
    externalActionPerformed: true,
  }));

  const report = runP0ExternalAuthorityPreflight({
    workspaceRoot,
    runtimeRoot,
    environment: Object.freeze({
      HEPTA_SINGLE_VENUE_ROLLOUT_CONFIG: configPath,
    }),
  });
  assert.ok(report.blockers.includes('single_venue_sandbox_canary_external_action_forbidden'));
  assert.equal(report.sections.singleVenue.externalActionPerformed, false);
  assert.equal(report.sections.singleVenue.sandboxEvidenceExternalActionPerformed, true);
});

test('P0 preflight rejects one local-admin key reused for all authority roles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-p0-roles-'));
  const workspaceRoot = path.join(root, 'workspace');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(runtimeRoot);
  const trustPath = path.join(root, 'trust.json');
  fs.writeFileSync(trustPath, JSON.stringify({
    kind: 'AuthorityTrustStore',
    keys: [{
      keyId: 'shared-local-admin',
      subjectId: 'shared-local-admin',
      status: 'active',
      assurance: 'local_admin_delegated',
      roles: ['research-author', 'independent-reviewer', 'release-attestor', 'external-qualifier'],
      publicKeyPem: '-----BEGIN PUBLIC KEY-----fixture-----END PUBLIC KEY-----',
    }],
  }));
  const configPath = path.join(root, 'kms.json');
  fs.writeFileSync(configPath, JSON.stringify({
    kind: 'ReleaseAttestorConfiguration',
    backend: {
      kind: 'external-kms-command',
      hardwareProtected: true,
      privateKeyExportable: false,
    },
  }));
  const wrongPin = `sha256:${crypto.createHash('sha256').update('wrong').digest('hex')}`;
  const report = runP0ExternalAuthorityPreflight({
    workspaceRoot,
    runtimeRoot,
    environment: {
      HEPTA_AUTHORITY_TRUST_STORE: trustPath,
      HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG: configPath,
      HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH: wrongPin,
    },
  });
  assert.ok(report.blockers.includes('authority_role_subjects_must_be_distinct'));
  assert.ok(report.blockers.includes('authority_role_external_assurance_required:research-author'));
  assert.ok(report.blockers.includes('release_attestor_configuration_pin_mismatch'));
});

test('P1/P2 integrity and SLO observations require canonical contract hashes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-p1p2-contracts-'));
  const workspaceRoot = path.join(root, 'workspace');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(runtimeRoot);
  fs.mkdirSync(path.join(runtimeRoot, 'production-integrity'));
  fs.mkdirSync(path.join(runtimeRoot, 'operations'));
  fs.mkdirSync(path.join(workspaceRoot, 'paper-core'), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, 'paper-core', 'config'));
  // Keep the schema present so the SLO result isolates the canonical-hash
  // failure rather than the expected missing-schema observation.
  fs.writeFileSync(
    path.join(workspaceRoot, 'paper-core', 'config', 'production-integrity-policy.schema.json'),
    '{}',
  );
  const digest = (suffix) => `sha256:${String(suffix).repeat(64).slice(0, 64)}`;
  const validPin = buildProductionIntegrityPin({
    deploymentGeneration: 1,
    ociImageDigest: digest('a'),
    ociManifestDigest: digest('b'),
    ociConfigDigest: digest('c'),
    ociLayerDigests: [digest('d')],
    kubernetesWorkloadDigest: digest('e'),
    kubernetesManifestHash: digest('f'),
    registryAttestationHash: digest('1'),
    cveAttestationHash: digest('2'),
    databaseInventoryHash: digest('3'),
    databaseHeadSequence: 1,
    databaseHeadHash: digest('4'),
    restoreDrillReceiptHash: digest('5'),
    independentVerifierSubjectHash: digest('6'),
    attestationHashes: [digest('7'), digest('8')],
    issuedAt: '2026-08-23T00:00:00.000Z',
    expiresAt: '2026-08-24T00:00:00.000Z',
  });
  const tamperedPin = { ...validPin, ociImageDigest: digest('9') };
  fs.writeFileSync(
    path.join(runtimeRoot, 'production-integrity', 'PRODUCTION_INTEGRITY_PIN.json'),
    JSON.stringify(tamperedPin),
  );
  fs.chmodSync(
    path.join(runtimeRoot, 'production-integrity', 'PRODUCTION_INTEGRITY_PIN.json'),
    0o600,
  );
  const policy = buildOperationalSloAlertPolicy();
  const tamperedPolicy = {
    ...policy,
    maximumQueueWaitP95Ms: policy.maximumQueueWaitP95Ms + 1,
  };
  const policyPath = path.join(runtimeRoot, 'operations', 'slo-policy.json');
  fs.writeFileSync(policyPath, JSON.stringify(tamperedPolicy));
  fs.chmodSync(policyPath, 0o600);

  const report = runP0ExternalAuthorityPreflight({
    workspaceRoot,
    runtimeRoot,
    environment: Object.freeze({ HEPTA_OPERATIONAL_SLO_POLICY_PATH: policyPath }),
  });
  assert.ok(report.blockers.includes('production_integrity_pin_contract_invalid'));
  assert.equal(report.sections.antiRollback.contractValid, false);
  assert.ok(report.blockers.includes('operational_slo_policy_contract_invalid'));
  assert.equal(report.sections.slo.policyContractValid, false);
});

test('P1 OCI observation rejects present but non-independent attestations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-p1-oci-'));
  const workspaceRoot = path.join(root, 'workspace');
  const runtimeRoot = path.join(root, 'runtime');
  const attestations = path.join(runtimeRoot, 'attestations');
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(attestations, { recursive: true });
  const paths = {
    pin: path.join(attestations, 'pin.json'),
    verifier: path.join(attestations, 'verifier.json'),
    registry: path.join(attestations, 'registry.json'),
    cve: path.join(attestations, 'cve.json'),
  };
  const write = (filePath, value) => {
    fs.writeFileSync(filePath, JSON.stringify(value));
    fs.chmodSync(filePath, 0o600);
  };
  write(paths.pin, { kind: 'ProductionIntegrityPin', status: 'production_integrity_pin_active' });
  write(paths.verifier, {
    kind: 'RuntimeImageReproducibilityReceipt',
    version: 2,
    status: 'runtime_image_reproducibility_external_attestations_recorded',
    externalActionPerformed: true,
    privateSigningKeyLoadedByController: false,
    assurance: 'two-independent-ed25519-attested-oci-layouts-v0',
    responses: [],
  });
  write(paths.registry, { kind: 'RegistryAttestation', status: 'verified', independentAuthority: false });
  write(paths.cve, { kind: 'CveAttestation', status: 'verified', independentAuthority: false });
  const report = runP0ExternalAuthorityPreflight({
    workspaceRoot,
    runtimeRoot,
    environment: {
      HEPTA_PRODUCTION_INTEGRITY_PIN_PATH: paths.pin,
      HEPTA_OCI_INDEPENDENT_VERIFIER_PATH: paths.verifier,
      HEPTA_REGISTRY_ATTESTATION_PATH: paths.registry,
      HEPTA_CVE_ATTESTATION_PATH: paths.cve,
    },
  });
  assert.ok(report.blockers.includes('oci_production_integrity_pin_contract_invalid'));
  assert.ok(report.blockers.includes('oci_independent_verifier_attestation_invalid'));
  assert.ok(report.blockers.includes('oci_registry_attestation_invalid'));
  assert.ok(report.blockers.includes('oci_cve_attestation_invalid'));
  assert.equal(report.sections.oci.bitwiseRebuildVerified, false);
  assert.equal(report.sections.oci.independentVerifierCount, 0);
});

test('P1 restore observation rejects a status-only drill receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-p1-restore-'));
  const workspaceRoot = path.join(root, 'workspace');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(runtimeRoot);
  const receiptPath = path.join(root, 'restore.receipt.json');
  fs.writeFileSync(receiptPath, JSON.stringify({
    version: 2,
    kind: 'HeptaStoreRestoreDrillReceipt',
    status: 'hepta_store_restore_drill_passed',
  }));
  fs.chmodSync(receiptPath, 0o600);
  const report = runP0ExternalAuthorityPreflight({
    workspaceRoot,
    runtimeRoot,
    environment: { HEPTA_RESTORE_DRILL_RECEIPT_PATH: receiptPath },
  });
  assert.ok(report.blockers.includes('restore_drill_receipt_contract_invalid'));
  assert.equal(report.sections.restore.receiptContractValid, false);
});

test('P1 Kubernetes observation requires every image and the workload annotation by digest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-p1-kubernetes-'));
  const workspaceRoot = path.join(root, 'workspace');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(runtimeRoot);
  const manifestPath = path.join(root, 'deployment.yaml');
  fs.writeFileSync(manifestPath, `apiVersion: apps/v1
kind: Deployment
metadata:
  annotations:
    hepta.paper/kubernetes-workload-digest: sha256:${'a'.repeat(64)}
spec:
  template:
    spec:
      initContainers:
        - name: pinned
          image: example.invalid/hepta@sha256:${'b'.repeat(64)}
      containers:
        - name: mutable
          image: example.invalid/hepta:latest
`);
  const report = runP0ExternalAuthorityPreflight({
    workspaceRoot,
    runtimeRoot,
    environment: { HEPTA_KUBERNETES_MANIFEST: manifestPath },
  });
  assert.ok(report.blockers.includes('kubernetes_image_digest_missing_or_unpinned'));
  assert.equal(report.sections.kubernetes.imageReferenceCount, 2);
  assert.equal(report.sections.kubernetes.pinnedImageReferenceCount, 1);
  assert.equal(report.sections.kubernetes.allImagesPinned, false);
  assert.equal(report.sections.kubernetes.workloadDigestPresent, true);
});
