import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

/*
 * Deployment evidence is intentionally independent from the release runner.
 * The runner may obtain these records from an OCI registry, an admission
 * controller, and the off-host backup authority; this module only canonicalizes
 * and verifies the binding.  In particular, a local process cannot advance a
 * generation or turn a mutable image tag into a trusted digest.
 */

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_PIN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const ARTIFACT_KEYS = Object.freeze([
  'attestationHashes',
  'cveAttestationHash',
  'databaseHeadHash',
  'databaseHeadSequence',
  'databaseInventoryHash',
  'deploymentGeneration',
  'expiresAt',
  'externalActionPerformed',
  'independentVerifierSubjectHash',
  'issuedAt',
  'kind',
  'kubernetesManifestHash',
  'kubernetesWorkloadDigest',
  'ociConfigDigest',
  'ociImageDigest',
  'ociLayerDigests',
  'ociLayerDigestSetHash',
  'ociManifestDigest',
  'predecessorArtifactPinHash',
  'registryAttestationHash',
  'restoreDrillReceiptHash',
  'status',
  'version',
]);

const SLO_KEYS = Object.freeze([
  'alertOnMissingData',
  'attestationMaximumAgeMs',
  'kind',
  'maximumQueueWaitP95Ms',
  'maximumRecoveryP95Ms',
  'maximumRuntimeBytes',
  'minimumTerminalNodeSuccessRate',
  'restoreMaximumAgeMs',
  'version',
]);

const ALERT_KEYS = Object.freeze([
  'alertOnMissingData',
  'kind',
  'metric',
  'observed',
  'policyHash',
  'status',
  'threshold',
  'version',
]);

function sha(value, code) {
  const selected = String(value || '').toLowerCase();
  if (!SHA256.test(selected)) throw new Error(code);
  return selected;
}

function instant(value, code) {
  const selected = String(value || '');
  const milliseconds = Date.parse(selected);
  if (!Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== selected) throw new Error(code);
  return selected;
}

function assertCredentialFree(value, seen = new Set(), depth = 0) {
  if (depth > 8 || value === null || value === undefined
    || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (/(?:token|secret|password|private.?key|credential|cookie|api.?key)/i.test(key)) {
      throw new Error('production_integrity_credential_material_forbidden');
    }
    assertCredentialFree(child, seen, depth + 1);
  }
}

function hashes(values, code, { minimum = 1, maximum = 32 } = {}) {
  if (!Array.isArray(values) || values.length < minimum || values.length > maximum) {
    throw new Error(code);
  }
  const selected = [...new Set(values.map((value) => sha(value, code)))].sort();
  if (selected.length !== values.length) throw new Error(`${code}:duplicate`);
  return Object.freeze(selected);
}

function digestSet({ ociManifestDigest, ociConfigDigest, ociLayerDigests }) {
  return hashRecord('ProductionIntegrityOciDigestSet', {
    ociManifestDigest,
    ociConfigDigest,
    ociLayerDigests,
  });
}

