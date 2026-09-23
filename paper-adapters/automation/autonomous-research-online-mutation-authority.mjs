import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  assertAutonomousResearchOnlineMutationReserveRequest,
  assertAutonomousResearchOnlineMutationFinalizeRequest,
  autonomousResearchOnlineMutationSignedPayload,
  verifyAutonomousResearchOnlineMutationActiveChallenge,
  verifyAutonomousResearchOnlineMutationCurrentHead,
  verifyAutonomousResearchOnlineMutationFinalization,
  verifyAutonomousResearchOnlineMutationReservation,
  verifyAutonomousResearchOnlineMutationScopeReceipt,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  assertAutonomousResearchOnlineMutationAbortRequest,
  assertAutonomousResearchOnlineMutationResolutionRequest,
  verifyAutonomousResearchOnlineMutationAbort,
  verifyAutonomousResearchOnlineMutationResolution,
} from '../../paper-domain/automation/autonomous-research-online-mutation-recovery-contract.mjs';
import {
  assertAutonomousResearchOnlineUnresolvedReservationListRequest,
  verifyAutonomousResearchOnlineUnresolvedReservationList,
} from '../../paper-domain/automation/autonomous-research-online-unresolved-reservation-contract.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  fileSha256HashSync,
  readRegularJsonFileSync,
} from '../runtime/pinned-file-reader.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/;
const SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/;

function invalid(code) {
  throw new Error(code);
}

function readPublicKeyDocument(candidate) {
  const document = readRegularJsonFileSync(candidate);
  if (!hasExactObjectKeys(document, [
    'version', 'kind', 'authorityId', 'keyId', 'algorithm', 'publicKeyPem',
  ])
    || document.version !== 1
    || document.kind !== 'AutonomousResearchOnlineMutationAuthorityPublicKey'
    || !SAFE_ID.test(String(document.authorityId || ''))
    || !SAFE_ID.test(String(document.keyId || ''))
    || document.algorithm !== 'ed25519'
    || typeof document.publicKeyPem !== 'string'
    || !/-----BEGIN PUBLIC KEY-----/.test(document.publicKeyPem)
    || /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(document.publicKeyPem)) {
    invalid('autonomous_research_online_mutation_authority_public_key_invalid');
  }
  let publicKey;
  try { publicKey = crypto.createPublicKey(document.publicKeyPem); }
  catch { invalid('autonomous_research_online_mutation_authority_public_key_invalid'); }
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    invalid('autonomous_research_online_mutation_authority_public_key_invalid');
  }
  return Object.freeze({ document: Object.freeze(document), publicKey });
}

function assertAuthorityConfiguration(configuration) {
  if (!hasExactObjectKeys(configuration, [
    'version', 'kind', 'authorityId', 'keyId', 'scopeId', 'databaseScopeHash',
    'writerManifestHash', 'publicKeyPath', 'publicKeySha256',
    'maximumReservationLeaseMs', 'maximumObservationAgeMs',
  ])
    || configuration.version !== 1
    || configuration.kind !== 'AutonomousResearchOnlineMutationAuthorityConfiguration'
    || !SAFE_ID.test(String(configuration.authorityId || ''))
    || !SAFE_ID.test(String(configuration.keyId || ''))
    || !SAFE_ID.test(String(configuration.scopeId || ''))
    || !SHA256.test(String(configuration.databaseScopeHash || ''))
    || !SHA256.test(String(configuration.writerManifestHash || ''))
    || !path.isAbsolute(String(configuration.publicKeyPath || ''))
    || !SHA256.test(String(configuration.publicKeySha256 || ''))
    || !Number.isSafeInteger(configuration.maximumReservationLeaseMs)
    || configuration.maximumReservationLeaseMs < 1000
    || configuration.maximumReservationLeaseMs > 15 * 60 * 1000
    || !Number.isSafeInteger(configuration.maximumObservationAgeMs)
    || configuration.maximumObservationAgeMs < 1000
    || configuration.maximumObservationAgeMs > 15 * 60 * 1000) {
    invalid('autonomous_research_online_mutation_authority_configuration_invalid');
  }
  return configuration;
}

