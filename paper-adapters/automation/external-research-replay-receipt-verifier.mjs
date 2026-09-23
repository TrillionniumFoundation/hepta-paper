import {
  buildStrongExternalResearchReplayReceipt,
  verifyExternalResearchReplayReceipt,
  verifyExternalResearchReplayReceiptV3Structure,
} from '../../paper-domain/research/external-research-replay-contract.mjs';
import {
  verifyPinnedExternalEvidenceEnvelope,
} from '../authority/pinned-external-evidence-verifier.mjs';
import {
  inspectExternalResearchReplayIdentitySeparation,
} from './external-research-replay-identity-attestation.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const RESULT_SUBJECT_KIND = 'ExternalResearchReplayReceiptV1';
const RESULT_SIGNER_ROLE = 'external_research_replay_attestor';

function inspectIdentity(configuration, now) {
  return inspectExternalResearchReplayIdentitySeparation({
    serviceId: configuration.serviceId,
    serviceIdentityHash: configuration.serviceIdentityHash,
    receiptTrustStore: configuration.receiptTrustStore,
    receiptSignerRole: configuration.receiptSignerRole,
    receiptSignerKeyIds: configuration.receiptSignerKeyIds,
    remoteIdentityAttestationBundle: configuration.remoteIdentityAttestationBundle,
    localOriginIdentityAttestationBundles:
      configuration.localOriginIdentityAttestationBundles,
    now,
  });
}

function trustBindings(configuration, identityInspection) {
  const trustSetHash = hashRecord('ExternalResearchReplayStrongTrustSet', {
    configurationHash: configuration.configurationHash,
    resultReceiptTrustStoreHash: configuration.receiptTrustStoreHash,
    identityTrustSetHash: identityInspection.trustSetHash,
  });
  const signatureVerificationPolicyHash = hashRecord(
    'ExternalResearchReplayStrongSignatureVerificationPolicy',
    {
      configurationHash: configuration.configurationHash,
      resultPolicy: 'pinned-canonical-json-ed25519-v1',
      resultSignerRole: RESULT_SIGNER_ROLE,
      resultMaximumLifetimeMs: configuration.receiptMaximumLifetimeMs,
      identitySeparationPolicyHash: identityInspection.signatureVerificationPolicyHash,
      persistedReceiptVerification: 'replay-current-config-and-time-v1',
    },
  );
  return Object.freeze({ trustSetHash, signatureVerificationPolicyHash });
}

function legacyIdentityMatchesConfiguration(legacyReceipt, configuration, identityInspection,
  resultVerification) {
  const remote = identityInspection.remoteIdentitySubject;
  return remote?.serviceId === configuration.serviceId
    && remote?.principalId === legacyReceipt?.principalId
    && remote?.providerAccountIdentityHash === legacyReceipt?.providerAccountIdentityHash
    && remote?.credentialRootIdentityHash === legacyReceipt?.credentialRootIdentityHash
    && remote?.hostIdentityHash === legacyReceipt?.hostIdentityHash
    && remote?.processIdentityHash === legacyReceipt?.processIdentityHash
    && remote?.trustDomainIdentityHash === legacyReceipt?.trustDomainIdentityHash
    && resultVerification?.verifiedPublicKeySpkiHashes?.length === 1
    && resultVerification.verifiedPublicKeySpkiHashes[0]
      === remote?.signerPublicKeySpkiHash;
}

