import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildExternalResearchReplayReceipt,
  buildExternalResearchReplayRequest,
  verifyExternalResearchReplayReceipt,
  verifyExternalResearchReplayReceiptV3Structure,
} from '../../paper-domain/research/external-research-replay-contract.mjs';
import {
  buildExternalPrincipalIdentityAttestationSubject,
} from '../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import {
  buildPinnedExternalEvidenceEnvelope,
  pinnedExternalEvidenceSigningPayload,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  buildExternalResearchReplayIdentityAttestationBundle,
} from '../../paper-adapters/automation/external-research-replay-identity-attestation.mjs';
import {
  buildExternalResearchReplayServiceConfiguration,
  createHttpExternalResearchReplayAdapter,
  readExternalResearchReplayServiceConfiguration,
} from '../../paper-adapters/automation/http-external-research-replay-adapter.mjs';
import {
  assertCampaignReleaseExternalResearchReplayAuthority,
  runCampaignExternalResearchReplay,
} from '../../paper-adapters/automation/campaign-external-research-replay.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NOW = new Date('2026-07-19T02:00:00.000Z');
const RESULT_ROLE = 'external_research_replay_attestor';
const IDENTITY_ROLE = 'external_research_replay_identity_attestor';
const H = (label) => hashRecord('ExternalResearchReplayStrongV3Test', { label });

function trustKey(pair, { keyId, subjectId, roles }) {
  return Object.freeze({
    keyId,
    subjectId,
    organization: 'Replay V3 Test Authority',
    algorithm: 'ed25519',
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    roles,
    status: 'active',
    effectiveFrom: '2026-07-19T00:00:00.000Z',
    expiresAt: '2026-07-20T00:00:00.000Z',
    revokedAt: null,
  });
}

function trustStore(keys) {
  return Object.freeze({ version: 1, kind: 'AuthorityTrustStore', keys });
}

function signedEnvelope(pair, {
  subjectKind,
  subjectHash,
  keyId,
  role,
  signedAt = '2026-07-19T01:59:00.000Z',
  expiresAt = '2026-07-19T02:10:00.000Z',
}) {
  const placeholder = buildPinnedExternalEvidenceEnvelope({
    subjectKind,
    subjectHash,
    signedAt,
    expiresAt,
    signatures: [{ keyId, role, algorithm: 'ed25519', value: 'placeholder' }],
  });
  const value = crypto.sign(
    null,
    pinnedExternalEvidenceSigningPayload(placeholder),
    pair.privateKey,
  ).toString('base64');
  return buildPinnedExternalEvidenceEnvelope({
    ...placeholder,
    signatures: [{ keyId, role, algorithm: 'ed25519', value }],
  });
}

function identitySubject(label, pair, overrides = {}) {
  return buildExternalPrincipalIdentityAttestationSubject({
    serviceId: `service-${label}`,
    principalId: `principal-${label}`,
    provider: `provider-${label}`,
    providerAccountIdentityHash: H(`account-${label}`),
    credentialRootIdentityHash: H(`credential-${label}`),
    hostIdentityHash: H(`host-${label}`),
    processIdentityHash: H(`process-${label}`),
    trustDomainIdentityHash: H(`domain-${label}`),
    signerPublicKeySpkiHash: hashBytes(
      pair.publicKey.export({ type: 'spki', format: 'der' }),
    ),
    challengeHash: H(`challenge-${label}`),
    assuranceProfile: 'pinned-provider-account-and-platform-attestation-v1',
    attestedAt: '2026-07-19T01:58:00.000Z',
    expiresAt: '2026-07-19T02:10:00.000Z',
    ...overrides,
  });
}

function identityBundle(label, pair, subject) {
  const keyId = `${label}-identity-key`;
  return buildExternalResearchReplayIdentityAttestationBundle({
    subject,
    authorityEnvelope: signedEnvelope(pair, {
      subjectKind: 'ExternalPrincipalIdentityAttestationSubject',
      subjectHash: subject.externalPrincipalIdentityAttestationSubjectHash,
      keyId,
      role: IDENTITY_ROLE,
    }),
    trustStore: trustStore([trustKey(pair, {
      keyId,
      subjectId: `${label}-identity-authority`,
      roles: [IDENTITY_ROLE],
    })]),
    signerKeyIds: [keyId],
    maximumLifetimeMs: 15 * 60 * 1000,
  });
}