function assertProcessConfiguration(configuration) {
  if (!hasExactObjectKeys(configuration, [
    'version', 'kind', 'authorityConfigurationPath', 'authorityConfigurationSha256',
    'commandPath', 'commandSha256', 'fixedArguments', 'timeoutMs',
  ])
    || configuration.version !== 1
    || configuration.kind !== 'AutonomousResearchOnlineMutationAuthorityProcessConfiguration'
    || !path.isAbsolute(String(configuration.authorityConfigurationPath || ''))
    || !SHA256.test(String(configuration.authorityConfigurationSha256 || ''))
    || !path.isAbsolute(String(configuration.commandPath || ''))
    || !SHA256.test(String(configuration.commandSha256 || ''))
    || !Array.isArray(configuration.fixedArguments)
    || configuration.fixedArguments.length !== 0
    || !Number.isSafeInteger(configuration.timeoutMs)
    || configuration.timeoutMs < 1000
    || configuration.timeoutMs > 120000) {
    invalid('autonomous_research_online_mutation_authority_process_configuration_invalid');
  }
  return configuration;
}

function canonicalChangesetBuffer(changesetBase64) {
  if (typeof changesetBase64 !== 'string') {
    invalid('autonomous_research_online_mutation_changeset_invalid');
  }
  const buffer = Buffer.from(changesetBase64, 'base64');
  if (buffer.length === 0 || buffer.toString('base64') !== changesetBase64) {
    invalid('autonomous_research_online_mutation_changeset_invalid');
  }
  return buffer;
}

export function autonomousResearchOnlineMutationChangesetHash(changesetBase64) {
  return hashBytes(canonicalChangesetBuffer(changesetBase64));
}

export function loadAutonomousResearchOnlineMutationAuthorityTrust({
  configurationPath,
} = {}) {
  const configuration = assertAuthorityConfiguration(
    readRegularJsonFileSync(configurationPath),
  );
  if (fileSha256HashSync(configuration.publicKeyPath)
      !== configuration.publicKeySha256) {
    invalid('autonomous_research_online_mutation_authority_public_key_identity_mismatch');
  }
  const loaded = readPublicKeyDocument(configuration.publicKeyPath);
  if (loaded.document.authorityId !== configuration.authorityId
    || loaded.document.keyId !== configuration.keyId) {
    invalid('autonomous_research_online_mutation_authority_public_key_identity_mismatch');
  }
  return Object.freeze({
    configuration: Object.freeze(configuration),
    configurationHash: hashRecord(
      'AutonomousResearchOnlineMutationAuthorityConfiguration', configuration,
    ),
    trust: Object.freeze({
      version: 1,
      kind: 'AutonomousResearchOnlineMutationAuthorityTrust',
      authorityId: configuration.authorityId,
      keyId: configuration.keyId,
      scopeId: configuration.scopeId,
      databaseScopeHash: configuration.databaseScopeHash,
      writerManifestHash: configuration.writerManifestHash,
      maximumReservationLeaseMs: configuration.maximumReservationLeaseMs,
      maximumObservationAgeMs: configuration.maximumObservationAgeMs,
    }),
    publicKey: loaded.publicKey,
  });
}