function verifyCurrentEvidence({ request, receipt, configuration, now }) {
  if (!verifyExternalResearchReplayReceiptV3Structure(receipt, { request })
    || receipt.configurationHash !== configuration.configurationHash
    || receipt.remoteIdentityAttestationBundleHash
      !== configuration.remoteIdentityAttestationBundle.bundleHash
    || JSON.stringify(receipt.remoteIdentityAttestationBundle)
      !== JSON.stringify(configuration.remoteIdentityAttestationBundle)
    || JSON.stringify(receipt.localOriginIdentityAttestationBundles)
      !== JSON.stringify(configuration.localOriginIdentityAttestationBundles)) return null;
  const identityInspection = inspectIdentity(configuration, now);
  if (identityInspection.identityIndependenceReady !== true) return null;
  const resultVerification = verifyPinnedExternalEvidenceEnvelope({
    envelope: receipt.resultAuthorityEnvelope,
    subjectKind: RESULT_SUBJECT_KIND,
    subjectHash: receipt.legacyReceiptHash,
    trustStore: configuration.receiptTrustStore,
    requiredRole: configuration.receiptSignerRole,
    expectedKeyIds: configuration.receiptSignerKeyIds,
    now,
    maximumLifetimeMs: configuration.receiptMaximumLifetimeMs,
  });
  if (resultVerification.cryptographicAuthorityReady !== true
    || !legacyIdentityMatchesConfiguration(
      receipt.legacyReceipt,
      configuration,
      identityInspection,
      resultVerification,
    )) return null;
  const bindings = trustBindings(configuration, identityInspection);
  if (receipt.trustSetHash !== bindings.trustSetHash
    || receipt.signatureVerificationPolicyHash
      !== bindings.signatureVerificationPolicyHash
    || receipt.identitySeparationReceiptHash
      !== identityInspection.identitySeparationReceipt
        .externalPrincipalIdentitySeparationReceiptHash
    || JSON.stringify(receipt.identitySeparationReceipt)
      !== JSON.stringify(identityInspection.identitySeparationReceipt)) return null;
  return Object.freeze({ identityInspection, resultVerification, ...bindings });
}

export function createExternalResearchReplayReceiptVerifier({
  configuration,
  clock = { now: () => new Date() },
} = {}) {
  if (![3, 4].includes(configuration?.version)
    || configuration?.receiptSignerRole !== RESULT_SIGNER_ROLE
    || typeof clock?.now !== 'function') {
    throw new Error('external_research_replay_receipt_verifier_configuration_invalid');
  }
  const initialIdentityInspection = inspectIdentity(configuration, clock.now());
  if (initialIdentityInspection.identityIndependenceReady !== true) {
    throw new Error(`external_research_replay_identity_separation_invalid:${
      initialIdentityInspection.blockers.join(',') || 'unknown'}`);
  }
  const bindings = trustBindings(configuration, initialIdentityInspection);
  let verifier;
  verifier = Object.freeze({
    version: 1,
    kind: 'ExternalResearchReplayReceiptVerifier',
    configurationHash: configuration.configurationHash,
    cryptographicAuthorityReady: true,
    identityIndependenceReady: true,
    trustSetHash: bindings.trustSetHash,
    signatureVerificationPolicyHash: bindings.signatureVerificationPolicyHash,
    identitySeparationInspection: initialIdentityInspection,
    wrap({ request, legacyReceipt, resultAuthorityEnvelope } = {}) {
      if (!verifyExternalResearchReplayReceipt(legacyReceipt, { request })) {
        throw new Error('external_research_replay_legacy_receipt_invalid');
      }
      const provisional = buildStrongExternalResearchReplayReceipt({
        request,
        legacyReceipt,
        resultAuthorityEnvelope,
        remoteIdentityAttestationBundle: configuration.remoteIdentityAttestationBundle,
        localOriginIdentityAttestationBundles:
          configuration.localOriginIdentityAttestationBundles,
        identitySeparationReceipt: initialIdentityInspection.identitySeparationReceipt,
        configurationHash: configuration.configurationHash,
        ...bindings,
      });
      if (!verifier.verify({ request, receipt: provisional })) {
        throw new Error('external_research_replay_strong_receipt_verification_failed');
      }
      return provisional;
    },
    verify({ request, receipt } = {}) {
      try {
        return Boolean(verifyCurrentEvidence({
          request,
          receipt,
          configuration,
          now: clock.now(),
        }));
      } catch { return false; }
    },
  });
  return verifier;
}
