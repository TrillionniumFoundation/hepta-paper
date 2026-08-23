import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOperationalSloAlertPolicy,
  buildProductionIntegrityPin,
  evaluateOperationalSloAlerts,
  inspectProductionIntegrityPinTransition,
  verifyOperationalSloAlert,
  verifyOperationalSloAlertPolicy,
  verifyProductionIntegrityPin,
} from '../../paper-domain/operations/production-integrity-contract.mjs';

const hash = (letter) => `sha256:${letter.repeat(64)}`;
const artifactInput = {
  deploymentGeneration: 1,
  ociImageDigest: hash('a'),
  ociManifestDigest: hash('b'),
  ociConfigDigest: hash('c'),
  ociLayerDigests: [hash('d'), hash('e')],
  kubernetesWorkloadDigest: hash('f'),
  kubernetesManifestHash: hash('0'),
  registryAttestationHash: hash('1'),
  cveAttestationHash: hash('2'),
  databaseInventoryHash: hash('3'),
  databaseHeadSequence: 10,
  databaseHeadHash: hash('4'),
  restoreDrillReceiptHash: hash('5'),
  independentVerifierSubjectHash: hash('6'),
  attestationHashes: [hash('7'), hash('8')],
  issuedAt: '2026-08-23T00:00:00.000Z',
  expiresAt: '2026-08-25T00:00:00.000Z',
};

test('production integrity pin binds OCI, Kubernetes, inventory and restore evidence', () => {
  const pin = buildProductionIntegrityPin(artifactInput);
  assert.equal(pin.status, 'production_integrity_pin_active');
  assert.equal(pin.externalActionPerformed, false);
  assert.equal(verifyProductionIntegrityPin(pin, {
    now: '2026-08-23T12:00:00.000Z',
    expectedOciImageDigest: hash('a'),
  }), true);
  assert.equal(verifyProductionIntegrityPin({ ...pin, ociImageDigest: hash('9') }), false);
  assert.throws(
    () => buildProductionIntegrityPin({ ...artifactInput, imageToken: 'never persist' }),
    /credential_material_forbidden/,
  );
});
test('deployment and database generations reject rollback and equivocation', () => {
  const current = buildProductionIntegrityPin(artifactInput);
  const next = buildProductionIntegrityPin({
    ...artifactInput,
    deploymentGeneration: 2,
    predecessorArtifactPinHash: current.productionIntegrityPinHash,
    databaseHeadSequence: 11,
    databaseHeadHash: hash('9'),
    issuedAt: '2026-08-24T00:00:00.000Z',
    expiresAt: '2026-08-26T00:00:00.000Z',
  });
  assert.deepEqual(
    inspectProductionIntegrityPinTransition({ currentPin: current, candidatePin: next }),
    {
      version: 1,
      kind: 'ProductionIntegrityPinTransitionInspection',
      status: 'production_integrity_transition_accepted',
      accepted: true,
      currentPinHash: current.productionIntegrityPinHash,
      candidatePinHash: next.productionIntegrityPinHash,
      blockers: [],
    },
  );
  const rollback = buildProductionIntegrityPin({
    ...artifactInput,
    deploymentGeneration: 1,
  });
  assert.equal(
    inspectProductionIntegrityPinTransition({ currentPin: next, candidatePin: rollback })
      .blockers.includes('production_integrity_generation_rollback'),
    true,
  );
  const dbRollback = buildProductionIntegrityPin({
    ...artifactInput,
    deploymentGeneration: 2,
    predecessorArtifactPinHash: current.productionIntegrityPinHash,
    databaseHeadSequence: 9,
    databaseHeadHash: hash('4'),
    issuedAt: '2026-08-24T00:00:00.000Z',
    expiresAt: '2026-08-26T00:00:00.000Z',
  });
  assert.equal(
    inspectProductionIntegrityPinTransition({ currentPin: current, candidatePin: dbRollback })
      .blockers.includes('production_integrity_database_head_rollback'),
    true,
  );
});

test('operational SLO policy alerts on missing data and threshold breaches', () => {
  const policy = buildOperationalSloAlertPolicy();
  assert.equal(verifyOperationalSloAlertPolicy(policy), true);
  const healthy = evaluateOperationalSloAlerts({
    policy,
    observed: {
      terminalNodeSuccessRate: 1,
      queueWaitP95Ms: 10,
      recoveryP95Ms: 10,
      runtimeBytes: 1_000,
      restoreAgeMs: 10,
      attestationAgeMs: 10,
    },
  });
  assert.equal(healthy.status, 'operational_slo_healthy');
  assert.deepEqual(healthy.alerts, []);
  const blocked = evaluateOperationalSloAlerts({
    policy,
    observed: { terminalNodeSuccessRate: 0.5, queueWaitP95Ms: 999999 },
  });
  assert.equal(blocked.status, 'operational_slo_alerting');
  assert.ok(blocked.alerts.some((item) => item.status === 'missing_data'));
  assert.ok(blocked.alerts.some((item) => item.status === 'threshold_breached'));
  assert.equal(verifyOperationalSloAlert(blocked.alerts[0], { policy }), true);
  assert.throws(
    () => buildOperationalSloAlertPolicy({ alertOnMissingData: false }),
    /operational_slo_policy_invalid/,
  );
});