export function createAutonomousResearchOnlineMutationReceiptVerifier({
  configurationPath,
} = {}) {
  const loaded = loadAutonomousResearchOnlineMutationAuthorityTrust({ configurationPath });
  const verifySignature = (receipt) => {
    if (!SIGNATURE.test(String(receipt?.signature || ''))) return false;
    try {
      return crypto.verify(
        null,
        Buffer.from(autonomousResearchOnlineMutationSignedPayload(receipt), 'utf8'),
        loaded.publicKey,
        Buffer.from(receipt.signature, 'base64'),
      );
    } catch { return false; }
  };
  const shared = Object.freeze({
    trust: loaded.trust,
    verifySignature,
    hashChangesetBase64: autonomousResearchOnlineMutationChangesetHash,
  });
  return Object.freeze({
    trust: loaded.trust,
    configurationHash: loaded.configurationHash,
    verifySignedReceipt: verifySignature,
    verifyReservation: (input) => verifyAutonomousResearchOnlineMutationReservation({
      ...input, ...shared,
    }),
    verifyFinalization: (input) => verifyAutonomousResearchOnlineMutationFinalization({
      ...input, trust: loaded.trust, verifySignature,
    }),
    verifyCurrentHead: (input) => verifyAutonomousResearchOnlineMutationCurrentHead({
      ...input, trust: loaded.trust, verifySignature,
    }),
    verifyActiveChallenge: (input) => verifyAutonomousResearchOnlineMutationActiveChallenge({
      ...input, trust: loaded.trust, verifySignature,
    }),
    verifyScope: (input) => verifyAutonomousResearchOnlineMutationScopeReceipt({
      ...input, trust: loaded.trust, verifySignature,
    }),
    verifyUnresolvedReservations: (input) => (
      verifyAutonomousResearchOnlineUnresolvedReservationList({
        ...input,
        trust: loaded.trust,
        verifySignature,
        verifyStoredReservation: ({ receipt, request }) => (
          verifyAutonomousResearchOnlineMutationReservation({
            receipt,
            request,
            ...shared,
            now: new Date(receipt?.issuedAt),
          })
        ),
      })
    ),
  });
}

function processResult(result) {
  if (result.status !== 0 || result.error || result.signal) {
    invalid('autonomous_research_online_mutation_authority_process_failed');
  }
  try { return JSON.parse(String(result.stdout || '').trim()); }
  catch { invalid('autonomous_research_online_mutation_authority_process_output_invalid'); }
}