function artifactPayload(input = {}) {
  assertCredentialFree(input);
  const {
    deploymentGeneration,
    predecessorArtifactPinHash = null,
    ociImageDigest,
    ociManifestDigest,
    ociConfigDigest,
    ociLayerDigests,
    kubernetesWorkloadDigest,
    kubernetesManifestHash,
    registryAttestationHash,
    cveAttestationHash,
    databaseInventoryHash,
    databaseHeadSequence,
    databaseHeadHash,
    restoreDrillReceiptHash,
    independentVerifierSubjectHash,
    attestationHashes,
    issuedAt,
    expiresAt,
  } = input;
  const generation = Number(deploymentGeneration);
  if (!Number.isSafeInteger(generation) || generation < 1
    || (generation === 1 && predecessorArtifactPinHash !== null)
    || (generation > 1 && !SHA256.test(String(predecessorArtifactPinHash || '')))) {
    throw new Error('production_integrity_generation_invalid');
  }
  const selectedIssuedAt = instant(issuedAt, 'production_integrity_issued_at_invalid');
  const selectedExpiresAt = instant(expiresAt, 'production_integrity_expires_at_invalid');
  if (Date.parse(selectedExpiresAt) <= Date.parse(selectedIssuedAt)
    || Date.parse(selectedExpiresAt) - Date.parse(selectedIssuedAt)
      > MAXIMUM_PIN_LIFETIME_MS) {
    throw new Error('production_integrity_pin_lifetime_invalid');
  }
  const image = sha(ociImageDigest, 'production_integrity_oci_image_digest_invalid');
  const manifest = sha(ociManifestDigest, 'production_integrity_oci_manifest_digest_invalid');
  const config = sha(ociConfigDigest, 'production_integrity_oci_config_digest_invalid');
  const layers = hashes(ociLayerDigests, 'production_integrity_oci_layer_digests_invalid');
  const layerSetHash = digestSet({
    ociManifestDigest: manifest,
    ociConfigDigest: config,
    ociLayerDigests: layers,
  });
  const headSequence = Number(databaseHeadSequence);
  if (!Number.isSafeInteger(headSequence) || headSequence < 1) {
    throw new Error('production_integrity_database_head_sequence_invalid');
  }
  const payload = {
    version: 1,
    kind: 'ProductionIntegrityPin',
    status: 'production_integrity_pin_active',
    deploymentGeneration: generation,
    predecessorArtifactPinHash: predecessorArtifactPinHash === null
      ? null : sha(predecessorArtifactPinHash, 'production_integrity_predecessor_hash_invalid'),
    ociImageDigest: image,
    ociManifestDigest: manifest,
    ociConfigDigest: config,
    ociLayerDigests: layers,
    ociLayerDigestSetHash: layerSetHash,
    kubernetesWorkloadDigest: sha(
      kubernetesWorkloadDigest,
      'production_integrity_kubernetes_workload_digest_invalid',
    ),
    kubernetesManifestHash: sha(
      kubernetesManifestHash,
      'production_integrity_kubernetes_manifest_hash_invalid',
    ),
    registryAttestationHash: sha(
      registryAttestationHash,
      'production_integrity_registry_attestation_invalid',
    ),
    cveAttestationHash: sha(
      cveAttestationHash,
      'production_integrity_cve_attestation_invalid',
    ),
    databaseInventoryHash: sha(
      databaseInventoryHash,
      'production_integrity_database_inventory_invalid',
    ),
    databaseHeadSequence: headSequence,
    databaseHeadHash: sha(databaseHeadHash, 'production_integrity_database_head_hash_invalid'),
    restoreDrillReceiptHash: sha(
      restoreDrillReceiptHash,
      'production_integrity_restore_drill_receipt_invalid',
    ),
    independentVerifierSubjectHash: sha(
      independentVerifierSubjectHash,
      'production_integrity_verifier_subject_invalid',
    ),
    attestationHashes: hashes(
      attestationHashes,
      'production_integrity_attestations_invalid',
      { minimum: 2, maximum: 16 },
    ),
    issuedAt: selectedIssuedAt,
    expiresAt: selectedExpiresAt,
    externalActionPerformed: false,
  };
  return Object.freeze(payload);
}

export function buildProductionIntegrityPin(input = {}) {
  const payload = artifactPayload(input);
  return Object.freeze({
    ...payload,
    productionIntegrityPinHash: hashRecord('ProductionIntegrityPin', payload),
  });
}

export function verifyProductionIntegrityPin(pin, {
  now = null,
  minimumGeneration = 0,
  minimumDatabaseHeadSequence = 0,
  expectedOciImageDigest = null,
} = {}) {
  const { productionIntegrityPinHash: claimedHash, ...payload } = pin || {};
  if (!hasExactObjectKeys(payload, ARTIFACT_KEYS)
    || !SHA256.test(String(claimedHash || ''))
    || claimedHash !== hashRecord('ProductionIntegrityPin', payload)
    || payload.version !== 1
    || payload.kind !== 'ProductionIntegrityPin'
    || payload.status !== 'production_integrity_pin_active'
    || payload.externalActionPerformed !== false
    || !Number.isSafeInteger(Number(minimumGeneration))
    || !Number.isSafeInteger(Number(minimumDatabaseHeadSequence))
    || Number(payload.deploymentGeneration) < Number(minimumGeneration)
    || Number(payload.databaseHeadSequence) < Number(minimumDatabaseHeadSequence)
    || (expectedOciImageDigest !== null
      && payload.ociImageDigest !== String(expectedOciImageDigest).toLowerCase())) return false;
  try {
    const rebuilt = buildProductionIntegrityPin(payload);
    if (JSON.stringify(rebuilt) !== JSON.stringify(pin)) return false;
  } catch { return false; }
  if (now !== null) {
    let observed;
    try { observed = instant(now, 'production_integrity_clock_invalid'); }
    catch { return false; }
    if (Date.parse(observed) < Date.parse(pin.issuedAt)
      || Date.parse(observed) >= Date.parse(pin.expiresAt)) return false;
  }
  return true;
}

