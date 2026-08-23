import assert from 'node:assert/strict';
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