export function createAutonomousResearchOnlineMutationAuthorityProcessClient({
  processConfigurationPath,
} = {}) {
  const processConfiguration = assertProcessConfiguration(
    readRegularJsonFileSync(processConfigurationPath),
  );
  if (fileSha256HashSync(processConfiguration.authorityConfigurationPath)
      !== processConfiguration.authorityConfigurationSha256
    || fileSha256HashSync(processConfiguration.commandPath)
      !== processConfiguration.commandSha256) {
    invalid('autonomous_research_online_mutation_authority_process_identity_mismatch');
  }
  const verifier = createAutonomousResearchOnlineMutationReceiptVerifier({
    configurationPath: processConfiguration.authorityConfigurationPath,
  });
  const invoke = (request) => {
    if (fileSha256HashSync(processConfiguration.commandPath)
        !== processConfiguration.commandSha256
      || fileSha256HashSync(processConfiguration.authorityConfigurationPath)
        !== processConfiguration.authorityConfigurationSha256) {
      invalid('autonomous_research_online_mutation_authority_process_identity_changed');
    }
    return processResult(spawnSync(
      processConfiguration.commandPath,
      processConfiguration.fixedArguments,
      {
        input: `${JSON.stringify(request)}\n`,
        encoding: 'utf8',
        timeout: processConfiguration.timeoutMs,
        // A valid 16 MiB changeset expands to about 21.4 MiB in canonical base64.
        // Startup recovery carries the original request and signed reservation
        // together, so keep the single-unresolved-entry response above 42.8 MiB.
        maxBuffer: 64 * 1024 * 1024,
        shell: false,
        // child_process propagates NODE_V8_COVERAGE by adding it to options.env.
        // Keep the authority environment least-privilege, but give Node a fresh
        // mutable object so verification/coverage cannot break production IPC.
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      },
    ));
  };
  return Object.freeze({
    protocol: 'external-linearizable-reserve-apply-finalize-v1',
    trust: verifier.trust,
    operationTimeoutMs: processConfiguration.timeoutMs,
    configurationHash: hashRecord(
      'AutonomousResearchOnlineMutationAuthorityProcessConfiguration',
      processConfiguration,
    ),
    reserveMutation({ request, now } = {}) {
      assertAutonomousResearchOnlineMutationReserveRequest(request, {
        trust: verifier.trust,
        hashChangesetBase64: autonomousResearchOnlineMutationChangesetHash,
      });
      const receipt = invoke(request);
      if (!verifier.verifyReservation({ receipt, request, now })) {
        invalid('autonomous_research_online_mutation_reservation_receipt_invalid');
      }
      return Object.freeze(receipt);
    },
    verifyStoredReservation({ receipt, request } = {}) {
      return verifier.verifyReservation({
        receipt,
        request,
        now: new Date(receipt?.issuedAt),
      });
    },
    verifyStoredFinalization({ receipt, request, reservation } = {}) {
      return verifier.verifyFinalization({
        receipt,
        request,
        reservation,
        now: new Date(receipt?.finalizedAt),
      });
    },
    finalizeMutation({ request, reservation, now } = {}) {
      assertAutonomousResearchOnlineMutationFinalizeRequest(request, reservation);
      const receipt = invoke(request);
      if (!verifier.verifyFinalization({ receipt, request, reservation, now })) {
        invalid('autonomous_research_online_mutation_finalization_receipt_invalid');
      }
      return Object.freeze(receipt);
    },
    abortMutation({ request, reservation, now } = {}) {
      assertAutonomousResearchOnlineMutationAbortRequest(request, reservation);
      const receipt = invoke(request);
      if (!verifyAutonomousResearchOnlineMutationAbort({
        receipt,
        request,
        reservation,
        trust: verifier.trust,
        now,
        verifySignature: verifier.verifySignedReceipt,
      })) {
        invalid('autonomous_research_online_mutation_abort_receipt_invalid');
      }
      return Object.freeze(receipt);
    },
    resolveMutationAttempt({ request, reserveRequest, now } = {}) {
      assertAutonomousResearchOnlineMutationResolutionRequest(request, reserveRequest);
      const receipt = invoke(request);
      if (!verifyAutonomousResearchOnlineMutationResolution({
        receipt,
        request,
        reserveRequest,
        trust: verifier.trust,
        now,
        verifySignature: verifier.verifySignedReceipt,
        verifyReservation: (input) => verifier.verifyReservation(input),
      })) {
        invalid('autonomous_research_online_mutation_resolution_receipt_invalid');
      }
      return receipt.resolution === 'reserved'
        ? Object.freeze(receipt.reservation) : null;
    },
    listUnresolvedMutations({ request, now } = {}) {
      assertAutonomousResearchOnlineUnresolvedReservationListRequest(
        request,
        verifier.trust,
      );
      const receipt = invoke(request);
      if (!verifier.verifyUnresolvedReservations({ receipt, request, now })) {
        invalid('autonomous_research_online_unresolved_reservation_list_receipt_invalid');
      }
      return Object.freeze(receipt);
    },
    observeCurrentHead({ request, now, expectedDatabaseInstances } = {}) {
      const receipt = invoke(request);
      if (!verifier.verifyCurrentHead({
        receipt,
        request,
        now,
        expectedDatabaseInstances,
      })) {
        invalid('autonomous_research_online_mutation_current_head_receipt_invalid');
      }
      return Object.freeze(receipt);
    },
    challengeActiveAuthority({ request, now, expectedDatabaseInstances } = {}) {
      const receipt = invoke(request);
      if (!verifier.verifyActiveChallenge({
        receipt,
        request,
        now,
        expectedDatabaseInstances,
      })) {
        invalid('autonomous_research_online_mutation_active_challenge_receipt_invalid');
      }
      return Object.freeze(receipt);
    },
    observeScope({ request, now } = {}) {
      const receipt = invoke(request);
      if (!verifier.verifyScope({ receipt, request, now })) {
        invalid('autonomous_research_online_mutation_scope_receipt_invalid');
      }
      return Object.freeze(receipt);
    },
  });
}
