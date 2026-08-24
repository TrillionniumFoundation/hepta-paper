import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  runP0ExternalAuthorityPreflight,
} from '../bin/p0-external-authority-preflight.mjs';

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