function fixture({
  duplicateOrigin = false,
  remoteIdentityOverrides = {},
  clock = { now: () => new Date(NOW) },
} = {}) {
  const remoteKey = crypto.generateKeyPairSync('ed25519');
  const localKey = crypto.generateKeyPairSync('ed25519');
  const remoteSubject = identitySubject('remote-replay', remoteKey, {
    serviceId: 'strong-replay-service',
    principalId: 'strong-replay-principal',
    ...remoteIdentityOverrides,
  });
  const remoteKeyId = 'strong-replay-key';
  const remoteBundle = buildExternalResearchReplayIdentityAttestationBundle({
    subject: remoteSubject,
    authorityEnvelope: signedEnvelope(remoteKey, {
      subjectKind: 'ExternalPrincipalIdentityAttestationSubject',
      subjectHash: remoteSubject.externalPrincipalIdentityAttestationSubjectHash,
      keyId: remoteKeyId,
      role: IDENTITY_ROLE,
    }),
    trustStore: trustStore([trustKey(remoteKey, {
      keyId: remoteKeyId,
      subjectId: 'strong-replay-identity-authority',
      roles: [RESULT_ROLE, IDENTITY_ROLE],
    })]),
    signerKeyIds: [remoteKeyId],
  });
  const localSubject = identitySubject('local-origin', localKey);
  const localBundle = identityBundle('local-origin', localKey, localSubject);
  const configuration = buildExternalResearchReplayServiceConfiguration({
    version: 3,
    serviceId: remoteSubject.serviceId,
    endpoint: 'https://external-replay.example.test/v3/replay',
    serviceIdentityHash: remoteSubject.externalPrincipalIdentityAttestationSubjectHash,
    tokenEnvironmentVariable: 'EXTERNAL_REPLAY_V3_TOKEN',
    receiptTrustStore: trustStore([trustKey(remoteKey, {
      keyId: remoteKeyId,
      subjectId: 'strong-replay-result-authority',
      roles: [RESULT_ROLE, IDENTITY_ROLE],
    })]),
    receiptSignerKeyIds: [remoteKeyId],
    receiptMaximumLifetimeMs: 15 * 60 * 1000,
    remoteIdentityAttestationBundle: remoteBundle,
    localOriginIdentityAttestationBundles: duplicateOrigin
      ? [localBundle, localBundle] : [localBundle],
  });
  const originalExperimentHash = H('original-experiment');
  const request = buildExternalResearchReplayRequest({
    paperId: 'strong-paper',
    campaignId: 'strong-campaign',
    sourceSnapshotHash: H('source-snapshot'),
    experimentPairs: [{
      originalExperimentRunReceiptHash: originalExperimentHash,
      localReplayExperimentRunReceiptHash: H('local-replay'),
      localReplayObservationManifestHash: H('local-observations'),
    }],
    formalReplayReceiptHashes: [H('formal-replay')],
  });
  const legacyReceipt = buildExternalResearchReplayReceipt({
    request,
    serviceId: remoteSubject.serviceId,
    principalId: remoteSubject.principalId,
    providerAccountIdentityHash: remoteSubject.providerAccountIdentityHash,
    credentialRootIdentityHash: remoteSubject.credentialRootIdentityHash,
    hostIdentityHash: remoteSubject.hostIdentityHash,
    processIdentityHash: remoteSubject.processIdentityHash,
    trustDomainIdentityHash: remoteSubject.trustDomainIdentityHash,
    resultManifestHash: H('remote-result'),
    reproducedExperimentRunReceiptHashes: [originalExperimentHash],
    reproducedFormalReplayReceiptHashes: [H('formal-replay')],
    signerIdentityHash: H('legacy-signer-claim'),
    signatureHash: H('legacy-signature-claim'),
    signatureVerificationReceiptHash: H('legacy-verification-claim'),
    replayedAt: NOW.toISOString(),
  });
  const resultAuthorityEnvelope = signedEnvelope(remoteKey, {
    subjectKind: 'ExternalResearchReplayReceiptV1',
    subjectHash: legacyReceipt.externalResearchReplayReceiptHash,
    keyId: remoteKeyId,
    role: RESULT_ROLE,
  });
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        requestHash: request.requestHash,
        serviceId: configuration.serviceId,
        serviceIdentityHash: configuration.serviceIdentityHash,
        externalActionPerformed: true,
        externalResearchReplayReceipt: legacyReceipt,
        authorityEnvelope: resultAuthorityEnvelope,
      };
    },
  });
  return {
    clock,
    configuration,
    fetchImpl,
    legacyReceipt,
    localBundle,
    remoteBundle,
    request,
  };
}

