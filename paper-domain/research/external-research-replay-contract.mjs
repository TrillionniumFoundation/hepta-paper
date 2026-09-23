import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const REQUEST_KEYS = Object.freeze([
  'campaignId', 'experimentPairs', 'formalReplayReceiptHashes', 'kind', 'paperId',
  'requestHash', 'sourceSnapshotHash', 'version',
]);

function identifier(value) {
  const candidate = String(value || '').trim();
  return SAFE_ID.test(candidate) ? candidate : null;
}

function sha(value) {
  const candidate = String(value || '').toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}

function hashes(values, maximum = 256) {
  if (!Array.isArray(values) || values.length > maximum) return null;
  const selected = values.map(sha);
  if (selected.some((value) => !value) || new Set(selected).size !== selected.length) return null;
  return Object.freeze([...selected].sort());
}

function experimentPairs(values, { allowEmpty = false } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && !values.length) || values.length > 128) {
    return null;
  }
  const selected = values.map((value) => Object.freeze({
    originalExperimentRunReceiptHash: sha(value?.originalExperimentRunReceiptHash),
    localReplayExperimentRunReceiptHash: sha(value?.localReplayExperimentRunReceiptHash),
    localReplayObservationManifestHash: sha(value?.localReplayObservationManifestHash),
  }));
  if (selected.some((value) => Object.values(value).some((field) => !field))) return null;
  const keys = selected.map((value) => value.originalExperimentRunReceiptHash);
  if (new Set(keys).size !== keys.length) return null;
  return Object.freeze([...selected].sort((left, right) => (
    left.originalExperimentRunReceiptHash.localeCompare(right.originalExperimentRunReceiptHash)
  )));
}

export function buildExternalResearchReplayRequest({
  paperId,
  campaignId,
  sourceSnapshotHash,
  experimentPairs: pairs,
  formalReplayReceiptHashes = [],
} = {}) {
  const formalHashes = hashes(formalReplayReceiptHashes);
  const selectedPairs = experimentPairs(pairs, {
    // A formal-domain qualification replay has no empirical run by design.  It
    // remains non-empty evidence because at least one independently replayed
    // formal receipt is mandatory.
    allowEmpty: Array.isArray(formalHashes) && formalHashes.length > 0,
  });
  const payload = {
    version: 1,
    kind: 'ExternalResearchReplayRequest',
    paperId: identifier(paperId),
    campaignId: identifier(campaignId),
    sourceSnapshotHash: sha(sourceSnapshotHash),
    experimentPairs: selectedPairs,
    formalReplayReceiptHashes: formalHashes,
  };
  if (Object.values(payload).some((value) => value === null)
    || (selectedPairs.length === 0 && formalHashes.length === 0)) {
    throw new Error('external_research_replay_request_invalid');
  }
  return Object.freeze({
    ...payload,
    requestHash: hashRecord('ExternalResearchReplayRequest', payload),
  });
}

export function verifyExternalResearchReplayRequest(request) {
  if (!hasExactObjectKeys(request, REQUEST_KEYS)) return false;
  try {
    return JSON.stringify(buildExternalResearchReplayRequest(request)) === JSON.stringify(request);
  } catch { return false; }
}