export function inspectProductionIntegrityPinTransition({
  currentPin = null,
  candidatePin,
} = {}) {
  const blockers = [];
  if (!verifyProductionIntegrityPin(candidatePin)) {
    blockers.push('production_integrity_candidate_invalid');
  }
  if (currentPin !== null && !verifyProductionIntegrityPin(currentPin)) {
    blockers.push('production_integrity_current_invalid');
  }
  if (!blockers.length && currentPin) {
    const candidateGeneration = Number(candidatePin.deploymentGeneration);
    const currentGeneration = Number(currentPin.deploymentGeneration);
    if (candidateGeneration < currentGeneration) {
      blockers.push('production_integrity_generation_rollback');
    } else if (candidateGeneration === currentGeneration
      && candidatePin.productionIntegrityPinHash !== currentPin.productionIntegrityPinHash) {
      blockers.push('production_integrity_generation_equivocation');
    } else if (candidateGeneration === currentGeneration + 1
      && candidatePin.predecessorArtifactPinHash !== currentPin.productionIntegrityPinHash) {
      blockers.push('production_integrity_predecessor_mismatch');
    } else if (candidateGeneration > currentGeneration + 1) {
      blockers.push('production_integrity_generation_gap');
    }
    if (Number(candidatePin.databaseHeadSequence) < Number(currentPin.databaseHeadSequence)) {
      blockers.push('production_integrity_database_head_rollback');
    } else if (Number(candidatePin.databaseHeadSequence)
        === Number(currentPin.databaseHeadSequence)
      && candidatePin.databaseHeadHash !== currentPin.databaseHeadHash) {
      blockers.push('production_integrity_database_head_equivocation');
    }
  }
  return Object.freeze({
    version: 1,
    kind: 'ProductionIntegrityPinTransitionInspection',
    status: blockers.length
      ? 'production_integrity_transition_blocked'
      : 'production_integrity_transition_accepted',
    accepted: blockers.length === 0,
    currentPinHash: currentPin?.productionIntegrityPinHash || null,
    candidatePinHash: candidatePin?.productionIntegrityPinHash || null,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function boundedInteger(value, code, { minimum = 1, maximum = 365 * 24 * 60 * 60 * 1000 } = {}) {
  const selected = Number(value);
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(code);
  }
  return selected;
}

export function buildOperationalSloAlertPolicy({
  minimumTerminalNodeSuccessRate = 0.95,
  maximumQueueWaitP95Ms = 15 * 60 * 1000,
  maximumRecoveryP95Ms = 5 * 60 * 1000,
  maximumRuntimeBytes = 10 * 1024 ** 3,
  restoreMaximumAgeMs = 24 * 60 * 60 * 1000,
  attestationMaximumAgeMs = 60 * 60 * 1000,
  alertOnMissingData = true,
} = {}) {
  const successRate = Number(minimumTerminalNodeSuccessRate);
  if (!Number.isFinite(successRate) || successRate < 0 || successRate > 1
    || alertOnMissingData !== true) {
    throw new Error('operational_slo_policy_invalid');
  }
  const payload = {
    version: 1,
    kind: 'OperationalSloAlertPolicy',
    minimumTerminalNodeSuccessRate: successRate,
    maximumQueueWaitP95Ms: boundedInteger(
      maximumQueueWaitP95Ms,
      'operational_slo_queue_wait_threshold_invalid',
    ),
    maximumRecoveryP95Ms: boundedInteger(
      maximumRecoveryP95Ms,
      'operational_slo_recovery_threshold_invalid',
    ),
    maximumRuntimeBytes: boundedInteger(
      maximumRuntimeBytes,
      'operational_slo_runtime_threshold_invalid',
      { maximum: Number.MAX_SAFE_INTEGER },
    ),
    restoreMaximumAgeMs: boundedInteger(
      restoreMaximumAgeMs,
      'operational_slo_restore_age_threshold_invalid',
    ),
    attestationMaximumAgeMs: boundedInteger(
      attestationMaximumAgeMs,
      'operational_slo_attestation_age_threshold_invalid',
    ),
    alertOnMissingData: true,
  };
  return Object.freeze({
    ...payload,
    operationalSloAlertPolicyHash: hashRecord('OperationalSloAlertPolicy', payload),
  });
}

export function verifyOperationalSloAlertPolicy(policy) {
  const { operationalSloAlertPolicyHash: claimedHash, ...payload } = policy || {};
  if (!hasExactObjectKeys(payload, SLO_KEYS)
    || !SHA256.test(String(claimedHash || ''))
    || claimedHash !== hashRecord('OperationalSloAlertPolicy', payload)) return false;
  try {
    return JSON.stringify(buildOperationalSloAlertPolicy(payload))
      === JSON.stringify(policy);
  } catch { return false; }
}

function alert(policy, metric, observed, threshold, status) {
  const payload = {
    version: 1,
    kind: 'OperationalSloAlert',
    policyHash: policy.operationalSloAlertPolicyHash,
    status,
    alertOnMissingData: true,
    observed: observed === undefined ? null : observed,
    threshold,
  };
  return Object.freeze({
    ...payload,
    metric,
    operationalSloAlertHash: hashRecord('OperationalSloAlert', { ...payload, metric }),
  });
}

export function verifyOperationalSloAlert(value, { policy = null } = {}) {
  const { operationalSloAlertHash: claimedHash, ...payload } = value || {};
  if (!hasExactObjectKeys(payload, ALERT_KEYS)
    || !SHA256.test(String(claimedHash || ''))
    || claimedHash !== hashRecord('OperationalSloAlert', payload)
    || payload.kind !== 'OperationalSloAlert'
    || !['missing_data', 'threshold_breached'].includes(payload.status)
    || payload.alertOnMissingData !== true
    || (policy && payload.policyHash !== policy.operationalSloAlertPolicyHash)) return false;
  return true;
}

export function evaluateOperationalSloAlerts({ policy, observed = {} } = {}) {
  if (!verifyOperationalSloAlertPolicy(policy)) {
    throw new Error('operational_slo_policy_invalid');
  }
  const checks = [
    ['terminalNodeSuccessRate', observed.terminalNodeSuccessRate,
      policy.minimumTerminalNodeSuccessRate, (value, threshold) => value >= threshold],
    ['queueWaitP95Ms', observed.queueWaitP95Ms,
      policy.maximumQueueWaitP95Ms, (value, threshold) => value <= threshold],
    ['recoveryP95Ms', observed.recoveryP95Ms,
      policy.maximumRecoveryP95Ms, (value, threshold) => value <= threshold],
    ['runtimeBytes', observed.runtimeBytes,
      policy.maximumRuntimeBytes, (value, threshold) => value <= threshold],
    ['restoreAgeMs', observed.restoreAgeMs,
      policy.restoreMaximumAgeMs, (value, threshold) => value <= threshold],
    ['attestationAgeMs', observed.attestationAgeMs,
      policy.attestationMaximumAgeMs, (value, threshold) => value <= threshold],
  ];
  const alerts = checks.map(([metric, value, threshold, passes]) => {
    const numeric = typeof value === 'number' && Number.isFinite(value);
    if (!numeric) return alert(policy, metric, value, threshold, 'missing_data');
    return passes(value, threshold)
      ? null : alert(policy, metric, value, threshold, 'threshold_breached');
  }).filter(Boolean);
  if (alerts.some((item) => !verifyOperationalSloAlert(item, { policy }))) {
    throw new Error('operational_slo_alert_internal_invalid');
  }
  const payload = {
    version: 1,
    kind: 'OperationalSloAlertEvaluation',
    status: alerts.length ? 'operational_slo_alerting' : 'operational_slo_healthy',
    policyHash: policy.operationalSloAlertPolicyHash,
    alerts: Object.freeze(alerts),
    observed: Object.freeze({ ...observed }),
  };
  return Object.freeze({
    ...payload,
    operationalSloAlertEvaluationHash: hashRecord(
      'OperationalSloAlertEvaluation',
      payload,
    ),
  });
}

export const PRODUCTION_INTEGRITY_POLICY = Object.freeze({
  version: 1,
  kind: 'ProductionIntegrityPolicy',
  mutableImageTagsAccepted: false,
  kubernetesDigestRequired: true,
  ociLayerSetRequired: true,
  cveAttestationRequired: true,
  registryAttestationRequired: true,
  databaseInventoryRequired: true,
  restoreDrillRequired: true,
  antiRollbackRequired: true,
  independentVerifierRequired: true,
});
