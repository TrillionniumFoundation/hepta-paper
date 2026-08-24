import assert from 'node:assert/strict';
import test from 'node:test';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  evaluatePersonalSelfHostedProductionReadiness,
  PERSONAL_SELF_HOSTED_NOT_APPLICABLE_CONTROL_IDS,
  PERSONAL_SELF_HOSTED_PRODUCTION_PROFILE,
  PERSONAL_SELF_HOSTED_REQUIRED_LOCAL_CONTROL_IDS,
  verifyPersonalSelfHostedProductionProfile,
} from '../../paper-domain/operations/personal-self-hosted-production-profile-contract.mjs';

const NOW = '2026-08-24T02:00:00.000Z';
const HASH = (label) => hashRecord('PersonalSelfHostedFixture', { label });
const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

function control(status = 'verified', details = {}) {
  const payload = {
    status,
    source: 'local-observation',
    observedAt: NOW,
    details,
  };
  return {
    ...payload,
    evidenceHash: hashRecord('PersonalSelfHostedLocalEvidence', payload),
  };
}

function controls() {
  return Object.fromEntries([
    ['exact-code-provenance', {
      clean: true, commit: COMMIT, commitTree: TREE, repositoryContentHash: HASH('tree'),
    }],
    ['formal-operational-zero-skipped', {
      zeroSkipped: true, pass: 23, fail: 0, skipped: 0, todo: 0, commit: COMMIT,
    }],
    ['local-author-review-session-separation', {
      freshSessionSeparationVerified: true,
      authorSessionHash: HASH('author'), reviewerSessionHash: HASH('reviewer'),
    }],
    ['credential-and-runtime-boundary', {
      privateKeyMaterialAbsent: true, secretLeakScanPassed: true, runtimeOwnerOnly: true,
    }],
    ['database-inventory-and-schema', {
      inventoryReady: true, databaseCount: 3, databaseReadyCount: 3,
    }],
    ['database-restore-drill', {
      restoreDrillReady: true, restoreReceiptHash: HASH('restore'),
    }],
    ['online-anti-rollback', {
      antiRollbackReady: true, integrityPinHash: HASH('anti-rollback'),
    }],
    ['enabled-scientific-oracles', {
      enabledCapabilitiesReady: true, enabledCapabilities: ['cpu'],
    }],
    ['local-slo-alert-policy', {
      alertPolicyConfigured: true, missingDataAlertsExercised: true,
    }],
  ].map(([id, details]) => [id, control('verified', details)]));
}

function externalControls() {
  return Object.fromEntries(PERSONAL_SELF_HOSTED_NOT_APPLICABLE_CONTROL_IDS.map((controlId) => {
    const reasons = {
      'independent-external-authority-roles':
        'no-external-authority-or-multi-operator-release-claim',
      'hardware-kms-hsm': 'no-distributed-release-signing-key-is-used',
      'offhost-worm-custody': 'private-single-host-scope-with-local-backup-contract',
      'venue-portal-live-submission': 'no-external-submission-or-publishing-action',
      'oci-registry-attestation': 'no-oci-registry-distribution',
      'kubernetes-release-digest': 'no-kubernetes-deployment',
    };
    return [controlId, { status: 'not_applicable', reason: reasons[controlId] }];
  }));
}

function readyInput(overrides = {}) {
  return {
    controls: controls(),
    externalControls: externalControls(),
    scientific: {
      enabledCapabilities: ['cpu'],
      cpu: {
        status: 'verified', deterministicReplay: true, errorBudgetVerified: true,
        modelDataCheckpointIrBound: true, evidenceHash: HASH('cpu'), observedAt: NOW,
      },
      gpu: { enabled: false, disabledReason: 'GPU is outside this local profile scope.' },
    },
    observedAt: NOW,
    ...overrides,
  };
}

test('personal profile is explicit, hash-bound, and distinct from distribution readiness', () => {
  assert.equal(verifyPersonalSelfHostedProductionProfile(PERSONAL_SELF_HOSTED_PRODUCTION_PROFILE), true);
  assert.equal(PERSONAL_SELF_HOSTED_PRODUCTION_PROFILE.scope.distributionMode, 'private-local-only');
  assert.equal(PERSONAL_SELF_HOSTED_PRODUCTION_PROFILE.scope.externalActions, false);
  assert.equal(PERSONAL_SELF_HOSTED_REQUIRED_LOCAL_CONTROL_IDS.length, 9);
});

test('personal profile reaches ready only with real local evidence and explicit N/A controls', () => {
  const report = evaluatePersonalSelfHostedProductionReadiness(readyInput());
  assert.equal(report.status, 'personal_self_hosted_production_ready');
  assert.equal(report.fullProductionReady, undefined);
  assert.equal(report.distributionReady, false);
  assert.equal(report.externalQualificationRequired, false);
  assert.deepEqual(report.blockers, []);
});

test('missing or forged local receipts block personal readiness', () => {
  const missing = readyInput({ controls: { ...controls(), 'database-restore-drill': undefined } });
  const result = evaluatePersonalSelfHostedProductionReadiness(missing);
  assert.equal(result.status, 'personal_self_hosted_production_blocked');
  assert.ok(result.blockers.includes(
    'personal_self_hosted_control_not_verified:database-restore-drill',
  ));
  const forged = readyInput({ controls: {
    ...controls(),
    'online-anti-rollback': {
      ...controls()['online-anti-rollback'],
      details: { antiRollbackReady: true, integrityPinHash: HASH('forged') },
      evidenceHash: HASH('not-the-payload-hash'),
    },
  } });
  assert.ok(evaluatePersonalSelfHostedProductionReadiness(forged).blockers.some(
    (item) => item.includes('online-anti-rollback'),
  ));
});

test('GPU opt-in requires same-device scientific receipt but not second hardware', () => {
  const input = readyInput({
    scientific: {
      enabledCapabilities: ['cpu', 'gpu'],
      cpu: {
        status: 'verified', deterministicReplay: true, errorBudgetVerified: true,
        modelDataCheckpointIrBound: true, evidenceHash: HASH('cpu'), observedAt: NOW,
      },
      gpu: {
        enabled: true, status: 'verified', deterministicReplay: true,
        sameDeviceReplay: true, errorBudgetVerified: true, modelDataCheckpointIrBound: true,
        evidenceHash: HASH('gpu'), observedAt: NOW,
      },
    },
  });
  const report = evaluatePersonalSelfHostedProductionReadiness(input);
  assert.equal(report.status, 'personal_self_hosted_production_ready');
  const blocked = evaluatePersonalSelfHostedProductionReadiness({
    ...input,
    scientific: { ...input.scientific, gpu: { ...input.scientific.gpu, sameDeviceReplay: false } },
  });
  assert.ok(blocked.blockers.includes('personal_self_hosted_gpu_oracle_not_ready'));
});

test('external action or unacknowledged N/A cannot be hidden by local evidence', () => {
  const result = evaluatePersonalSelfHostedProductionReadiness({
    ...readyInput(),
    externalActionsPerformed: true,
    externalControls: {
      ...externalControls(),
      'hardware-kms-hsm': { status: 'verified', reason: 'wrong' },
    },
  });
  assert.ok(result.blockers.includes('personal_self_hosted_external_action_forbidden'));
  assert.ok(result.blockers.includes(
    'personal_self_hosted_not_applicable_control_unacknowledged:hardware-kms-hsm',
  ));
});