export function buildExternalResearchReplayReceipt({
  request,
  serviceId,
  principalId,
  providerAccountIdentityHash,
  credentialRootIdentityHash,
  hostIdentityHash,
  processIdentityHash,
  trustDomainIdentityHash,
  resultManifestHash,
  reproducedExperimentRunReceiptHashes,
  reproducedFormalReplayReceiptHashes = [],
  signerIdentityHash,
  signatureHash,
  signatureVerificationReceiptHash,
  replayedAt,
} = {}) {
  const experimentHashes = hashes(reproducedExperimentRunReceiptHashes);
  const formalHashes = hashes(reproducedFormalReplayReceiptHashes);
  const expectedExperimentHashes = hashes(request?.experimentPairs?.map(
    (pair) => pair.originalExperimentRunReceiptHash,
  ));
  if (!verifyExternalResearchReplayRequest(request)
    || !identifier(serviceId) || !identifier(principalId)
    || ![
      providerAccountIdentityHash,
      credentialRootIdentityHash,
      hostIdentityHash,
      processIdentityHash,
      trustDomainIdentityHash,
      resultManifestHash,
      signerIdentityHash,
      signatureHash,
      signatureVerificationReceiptHash,
    ].every((value) => sha(value))
    || !experimentHashes || !formalHashes
    || JSON.stringify(experimentHashes) !== JSON.stringify(expectedExperimentHashes)
    || JSON.stringify(formalHashes) !== JSON.stringify(request.formalReplayReceiptHashes)
    || !Number.isFinite(Date.parse(String(replayedAt || '')))) {
    throw new Error('external_research_replay_receipt_invalid');
  }
  const payload = {
    version: 1,
    kind: 'ExternalResearchReplayReceipt',
    status: 'external_research_replay_verified',
    paperId: request.paperId,
    campaignId: request.campaignId,
    externalReplayRequestHash: request.requestHash,
    sourceSnapshotHash: request.sourceSnapshotHash,
    serviceId,
    principalId,
    providerAccountIdentityHash: sha(providerAccountIdentityHash),
    credentialRootIdentityHash: sha(credentialRootIdentityHash),
    hostIdentityHash: sha(hostIdentityHash),
    processIdentityHash: sha(processIdentityHash),
    trustDomainIdentityHash: sha(trustDomainIdentityHash),
    resultManifestHash: sha(resultManifestHash),
    reproducedExperimentRunReceiptHashes: experimentHashes,
    reproducedFormalReplayReceiptHashes: formalHashes,
    allResultsMatched: true,
    processIndependent: true,
    hostIndependent: true,
    accountIndependent: true,
    trustDomainIndependent: true,
    signerIdentityHash: sha(signerIdentityHash),
    signatureHash: sha(signatureHash),
    signatureVerificationReceiptHash: sha(signatureVerificationReceiptHash),
    externalActionPerformed: true,
    replayedAt: new Date(replayedAt).toISOString(),
  };
  return Object.freeze({
    ...payload,
    externalResearchReplayReceiptHash:
      hashRecord('ExternalResearchReplayReceipt', payload),
  });
}

export function buildCryptographicExternalResearchReplayReceipt({
  request,
  legacyReceipt,
  authorityEnvelope,
  signatureVerificationReceipt,
} = {}) {
  const legacyReceiptHash = legacyReceipt?.externalResearchReplayReceiptHash || null;
  const verificationHash = signatureVerificationReceipt
    ?.pinnedExternalEvidenceVerificationReceiptHash || null;
  const {
    pinnedExternalEvidenceVerificationReceiptHash: _verificationHash,
    ...verificationPayload
  } = signatureVerificationReceipt || {};
  const authorityEnvelopeHash = authorityEnvelope
    ? hashRecord('PinnedExternalEvidenceEnvelope', authorityEnvelope) : null;
  if (!verifyExternalResearchReplayReceipt(legacyReceipt, { request })
    || signatureVerificationReceipt?.kind
      !== 'PinnedExternalEvidenceVerificationReceipt'
    || signatureVerificationReceipt?.status !== 'pinned_external_evidence_verified'
    || signatureVerificationReceipt?.cryptographicAuthorityReady !== true
    || signatureVerificationReceipt?.subjectKind
      !== 'ExternalResearchReplayReceiptV1'
    || signatureVerificationReceipt?.subjectHash !== legacyReceiptHash
    || signatureVerificationReceipt?.requiredRole !== 'external_research_replay_attestor'
    || signatureVerificationReceipt?.envelopeHash !== authorityEnvelopeHash
    || !sha(verificationHash)
    || hashRecord('PinnedExternalEvidenceVerificationReceipt', verificationPayload)
      !== verificationHash
    || authorityEnvelope?.subjectKind !== 'ExternalResearchReplayReceiptV1'
    || authorityEnvelope?.subjectHash !== legacyReceiptHash) {
    throw new Error('cryptographic_external_research_replay_receipt_invalid');
  }
  const payload = {
    version: 2,
    kind: 'ExternalResearchReplayReceipt',
    status: 'external_research_replay_cryptographically_verified',
    paperId: request.paperId,
    campaignId: request.campaignId,
    externalReplayRequestHash: request.requestHash,
    sourceSnapshotHash: request.sourceSnapshotHash,
    legacyReceiptHash,
    legacyReceipt,
    authorityEnvelopeHash,
    authorityEnvelope,
    signatureVerificationReceiptHash: verificationHash,
    signatureVerificationReceipt,
    cryptographicAuthorityReady: true,
    // The v1 payload contains identity hashes, but no provider/platform identity
    // attestation. Keep every independence claim false until the v2 identity
    // separation contract is supplied and verified.
    identityIndependenceReady: false,
    processIndependent: false,
    hostIndependent: false,
    accountIndependent: false,
    credentialIndependent: false,
    trustDomainIndependent: false,
    externalActionPerformed: true,
    replayedAt: legacyReceipt.replayedAt,
  };
  return Object.freeze({
    ...payload,
    externalResearchReplayReceiptHash:
      hashRecord('ExternalResearchReplayReceiptV2', payload),
  });
}

