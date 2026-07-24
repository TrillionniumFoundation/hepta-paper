import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  assertAutonomousResearchOnlineSchemaTransitionFinalizeRequest,
  assertAutonomousResearchOnlineSchemaTransitionObserveRequest,
  assertAutonomousResearchOnlineSchemaTransitionReserveRequest,
  verifyAutonomousResearchOnlineSchemaTransitionFinalization,
  verifyAutonomousResearchOnlineSchemaTransitionObservation,
  verifyAutonomousResearchOnlineSchemaTransitionReservation,
  AUTONOMOUS_RESEARCH_ONLINE_SCHEMA_TRANSITION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  fileSha256HashSync,
  readRegularJsonFileSync,
} from '../runtime/pinned-file-reader.mjs';
import {
  createAutonomousResearchOnlineMutationReceiptVerifier,
} from './autonomous-research-online-mutation-authority.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function fail(code) {
  throw new Error(code);
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
    fail('autonomous_research_online_schema_transition_process_configuration_invalid');
  }
  return configuration;
}

function assertPinnedIdentity(configuration) {
  if (fileSha256HashSync(configuration.authorityConfigurationPath)
      !== configuration.authorityConfigurationSha256
    || fileSha256HashSync(configuration.commandPath) !== configuration.commandSha256) {
    fail('autonomous_research_online_schema_transition_process_identity_mismatch');
  }
}

function processOutput(result) {
  if (result.status !== 0 || result.error || result.signal) {
    fail('autonomous_research_online_schema_transition_process_failed');
  }
  try { return JSON.parse(String(result.stdout || '').trim()); }
  catch { fail('autonomous_research_online_schema_transition_process_output_invalid'); }
}

export function createAutonomousResearchOnlineSchemaTransitionAuthorityProcessClient({
  processConfigurationPath,
} = {}) {
  const configuration = assertProcessConfiguration(
    readRegularJsonFileSync(processConfigurationPath),
  );
  assertPinnedIdentity(configuration);
  const verifier = createAutonomousResearchOnlineMutationReceiptVerifier({
    configurationPath: configuration.authorityConfigurationPath,
  });
  const invoke = (request) => {
    assertPinnedIdentity(configuration);
    return processOutput(spawnSync(
      configuration.commandPath,
      configuration.fixedArguments,
      {
        input: `${JSON.stringify(request)}\n`,
        encoding: 'utf8',
        timeout: configuration.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        shell: false,
        // child_process extends options.env when V8 coverage is active. Use a
        // fresh mutable allowlist instead of exposing the ambient environment.
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      },
    ));
  };
  return Object.freeze({
    protocol: AUTONOMOUS_RESEARCH_ONLINE_SCHEMA_TRANSITION_PROTOCOL,
    trust: verifier.trust,
    configurationHash: hashRecord(
      'AutonomousResearchOnlineSchemaTransitionAuthorityProcessConfiguration',
      configuration,
    ),
    verifySignedReceipt: verifier.verifySignedReceipt,
    reserveSchemaTransition({ request, now } = {}) {
      assertAutonomousResearchOnlineSchemaTransitionReserveRequest(request, {
        trust: verifier.trust,
      });
      const receipt = invoke(request);
      if (!verifyAutonomousResearchOnlineSchemaTransitionReservation({
        receipt,
        request,
        trust: verifier.trust,
        now,
        verifySignature: verifier.verifySignedReceipt,
      })) fail('autonomous_research_online_schema_transition_reservation_invalid');
      return Object.freeze(receipt);
    },
    verifyStoredReservation({ receipt, request, now } = {}) {
      return verifyAutonomousResearchOnlineSchemaTransitionReservation({
        receipt,
        request,
        trust: verifier.trust,
        now: now || new Date(),
        verifySignature: verifier.verifySignedReceipt,
      });
    },
    verifyHistoricalReservation({ receipt, request } = {}) {
      return verifyAutonomousResearchOnlineSchemaTransitionReservation({
        receipt,
        request,
        trust: verifier.trust,
        now: new Date(receipt?.issuedAt),
        verifySignature: verifier.verifySignedReceipt,
      });
    },
    finalizeSchemaTransition({ request, reservation, now } = {}) {
      assertAutonomousResearchOnlineSchemaTransitionFinalizeRequest(request, reservation);
      const receipt = invoke(request);
      if (!verifyAutonomousResearchOnlineSchemaTransitionFinalization({
        receipt,
        request,
        reservation,
        trust: verifier.trust,
        now,
        verifySignature: verifier.verifySignedReceipt,
      })) fail('autonomous_research_online_schema_transition_finalization_invalid');
      return Object.freeze(receipt);
    },
    verifyStoredFinalization({ receipt, request, reservation, now } = {}) {
      return verifyAutonomousResearchOnlineSchemaTransitionFinalization({
        receipt,
        request,
        reservation,
        trust: verifier.trust,
        now: now || new Date(),
        verifySignature: verifier.verifySignedReceipt,
      });
    },
    verifyHistoricalFinalization({ receipt, request, reservation } = {}) {
      return verifyAutonomousResearchOnlineSchemaTransitionFinalization({
        receipt,
        request,
        reservation,
        trust: verifier.trust,
        now: new Date(receipt?.finalizedAt),
        verifySignature: verifier.verifySignedReceipt,
      });
    },
    observeSchemaTransition({ request, now } = {}) {
      assertAutonomousResearchOnlineSchemaTransitionObserveRequest(request, {
        trust: verifier.trust,
      });
      const receipt = invoke(request);
      if (!verifyAutonomousResearchOnlineSchemaTransitionObservation({
        receipt,
        request,
        trust: verifier.trust,
        now,
        verifySignature: verifier.verifySignedReceipt,
      })) fail('autonomous_research_online_schema_transition_observation_invalid');
      return Object.freeze(receipt);
    },
    verifyStoredObservation({ receipt, request, now } = {}) {
      return verifyAutonomousResearchOnlineSchemaTransitionObservation({
        receipt,
        request,
        trust: verifier.trust,
        now: now || new Date(),
        verifySignature: verifier.verifySignedReceipt,
      });
    },
    verifyHistoricalObservation({ receipt, request } = {}) {
      return verifyAutonomousResearchOnlineSchemaTransitionObservation({
        receipt,
        request,
        trust: verifier.trust,
        now: new Date(receipt?.observedAt),
        verifySignature: verifier.verifySignedReceipt,
      });
    },
  });
}
