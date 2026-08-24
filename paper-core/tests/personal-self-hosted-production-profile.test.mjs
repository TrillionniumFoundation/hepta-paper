import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildPersonalGpuOperationalReceipt,
} from '../../paper-domain/research/personal-gpu-operational-gate-contract.mjs';
import {
  evaluatePersonalSelfHostedProductionReadiness,
  PERSONAL_SELF_HOSTED_NOT_APPLICABLE_CONTROL_IDS,
  PERSONAL_SELF_HOSTED_PRODUCTION_PROFILE,
  PERSONAL_SELF_HOSTED_REQUIRED_LOCAL_CONTROL_IDS,
  verifyPersonalSelfHostedProductionProfile,
} from '../../paper-domain/operations/personal-self-hosted-production-profile-contract.mjs';
import {
  inspectPersonalCpu,
  inspectPersonalRuntimeBoundary,
} from '../verification/personal-self-hosted-local-observation.mjs';

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
  ].map(([id, details]) => [id, control('verified', details)]));
}

function externalControls() {
  return Object.fromEntries(PERSONAL_SELF_HOSTED_NOT_APPLICABLE_CONTROL_IDS.map((controlId) => {
    const reasons = {
      'independent-external-authority-roles':
        'no-external-authority-or-multi-operator-release-claim',
      'hardware-kms-hsm': 'no-distributed-release-signing-key-is-used',
      'local-author-review-session-separation': 'single-operator-no-review-workflow',
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
  const config = JSON.parse(fs.readFileSync(
    new URL('../config/personal-self-hosted-production-profile.v1.json', import.meta.url),
  ));
  assert.deepEqual(config, PERSONAL_SELF_HOSTED_PRODUCTION_PROFILE);
  assert.equal(PERSONAL_SELF_HOSTED_PRODUCTION_PROFILE.scope.distributionMode, 'private-local-only');
  assert.equal(PERSONAL_SELF_HOSTED_PRODUCTION_PROFILE.scope.externalActions, false);
  assert.equal(PERSONAL_SELF_HOSTED_REQUIRED_LOCAL_CONTROL_IDS.length, 7);
  assert.equal(PERSONAL_SELF_HOSTED_REQUIRED_LOCAL_CONTROL_IDS.includes(
    'local-author-review-session-separation',
  ), false);
});

test('personal profile reaches ready only with real local evidence and explicit N/A controls', () => {
  const report = evaluatePersonalSelfHostedProductionReadiness(readyInput());
  assert.equal(report.status, 'personal_self_hosted_production_ready');
  assert.equal(report.personalSelfHostedProductionReady, true);
  assert.equal(report.fullProductionReady, undefined);
  assert.equal(report.distributionReady, false);
  assert.equal(report.externalQualificationRequired, false);
  assert.equal(report.optionalDiagnostics['local-slo-alert-policy'].blocking, false);
  assert.deepEqual(report.blockers, []);
});

test('missing or forged local receipts block personal readiness', () => {
  const missing = readyInput({ controls: { ...controls(), 'database-restore-drill': undefined } });
  const result = evaluatePersonalSelfHostedProductionReadiness(missing);
  assert.equal(result.status, 'personal_self_hosted_production_blocked');
  assert.equal(result.personalSelfHostedProductionReady, false);
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

test('single-operator session separation is explicitly N/A and never requires a receipt', () => {
  const input = readyInput();
  delete input.controls['local-author-review-session-separation'];
  const report = evaluatePersonalSelfHostedProductionReadiness(input);
  assert.equal(report.status, 'personal_self_hosted_production_ready');
  assert.deepEqual(
    report.notApplicableControls.find(
      (item) => item.controlId === 'local-author-review-session-separation',
    ),
    {
      controlId: 'local-author-review-session-separation',
      reason: 'single-operator-no-review-workflow',
    },
  );
});

test('personal runtime boundary rejects source/runtime overlap', () => {
  const overlapping = inspectPersonalRuntimeBoundary({
    workspaceRoot: '/tmp/hepta-personal-workspace',
    runtimeRoot: '/tmp/hepta-personal-workspace/runtime',
  });
  assert.equal(overlapping.physicallyDecoupled, false);
  assert.deepEqual(overlapping.blockers, [
    'personal_self_hosted_runtime_overlaps_workspace',
  ]);
  const separated = inspectPersonalRuntimeBoundary({
    workspaceRoot: '/tmp/hepta-personal-workspace',
    runtimeRoot: '/var/lib/hepta-paper/runtime',
  });
  assert.equal(separated.physicallyDecoupled, true);
  assert.deepEqual(separated.blockers, []);
});

test('CPU readiness consumes the process-isolated oracle even when GPU is not opted in', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-personal-cpu-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receiptPath = path.join(root, 'personal-gpu-operational-receipt.json');
  const imageHash = HASH('image');
  const receipt = buildPersonalGpuOperationalReceipt({
    createdAtEpochMs: Date.parse(NOW),
    workspaceCommit: COMMIT,
    gpu: {
      gpuUuid: 'GPU-a33875b7-7eb7-679e-df08-19227d3decee',
      gpuModel: 'NVIDIA GeForce RTX 4060',
      computeCapability: '8.9',
      driverVersion: '580.173.02',
      memoryMiB: 8188,
    },
    runtime: {
      image: 'hepta/python-gpu:0.15.0', imageDigest: imageHash,
      dockerDigestBound: true, networkDisabled: true, singleDevicePinned: true,
    },
    pde: {
      status: 'canonical_pde_poisson_2d_gpu_scientifically_verified_non_promotable',
      receiptHash: HASH('pde'),
      cpuOracleStatus: 'process_isolated_pde_poisson_2d_cpu_oracle_verified',
      cpuOracleHash: HASH('pde-cpu'),
      scientificChecksPassed: true,
    },
    deepLearning: {
      status: 'personal_deep_learning_gpu_verified_non_promotable',
      originalReceiptHash: HASH('dl-original'),
      replayReceiptHash: HASH('dl-replay'),
      sameDeviceReplayHash: HASH('dl-same-device'),
      cpuOracleHash: HASH('dl-cpu'),
      cpuOracleStatus: 'process_isolated_deep_learning_cpu_oracle_verified',
      hiddenEvaluationHash: HASH('dl-hidden'),
      hiddenEvaluationStatus: 'deep_learning_hidden_evaluation_recorded',
      modelIrHash: HASH('model'),
      datasetManifestHash: HASH('dataset'),
      checkpointManifestHash: HASH('checkpoint'),
      deterministicReplay: true,
      errorBudgetHash: HASH('budget'),
    },
    ir: {
      modelHash: HASH('model'),
      datasetHash: HASH('dataset'),
      checkpointHash: HASH('checkpoint'),
      modelExecutableCodeEmbedded: false,
      checkpointExecutablePayloadAllowed: false,
      pickleAllowed: false,
    },
  });
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o400 });
  fs.chmodSync(receiptPath, 0o400);
  const cpu = inspectPersonalCpu({
    runtimeRoot: root,
    environment: { HEPTA_PERSONAL_CPU_RECEIPT: receiptPath },
    provenance: { commit: COMMIT },
    observedAt: NOW,
  });
  assert.equal(cpu.status, 'verified');
  assert.equal(cpu.deterministicReplay, true);
  assert.ok(cpu.evidenceHash.startsWith('sha256:'));
});