export function buildStrongExternalResearchReplayReceipt({
  request,
  legacyReceipt,
  resultAuthorityEnvelope,
  remoteIdentityAttestationBundle,
  localOriginIdentityAttestationBundles,
  identitySeparationReceipt,
  configurationHash,
  trustSetHash,
  signatureVerificationPolicyHash,
} = {}) {
  const legacyReceiptHash = legacyReceipt?.externalResearchReplayReceiptHash || null;
  const resultAuthorityEnvelopeHash = resultAuthorityEnvelope
    ? hashRecord('PinnedExternalEvidenceEnvelope', resultAuthorityEnvelope) : null;
  const originBundles = Array.isArray(localOriginIdentityAttestationBundles)
    ? localOriginIdentityAttestationBundles : [];
  const originBundleHashes = originBundles.map((bundle) => sha(bundle?.bundleHash));
  const separationHash = identitySeparationReceipt
    ?.externalPrincipalIdentitySeparationReceiptHash || null;
  const { externalPrincipalIdentitySeparationReceiptHash: _separationHash,
    ...separationPayload } = identitySeparationReceipt || {};
  if (!verifyExternalResearchReplayReceipt(legacyReceipt, { request })
    || resultAuthorityEnvelope?.subjectKind !== 'ExternalResearchReplayReceiptV1'
    || resultAuthorityEnvelope?.subjectHash !== legacyReceiptHash
    || !sha(resultAuthorityEnvelopeHash)
    || !sha(remoteIdentityAttestationBundle?.bundleHash)
    || originBundles.length < 1 || originBundles.length > 64
    || originBundleHashes.some((hash) => !hash)
    || new Set(originBundleHashes).size !== originBundleHashes.length
    || identitySeparationReceipt?.kind
      !== 'ExternalPrincipalIdentitySeparationReceipt'
    || identitySeparationReceipt?.status
      !== 'external_principal_identity_separation_verified'
    || identitySeparationReceipt?.identityIndependenceReady !== true
    || hashRecord('ExternalPrincipalIdentitySeparationReceipt', separationPayload)
      !== separationHash
    || ![configurationHash, trustSetHash, signatureVerificationPolicyHash]
      .every((value) => sha(value))) {
    throw new Error('strong_external_research_replay_receipt_invalid');
  }
  const payload = {
    version: 3,
    kind: 'ExternalResearchReplayReceipt',
    status: 'external_research_replay_strong_verified',
    paperId: request.paperId,
    campaignId: request.campaignId,
    externalReplayRequestHash: request.requestHash,
    sourceSnapshotHash: request.sourceSnapshotHash,
    legacyReceiptHash,
    legacyReceipt,
    resultAuthorityEnvelopeHash,
    resultAuthorityEnvelope,
    remoteIdentityAttestationBundleHash: remoteIdentityAttestationBundle.bundleHash,
    remoteIdentityAttestationBundle,
    localOriginIdentityAttestationBundleHashes: Object.freeze([...originBundleHashes]),
    localOriginIdentityAttestationBundles: Object.freeze([...originBundles]),
    identitySeparationReceiptHash: separationHash,
    identitySeparationReceipt,
    configurationHash: sha(configurationHash),
    trustSetHash: sha(trustSetHash),
    signatureVerificationPolicyHash: sha(signatureVerificationPolicyHash),
    cryptographicAuthorityReady: true,
    identityIndependenceReady: true,
    signerIndependent: true,
    processIndependent: true,
    hostIndependent: true,
    accountIndependent: true,
    credentialIndependent: true,
    trustDomainIndependent: true,
    externalActionPerformed: true,
    replayedAt: legacyReceipt.replayedAt,
  };
  return Object.freeze({
    ...payload,
    externalResearchReplayReceiptHash:
      hashRecord('ExternalResearchReplayReceiptV3', payload),
  });
}