function adapter(input) {
  return createHttpExternalResearchReplayAdapter({
    configuration: input.configuration,
    environment: { EXTERNAL_REPLAY_V3_TOKEN: 'test-token' },
    fetchImpl: input.fetchImpl,
    clock: input.clock,
  });
}

test('v3 reaches strong readiness and re-verifies persisted evidence after restart', async (t) => {
  const input = fixture();
  const first = adapter(input);
  assert.equal(first.cryptographicAuthorityReady, true);
  assert.equal(first.identityIndependenceReady, true);
  assert.match(first.trustSetHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.signatureVerificationPolicyHash, /^sha256:[0-9a-f]{64}$/);
  const receipt = await first.replay({ request: input.request });
  assert.equal(receipt.version, 3);
  assert.equal(receipt.identityIndependenceReady, true);
  assert.equal(receipt.signerIndependent, true);
  assert.equal(verifyExternalResearchReplayReceipt(receipt, {
    request: input.request,
  }), false);
  assert.equal(first.verifyReceipt({ request: input.request, receipt }), true);

  const persisted = JSON.parse(JSON.stringify(receipt));
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-replay-v3-config-'));
  t.after(() => fs.rmSync(configRoot, { recursive: true, force: true }));
  const configPath = path.join(configRoot, 'external-replay.json');
  fs.writeFileSync(configPath, `${JSON.stringify(input.configuration)}\n`, { mode: 0o600 });
  const restartedConfiguration = readExternalResearchReplayServiceConfiguration({
    configPath,
  });
  const restarted = adapter({
    ...input,
    configuration: restartedConfiguration,
  });
  assert.equal(restarted.verifyReceipt({ request: input.request, receipt: persisted }), true);
});

test('v3 rejects tampering, trust swap, expiry, and duplicate origin identities', async () => {
  let observedNow = new Date(NOW);
  const input = fixture({ clock: { now: () => new Date(observedNow) } });
  const selected = adapter(input);
  const receipt = await selected.replay({ request: input.request });
  const tampered = structuredClone(receipt);
  tampered.legacyReceipt.hostIdentityHash = H('attacker-host');
  const {
    externalResearchReplayReceiptHash: _legacyHash,
    ...tamperedLegacyPayload
  } = tampered.legacyReceipt;
  tampered.legacyReceipt.externalResearchReplayReceiptHash = hashRecord(
    'ExternalResearchReplayReceipt', tamperedLegacyPayload,
  );
  tampered.legacyReceiptHash = tampered.legacyReceipt.externalResearchReplayReceiptHash;
  tampered.resultAuthorityEnvelope.subjectHash = tampered.legacyReceiptHash;
  tampered.resultAuthorityEnvelopeHash = hashRecord(
    'PinnedExternalEvidenceEnvelope', tampered.resultAuthorityEnvelope,
  );
  const { externalResearchReplayReceiptHash: _old, ...tamperedPayload } = tampered;
  tampered.externalResearchReplayReceiptHash = hashRecord(
    'ExternalResearchReplayReceiptV3', tamperedPayload,
  );
  assert.equal(verifyExternalResearchReplayReceiptV3Structure(tampered, {
    request: input.request,
  }), true);
  assert.equal(selected.verifyReceipt({ request: input.request, receipt: tampered }), false);

  const replacement = fixture();
  const swappedVerifier = adapter(replacement);
  assert.equal(swappedVerifier.verifyReceipt({ request: input.request, receipt }), false);

  observedNow = new Date('2026-07-19T02:11:00.000Z');
  assert.equal(selected.verifyReceipt({ request: input.request, receipt }), false);

  assert.throws(() => adapter(fixture({ duplicateOrigin: true })),
    /external_research_replay_identity_separation_invalid/);
  assert.throws(() => adapter(fixture({
    remoteIdentityOverrides: {
      assuranceProfile: 'operator-attested-external-principal-v1',
    },
  })), /external_research_replay_identity_separation_invalid/);
  assert.throws(() => adapter(fixture({
    remoteIdentityOverrides: {
      providerAccountIdentityHash: H('account-local-origin'),
    },
  })), /external_research_replay_identity_separation_invalid/);
});

