import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  assertSingleVenueSelection,
  buildSingleVenueLiveCommitAuthorizationSubject,
  buildSingleVenueLiveCommitPermit,
  buildSingleVenueRollbackReceipt,
  buildSingleVenueRollbackRequest,
  buildSingleVenueSubmissionRolloutConfiguration,
  buildSingleVenueSubmissionRolloutPlan,
  consumeSingleVenueLiveCommitPermit,
  verifySingleVenueLiveCommitPermit,
  verifySingleVenueLiveCommitPermitConsumption,
  verifySingleVenueRollbackReceipt,
  verifySingleVenueSubmissionRolloutConfiguration,
  verifySingleVenueSubmissionRolloutPlan,
} from '../../paper-domain/submission/single-venue-rollout-contract.mjs';
import { getJournalSubmissionTargetProfile } from '../../paper-domain/submission/journal-submission-target-registry.mjs';

const hash = (letter) => `sha256:${letter.repeat(64)}`;
const profile = getJournalSubmissionTargetProfile('iclr');
const base = {
  rolloutId: 'rollout-iclr-sandbox',
  venueId: 'iclr',
  targetInstanceId: 'ICLR.cc/2027/Conference',
  baseTargetProfileHash: profile.journalSubmissionTargetProfileHash,
  connectorFamily: 'openreview-api-v2',
  portalOriginHash: hash('a'),
  portalConfigurationHash: hash('b'),
  portalDescriptorHash: hash('c'),
  portalBindingHash: hash('d'),
  sandboxCanaryEvidenceHash: hash('e'),
  attestationHashes: [hash('f'), hash('0')],
  enabledOperations: [
    'discoverProfile', 'validate', 'createDraft', 'uploadAssets',
    'fillMetadata', 'preview', 'getReceipt', 'getStatus', 'reconcile',
  ],
  issuedAt: '2026-08-23T00:00:00.000Z',
  expiresAt: '2026-08-25T00:00:00.000Z',
  rollbackWindowExpiresAt: '2026-08-24T00:00:00.000Z',
};

test('single-venue plan binds one current target and remains sandbox-only', () => {
  assert.equal(assertSingleVenueSelection(['iclr']), 'iclr');
  assert.throws(
    () => assertSingleVenueSelection(['iclr', 'icml']),
    /exactly_one_venue_required/,
  );
  const plan = buildSingleVenueSubmissionRolloutPlan(base);
  assert.equal(plan.status, 'single_venue_submission_rollout_sandbox_only');
  assert.equal(plan.singleVenueConstraint, true);
  assert.equal(plan.liveCommitEnabled, false);
  assert.equal(plan.externalActionPerformed, false);
  assert.equal(verifySingleVenueSubmissionRolloutPlan(plan, {
    now: '2026-08-23T12:00:00.000Z',
    expectedVenueId: 'iclr',
  }), true);
  assert.throws(
    () => buildSingleVenueSubmissionRolloutPlan({ ...base, venues: ['iclr', 'icml'] }),
    /exactly_one_venue_required/,
  );
});

test('checked-in rollout configuration is explicitly inert and fail-closed', () => {
  const configPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '..', 'config', 'submission-single-venue-rollout.v1.json',
  );
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(verifySingleVenueSubmissionRolloutConfiguration(config), true);
  assert.deepEqual(config, buildSingleVenueSubmissionRolloutConfiguration());
  assert.throws(
    () => buildSingleVenueSubmissionRolloutConfiguration({ enabled: true }),
    /template_override_forbidden/,
  );
});

test('rollout rejects credentials, commit operations, and side-effecting canaries', () => {
  assert.throws(
    () => buildSingleVenueSubmissionRolloutPlan({ ...base, token: 'must-not-be-persisted' }),
    /credential_material_forbidden/,
  );
  assert.throws(
    () => buildSingleVenueSubmissionRolloutPlan({
      ...base,
      enabledOperations: [...base.enabledOperations, 'commit'],
    }),
    /commit_or_operation_forbidden/,
  );
  assert.throws(
    () => buildSingleVenueSubmissionRolloutPlan({
      ...base,
      sandboxCanaryExternalActionPerformed: true,
    }),
    /temporal_or_generation_policy_invalid/,
  );
});

test('live commit permit requires an independently verified, dual-control receipt', () => {
  const plan = buildSingleVenueSubmissionRolloutPlan(base);
  const subject = buildSingleVenueLiveCommitAuthorizationSubject(plan);
  const permitInput = {
    plan,
    authorizationReceiptHash: hash('1'),
    authorizationSubjectHash: subject.singleVenueLiveCommitAuthorizationSubjectHash,
    nonce: 'single-use-nonce-20260823',
    authorizerSubjectIds: ['submission-operator-1', 'live-authorizer-1'],
    issuedAt: '2026-08-23T01:00:00.000Z',
    expiresAt: '2026-08-23T02:00:00.000Z',
    authorizationVerifierEvidenceHash: hash('2'),
    verifyAuthorizationReceipt: () => true,
  };
  const permit = buildSingleVenueLiveCommitPermit(permitInput);
  assert.equal(verifySingleVenueLiveCommitPermit(permit, {
    plan,
    now: '2026-08-23T01:30:00.000Z',
  }), true);
  assert.throws(
    () => buildSingleVenueLiveCommitPermit({
      ...permitInput,
      verifyAuthorizationReceipt: () => false,
    }),
    /authorization_verifier_required/,
  );
  const consumed = consumeSingleVenueLiveCommitPermit({
    permit,
    plan,
    consumedAt: '2026-08-23T01:30:00.000Z',
  });
  assert.equal(consumed.externalActionPerformed, false);
  assert.equal(consumed.sideEffectReservationRequired, true);
  assert.equal(verifySingleVenueLiveCommitPermitConsumption(consumed, {
    permit,
    plan,
  }), true);
  assert.throws(
    () => consumeSingleVenueLiveCommitPermit({
      permit,
      plan,
      consumedAt: '2026-08-23T01:31:00.000Z',
      alreadyConsumed: true,
    }),
    /already_consumed/,
  );
});

test('rollback request and receipt are hash-bound and never claim an external action', () => {
  const plan = buildSingleVenueSubmissionRolloutPlan(base);
  const request = buildSingleVenueRollbackRequest({
    plan,
    requestedBy: 'release-attestor',
    reason: 'sandbox descriptor drift detected',
    requestedAt: '2026-08-23T03:00:00.000Z',
  });
  const receipt = buildSingleVenueRollbackReceipt({
    request,
    applied: true,
    appliedAt: '2026-08-23T03:01:00.000Z',
    resultingPlanHash: hash('3'),
  });
  assert.equal(receipt.rollbackApplied, true);
  assert.equal(receipt.externalActionPerformed, false);
  assert.equal(verifySingleVenueRollbackReceipt(receipt), true);
  assert.equal(verifySingleVenueRollbackReceipt({
    ...receipt,
    resultingPlanHash: hash('4'),
  }), false);
});