export function verifyExternalResearchReplayReceiptV3Structure(receipt, {
  request,
} = {}) {
  const { externalResearchReplayReceiptHash: claimedHash, ...payload } = receipt || {};
  if (!sha(claimedHash)
    || hashRecord('ExternalResearchReplayReceiptV3', payload) !== claimedHash) return false;
  try {
    return JSON.stringify(buildStrongExternalResearchReplayReceipt({
      request,
      legacyReceipt: receipt.legacyReceipt,
      resultAuthorityEnvelope: receipt.resultAuthorityEnvelope,
      remoteIdentityAttestationBundle: receipt.remoteIdentityAttestationBundle,
      localOriginIdentityAttestationBundles:
        receipt.localOriginIdentityAttestationBundles,
      identitySeparationReceipt: receipt.identitySeparationReceipt,
      configurationHash: receipt.configurationHash,
      trustSetHash: receipt.trustSetHash,
      signatureVerificationPolicyHash: receipt.signatureVerificationPolicyHash,
    })) === JSON.stringify(receipt);
  } catch { return false; }
}

export function verifyExternalResearchReplayReceipt(receipt, {
  request,
  cryptographicVerifier = null,
} = {}) {
  if (receipt?.version === 3) {
    // A v3 record deliberately cannot self-authorize. Its hashes only protect
    // structure; the configured verifier must replay every pinned signature,
    // validity window, identity binding, and separation check.
    return cryptographicVerifier?.kind === 'ExternalResearchReplayReceiptVerifier'
      && typeof cryptographicVerifier.verify === 'function'
      && cryptographicVerifier.verify({ request, receipt }) === true;
  }
  if (receipt?.version === 2) {
    const { externalResearchReplayReceiptHash: claimedHash, ...payload } = receipt || {};
    if (!sha(claimedHash)
      || hashRecord('ExternalResearchReplayReceiptV2', payload) !== claimedHash) return false;
    try {
      return JSON.stringify(buildCryptographicExternalResearchReplayReceipt({
        request,
        legacyReceipt: receipt.legacyReceipt,
        authorityEnvelope: receipt.authorityEnvelope,
        signatureVerificationReceipt: receipt.signatureVerificationReceipt,
      })) === JSON.stringify(receipt);
    } catch { return false; }
  }
  try {
    return JSON.stringify(buildExternalResearchReplayReceipt({
      request,
      ...receipt,
    })) === JSON.stringify(receipt);
  } catch { return false; }
}