test('campaign consumes the configuration-bound verifier for a v3 receipt', async () => {
  const input = fixture();
  const selected = adapter(input);
  const replay = await runCampaignExternalResearchReplay({
    campaign: {
      paperId: input.request.paperId,
      campaignId: input.request.campaignId,
      spec: { autonomousResearchPreparation: {
        externalResearchReplayConfigurationHash: input.configuration.configurationHash,
        capabilityScopeManifest: { replayMode: 'external-trust-domain-v1' },
        runtimePrincipalBinding: {
          authorIdentitySubjectHash:
            input.localBundle.subject.externalPrincipalIdentityAttestationSubjectHash,
        },
      } },
    },
    campaignResearchSourceSnapshot: {
      campaignResearchSourceSnapshotHash: input.request.sourceSnapshotHash,
    },
    campaignExperiments: [{
      experimentRunReceipt: {
        experimentRunReceiptHash:
          input.request.experimentPairs[0].originalExperimentRunReceiptHash,
      },
      reproducibilityReceipt: {
        replayExperimentRunReceiptHash:
          input.request.experimentPairs[0].localReplayExperimentRunReceiptHash,
      },
      replayWorkerReceipt: {
        observationManifestHash:
          input.request.experimentPairs[0].localReplayObservationManifestHash,
      },
    }],
    authoritativeFormalReceipt: {
      formalReplayReceiptHashes: input.request.formalReplayReceiptHashes,
    },
    externalResearchReplay: selected,
  });
  assert.equal(replay.required, true);
  assert.equal(replay.receipt.version, 3);
  assert.equal(replay.receiptVerifier, selected.receiptVerifier);
  await assert.rejects(() => runCampaignExternalResearchReplay({
    campaign: {
      paperId: input.request.paperId,
      campaignId: input.request.campaignId,
      spec: { autonomousResearchPreparation: {
        externalResearchReplayConfigurationHash: input.configuration.configurationHash,
        capabilityScopeManifest: { replayMode: 'external-trust-domain-v1' },
        runtimePrincipalBinding: { authorIdentitySubjectHash: H('rotated-author') },
      } },
    },
    campaignResearchSourceSnapshot: {
      campaignResearchSourceSnapshotHash: input.request.sourceSnapshotHash,
    },
    campaignExperiments: [],
    externalResearchReplay: selected,
  }), /external_research_replay_required_origin_identity_missing/);
  const researchReport = {
    externalReplayVerified: true,
    externalReplayRequestHash: replay.request.requestHash,
    externalResearchReplayReceiptHash: replay.receipt.externalResearchReplayReceiptHash,
    capabilities: {
      externalReplayRequest: replay.request,
      externalReplayReceipt: replay.receipt,
    },
  };
  assert.equal(assertCampaignReleaseExternalResearchReplayAuthority({
    campaign: {
      spec: { autonomousResearchPreparation: {
        externalResearchReplayConfigurationHash: input.configuration.configurationHash,
        capabilityScopeManifest: { replayMode: 'external-trust-domain-v1' },
        runtimePrincipalBinding: {
          authorIdentitySubjectHash:
            input.localBundle.subject.externalPrincipalIdentityAttestationSubjectHash,
        },
      } },
    },
    researchReport,
    externalResearchReplay: selected,
  }), true);
  assert.throws(() => assertCampaignReleaseExternalResearchReplayAuthority({
    campaign: {
      spec: { autonomousResearchPreparation: {
        externalResearchReplayConfigurationHash: input.configuration.configurationHash,
        capabilityScopeManifest: { replayMode: 'external-trust-domain-v1' },
        runtimePrincipalBinding: {
          authorIdentitySubjectHash:
            input.localBundle.subject.externalPrincipalIdentityAttestationSubjectHash,
        },
      } },
    },
    researchReport: { ...researchReport, externalReplayVerified: false },
    externalResearchReplay: selected,
  }), /campaign_release_external_research_replay_authority_invalid/);
});
