import { verifyPaperRecordHash } from '../../paper-domain/contracts/primitives.mjs';
import {
  inspectSubmissionHandoffPersistedAuthorityRecords,
} from '../../paper-domain/submission/submission-handoff-export-request.mjs';
import {
  inspectProviderCapabilityVerificationReceipt,
} from '../../paper-domain/submission/delivery-runtime.mjs';
import {
  resolveReceiptIssuerPolicy,
} from '../../paper-domain/evidence/receipt-issuer-policy-registry.mjs';
import {
  createSubmissionHandoffExportAuthorityQueryCapability,
} from '../../paper-ports/submission-handoff-export-authority-query-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sqlText } from '../../paper-ports/store-port.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PROVIDER_CAPABILITY_RECEIPT_STREAM = 'submission-provider-capability';
const CURRENT_SIGNATURE_REVALIDATION_KEYS = Object.freeze([
  'accountId',
  'attestationHash',
  'blockers',
  'capabilitiesHash',
  'cryptographicSignaturesVerified',
  'currentSignatureRevalidated',
  'executorDescriptorHash',
  'externalActionPerformed',
  'kind',
  'observedAt',
  'portalRoute',
  'provider',
  'providerCapabilityCurrentSignatureRevalidationReceiptHash',
  'providerCapabilityVerificationReceiptHash',
  'status',
  'verifiedSubjectIds',
  'version',
]);

function rows(store, sql, code) {
  const result = store.query(sql);
  if (!result?.ok) throw new Error(`${code}:${result?.error || 'query_failed'}`);
  return result.rows || [];
}

function paperRecordHashValid(record, kind, hashField) {
  const payload = { ...(record || {}) };
  delete payload[hashField];
  return verifyPaperRecordHash({
    kind,
    payload,
    recordHash: record?.[hashField],
  }).valid;
}

function ordinaryRecordHashValid(record, kind, hashField) {
  const payload = { ...(record || {}) };
  delete payload[hashField];
  return record?.[hashField] === hashRecord(kind, payload);
}

function parsePayload(row, blockers) {
  try {
    const payload = JSON.parse(String(row?.payload_json || ''));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      blockers.push('submission_handoff_export_authority_payload_invalid');
      return null;
    }
    return payload;
  } catch {
    blockers.push('submission_handoff_export_authority_payload_invalid');
    return null;
  }
}

function validatePayload(payload, row, blockers) {
  const dispatch = payload?._delivery?.dispatchAuthorization;
  const outbox = payload?.outbox;
  const preflight = payload?.reviewedSubmitPreflightPacket;
  const controlled = payload?.controlledExecutorReceipt;
  if (!ordinaryRecordHashValid(
    dispatch,
    'SubmissionDispatchAuthorization',
    'submissionDispatchAuthorizationHash',
  ) || dispatch?.status !== 'submission_dispatch_authorization_ready') {
    blockers.push('submission_handoff_export_authority_dispatch_invalid');
  }
  if (!paperRecordHashValid(
    outbox,
    'ExternalExecutorHandoffOutbox',
    'externalExecutorHandoffOutboxHash',
  ) || outbox?.status !== 'queued_for_dry_run_executor') {
    blockers.push('submission_handoff_export_authority_outbox_invalid');
  }
  if (!paperRecordHashValid(
    preflight,
    'ReviewedSubmitPreflightPacket',
    'reviewedSubmitPreflightPacketHash',
  ) || preflight?.status
    !== 'reviewed_submit_preflight_ready_for_external_executor') {
    blockers.push('submission_handoff_export_authority_preflight_invalid');
  }
  if (!paperRecordHashValid(
    controlled,
    'ControlledExternalExecutorReceipt',
    'controlledExternalExecutorReceiptHash',
  ) || controlled?.status
    !== 'controlled_external_executor_receipt_recorded') {
    blockers.push('submission_handoff_export_authority_executor_invalid');
  }
  if (dispatch?.paperId !== row.paper_id
      || preflight?.paperId !== row.paper_id
      || outbox?.paperId !== row.paper_id
      || controlled?.paperId !== row.paper_id) {
    blockers.push('submission_handoff_export_authority_paper_binding_invalid');
  }
  if (dispatch?.submissionDispatchAuthorizationHash !== row.dispatch_hash
      || dispatch?.outboxHash !== outbox?.externalExecutorHandoffOutboxHash
      || dispatch?.preflightHash
        !== preflight?.reviewedSubmitPreflightPacketHash
      || dispatch?.controlledExecutorReceiptHash
        !== controlled?.controlledExternalExecutorReceiptHash) {
    blockers.push('submission_handoff_export_authority_payload_binding_invalid');
  }
  if (preflight?.outboxHash !== outbox?.externalExecutorHandoffOutboxHash
      || controlled?.hashChain?.outboxHash
        !== outbox?.externalExecutorHandoffOutboxHash
      || controlled?.hashChain?.reviewedSubmitPreflightPacketHash
        !== preflight?.reviewedSubmitPreflightPacketHash) {
    blockers.push('submission_handoff_export_authority_payload_chain_invalid');
  }
  blockers.push(...inspectSubmissionHandoffPersistedAuthorityRecords({
    outbox,
    reviewedSubmitPreflightPacket: preflight,
    controlledExecutorReceipt: controlled,
    dispatchAuthorization: dispatch,
  }));
  const exactRowBindings = {
    account_id: dispatch?.accountId,
    action_scope_key: dispatch?.actionScopeKey,
    authorization_receipt_hash: dispatch?.liveAuthorizationHash,
    dispatch_cycle_hash: dispatch?.dispatchCycleHash,
    executor_capabilities_hash: dispatch?.executorCapabilitiesHash,
    executor_descriptor_hash: dispatch?.executorDescriptorHash,
    nonce: dispatch?.nonce,
    provider: dispatch?.provider,
    replay_key: dispatch?.replayKey,
    response_due_at: dispatch?.responseDueAt,
  };
  for (const [column, expected] of Object.entries(exactRowBindings)) {
    if (!expected || row[column] !== expected) {
      blockers.push(`submission_handoff_export_authority_row_binding_invalid:${column}`);
    }
  }
  return Object.freeze({ dispatch, outbox, preflight, controlled });
}

function validateDurableAuthority({
  row,
  authorization,
  providerCapability,
  releaseLock,
  responseCount,
  deadLetterCount,
  now,
  payloadRecords,
  blockers,
}) {
  const dispatch = payloadRecords?.dispatch;
  const responseDueAt = Date.parse(String(row.response_due_at || ''));
  const nextAttemptAt = Date.parse(String(row.next_attempt_at || ''));
  const rowCreatedAt = Date.parse(String(row.created_at || ''));
  const rowUpdatedAt = Date.parse(String(row.updated_at || ''));
  const authorizationConsumedAt = Date.parse(String(
    authorization?.consumed_at || '',
  ));
  const releaseLockAcquiredAt = Date.parse(String(
    releaseLock?.acquired_at || '',
  ));
  const capabilityValidFrom = Date.parse(String(
    providerCapability?.valid_from || '',
  ));
  const capabilityExpiresAt = Date.parse(String(
    providerCapability?.expires_at || '',
  ));
  const capabilityCreatedAt = Date.parse(String(
    providerCapability?.created_at || '',
  ));
  let verifiedSubjectIds = null;
  try {
    verifiedSubjectIds = JSON.parse(String(
      providerCapability?.verified_subject_ids_json || '',
    ));
  } catch {
    verifiedSubjectIds = null;
  }
  if (row.delivery_kind !== 'reviewed'
      || row.status !== 'pending'
      || Number(row.attempt_count) !== 0
      || row.claimed_by !== null
      || row.lease_token !== null
      || row.lease_expires_at !== null
      || row.heartbeat_at !== null) {
    blockers.push('submission_handoff_export_authority_not_pending');
  }
  if (!Number.isFinite(nextAttemptAt) || nextAttemptAt > now.getTime()) {
    blockers.push('submission_handoff_export_authority_not_eligible');
  }
  if (!Number.isFinite(rowCreatedAt)
      || !Number.isFinite(rowUpdatedAt)
      || rowCreatedAt > rowUpdatedAt
      || rowUpdatedAt > now.getTime()) {
    blockers.push('submission_handoff_export_authority_row_timestamp_invalid');
  }
  if (row.next_attempt_at !== row.created_at
      || row.created_at !== row.updated_at
      || row.created_at !== authorization?.consumed_at
      || row.created_at !== releaseLock?.acquired_at) {
    blockers.push(
      'submission_handoff_export_authority_initial_transaction_time_invalid',
    );
  }
  if (responseCount !== 0) {
    blockers.push('submission_handoff_export_authority_already_responded');
  }
  if (deadLetterCount !== 0) {
    blockers.push('submission_handoff_export_authority_dead_lettered');
  }
  if (!Number.isFinite(responseDueAt) || responseDueAt <= now.getTime()) {
    blockers.push('submission_handoff_export_authority_expired');
  }
  if (!authorization
      || authorization.message_id !== row.message_id
      || authorization.paper_id !== row.paper_id
      || authorization.nonce !== row.nonce
      || authorization.authorization_receipt_hash
        !== row.authorization_receipt_hash
      || authorization.replay_key !== row.replay_key
      || authorization.dispatch_cycle_hash !== row.dispatch_cycle_hash
      || !Number.isFinite(authorizationConsumedAt)
      || authorizationConsumedAt > now.getTime()) {
    blockers.push('submission_handoff_export_authority_consumption_invalid');
  }
  if (!releaseLock
      || releaseLock.message_id !== row.message_id
      || releaseLock.paper_id !== row.paper_id
      || releaseLock.lock_token !== row.dispatch_hash
      || releaseLock.status !== 'locked'
      || releaseLock.released_at !== null
      || !Number.isFinite(releaseLockAcquiredAt)
      || releaseLockAcquiredAt > now.getTime()) {
    blockers.push('submission_handoff_export_authority_release_lock_invalid');
  }
  if (!providerCapability
      || providerCapability.provider !== row.provider
      || providerCapability.account_id !== row.account_id
      || providerCapability.executor_descriptor_hash
        !== row.executor_descriptor_hash
      || providerCapability.capabilities_hash
        !== row.executor_capabilities_hash
      || providerCapability.verification_receipt_hash
        !== row.provider_capability_verification_receipt_hash
      || providerCapability.portal_route !== row.portal_route
      || providerCapability.status !== 'active'
      || !SHA256.test(String(providerCapability.attestation_hash || ''))
      || !SHA256.test(String(
        providerCapability.verification_receipt_hash || '',
      ))
      || !SHA256.test(String(
        providerCapability.executor_descriptor_hash || '',
      ))
      || !SHA256.test(String(providerCapability.capabilities_hash || ''))
      || !Array.isArray(verifiedSubjectIds)
      || verifiedSubjectIds.length === 0
      || !Number.isFinite(capabilityValidFrom)
      || !Number.isFinite(capabilityExpiresAt)
      || !Number.isFinite(capabilityCreatedAt)
      || capabilityValidFrom >= capabilityExpiresAt
      || capabilityValidFrom > now.getTime()
      || capabilityExpiresAt <= now.getTime()
      || capabilityCreatedAt > now.getTime()) {
    blockers.push('submission_handoff_export_authority_provider_capability_invalid');
  }
  if (!dispatch?.providerCapabilityVerificationReceiptHash
      || dispatch.providerCapabilityVerificationReceiptHash
        !== row.provider_capability_verification_receipt_hash) {
    blockers.push('submission_handoff_export_authority_provider_receipt_mismatch');
  }
  if (!dispatch?.portalRoute || dispatch.portalRoute !== row.portal_route) {
    blockers.push('submission_handoff_export_authority_portal_route_mismatch');
  }
}

function parseProviderCapabilityReceipt(row, blockers) {
  try {
    const receipt = JSON.parse(String(row?.receipt_json || ''));
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      throw new Error('provider_receipt_not_an_object');
    }
    return receipt;
  } catch {
    blockers.push(
      'submission_handoff_export_authority_provider_receipt_payload_invalid',
    );
    return null;
  }
}

function revalidateCurrentProviderCapabilitySignature({
  providerCapabilitySignatureRevalidator,
  providerCapability,
  receipt,
  inspection,
  row,
  now,
  blockers,
} = {}) {
  if (typeof providerCapabilitySignatureRevalidator !== 'function') {
    blockers.push(
      'submission_handoff_export_authority_provider_signature_revalidation_unavailable',
    );
    return Object.freeze({ receipt: null, revalidated: false });
  }
  let revalidation;
  try {
    revalidation = providerCapabilitySignatureRevalidator(Object.freeze({
      version: 1,
      kind: 'ProviderCapabilityCurrentSignatureRevalidationRequest',
      providerCapabilityVerificationReceipt: receipt,
      providerCapabilityVerificationReceiptHash:
        receipt?.providerCapabilityVerificationReceiptHash || null,
      attestationHash: providerCapability?.attestation_hash || null,
      provider: row.provider,
      accountId: row.account_id,
      portalRoute: row.portal_route,
      executorDescriptorHash: row.executor_descriptor_hash,
      capabilitiesHash: row.executor_capabilities_hash,
      verifiedSubjectIds: inspection?.verifiedSubjectIds || [],
      observedAt: now.toISOString(),
    }));
  } catch {
    blockers.push(
      'submission_handoff_export_authority_provider_signature_revalidation_failed',
    );
    return Object.freeze({ receipt: null, revalidated: false });
  }
  const claimedHash = revalidation
    ?.providerCapabilityCurrentSignatureRevalidationReceiptHash;
  const payload = { ...(revalidation || {}) };
  delete payload.providerCapabilityCurrentSignatureRevalidationReceiptHash;
  const expectedSubjects = JSON.stringify(
    [...new Set(inspection?.verifiedSubjectIds || [])].sort(),
  );
  const actualSubjects = JSON.stringify(
    [...new Set(revalidation?.verifiedSubjectIds || [])].sort(),
  );
  const valid = revalidation && typeof revalidation === 'object'
    && !Array.isArray(revalidation)
    && Object.keys(revalidation).sort().join('\0')
      === [...CURRENT_SIGNATURE_REVALIDATION_KEYS].sort().join('\0')
    && revalidation.version === 1
    && revalidation.kind
      === 'ProviderCapabilityCurrentSignatureRevalidationReceipt'
    && revalidation.status
      === 'provider_capability_current_signature_revalidated'
    && revalidation.cryptographicSignaturesVerified === true
    && revalidation.currentSignatureRevalidated === true
    && revalidation.externalActionPerformed === false
    && Array.isArray(revalidation.blockers)
    && revalidation.blockers.length === 0
    && revalidation.providerCapabilityVerificationReceiptHash
      === receipt?.providerCapabilityVerificationReceiptHash
    && revalidation.attestationHash === providerCapability?.attestation_hash
    && revalidation.provider === row.provider
    && revalidation.accountId === row.account_id
    && revalidation.portalRoute === row.portal_route
    && revalidation.executorDescriptorHash === row.executor_descriptor_hash
    && revalidation.capabilitiesHash === row.executor_capabilities_hash
    && revalidation.observedAt === now.toISOString()
    && actualSubjects === expectedSubjects
    && SHA256.test(String(claimedHash || ''))
    && claimedHash === hashRecord(
      'ProviderCapabilityCurrentSignatureRevalidationReceipt',
      payload,
    );
  if (!valid) {
    blockers.push(
      'submission_handoff_export_authority_provider_signature_revalidation_invalid',
    );
    return Object.freeze({ receipt: null, revalidated: false });
  }
  return Object.freeze({
    receipt: Object.freeze(structuredClone(revalidation)),
    revalidated: true,
  });
}

function validateProviderCapabilityReceiptLedger({
  ledgerRow,
  providerCapability,
  providerCapabilitySignatureRevalidator,
  row,
  now,
  blockers,
} = {}) {
  if (!ledgerRow) return Object.freeze({ receipt: null, inspection: null });
  const receipt = parseProviderCapabilityReceipt(ledgerRow, blockers);
  let verifiedSubjectIds = null;
  try {
    verifiedSubjectIds = JSON.parse(String(
      providerCapability?.verified_subject_ids_json || '',
    ));
  } catch {
    verifiedSubjectIds = null;
  }
  const inspection = receipt
    ? inspectProviderCapabilityVerificationReceipt({
      receipt,
      now,
      expected: {
        provider: row.provider,
        accountId: row.account_id,
        portalRoute: row.portal_route,
        executorDescriptorHash: row.executor_descriptor_hash,
        capabilitiesHash: row.executor_capabilities_hash,
        attestationHash: providerCapability?.attestation_hash,
        providerCapabilityVerificationReceiptHash:
          row.provider_capability_verification_receipt_hash,
        verifiedSubjectIds,
      },
    }) : null;
  blockers.push(...(inspection?.blockers || []).map((blocker) => (
    'submission_handoff_export_authority_' + blocker
  )));
  const expectedReceiptHash =
    row.provider_capability_verification_receipt_hash;
  const expectedReceiptId =
    PROVIDER_CAPABILITY_RECEIPT_STREAM + ':' + expectedReceiptHash;
  if (ledgerRow.receipt_id !== expectedReceiptId
      || ledgerRow.stream !== PROVIDER_CAPABILITY_RECEIPT_STREAM
      || ledgerRow.kind !== 'ProviderCapabilityVerificationReceipt'
      || ledgerRow.status !== 'provider_capability_verified'
      || ledgerRow.receipt_sha256 !== expectedReceiptHash
      || receipt?.providerCapabilityVerificationReceiptHash
        !== expectedReceiptHash) {
    blockers.push(
      'submission_handoff_export_authority_provider_receipt_ledger_binding_invalid',
    );
  }
  if (Number(ledgerRow.effective_receipt_usable) !== 1
      || ledgerRow.effective_disposition !== null
      || ledgerRow.effective_replacement_receipt_id !== null) {
    blockers.push(
      'submission_handoff_export_authority_provider_receipt_not_effective',
    );
  }
  const ledgerCreatedAt = Date.parse(String(ledgerRow.created_at || ''));
  if (!Number.isFinite(ledgerCreatedAt)
      || ledgerCreatedAt > now.getTime()
      || ledgerRow.created_at !== providerCapability?.created_at
      || ledgerRow.environment !== 'production') {
    blockers.push(
      'submission_handoff_export_authority_provider_receipt_ledger_time_invalid',
    );
  }
  if (Number(ledgerRow.writer_trusted) !== 1
      || !ledgerRow.writer_id
      || !ledgerRow.writer_kind) {
    blockers.push(
      'submission_handoff_export_authority_provider_receipt_writer_untrusted',
    );
  }
  const issuerPolicy = resolveReceiptIssuerPolicy(ledgerRow.issuer_policy_id);
  if (!issuerPolicy
      || ledgerRow.issuer_policy_hash !== issuerPolicy.issuerPolicyHash
      || ledgerRow.issuer_assurance !== issuerPolicy.assurance
      || ledgerRow.writer_id !== issuerPolicy.writerId
      || ledgerRow.writer_kind !== issuerPolicy.writerKind
      || !issuerPolicy.allowedKinds.includes(ledgerRow.kind)
      || !issuerPolicy.allowedStreams.includes(ledgerRow.stream)) {
    blockers.push(
      'submission_handoff_export_authority_provider_receipt_issuer_policy_invalid',
    );
  }
  const currentSignature = revalidateCurrentProviderCapabilitySignature({
    providerCapabilitySignatureRevalidator,
    providerCapability,
    receipt,
    inspection,
    row,
    now,
    blockers,
  });
  return Object.freeze({ receipt, inspection, currentSignature });
}

function queryOne(store, sql, code) {
  const result = rows(store, sql, code);
  return result.length === 1 ? result[0] : null;
}

export function createSqliteSubmissionHandoffExportAuthorityQuery({
  store,
  clock,
  requireCurrentProviderCapabilitySignatureRevalidation,
  providerCapabilitySignatureRevalidator = null,
} = {}) {
  if (store?.readOnly !== true || typeof store.query !== 'function') {
    throw new Error('submission_handoff_export_read_only_store_required');
  }
  if (typeof clock?.now !== 'function') {
    throw new Error('submission_handoff_export_authority_clock_required');
  }
  if (requireCurrentProviderCapabilitySignatureRevalidation !== true) {
    throw new Error(
      'submission_handoff_export_current_provider_signature_revalidation_required',
    );
  }
  return createSubmissionHandoffExportAuthorityQueryCapability(Object.freeze({
    version: 1,
    kind: 'SubmissionHandoffExportAuthorityQueryPort',
    readOnly: true,
    getCurrentReviewedSubmissionAuthority({
      paperId,
      dispatchAuthorizationHash,
    } = {}) {
      if (!SHA256.test(String(dispatchAuthorizationHash || ''))) {
        throw new Error('submission_handoff_export_dispatch_hash_invalid');
      }
      const inspectSnapshot = (snapshotStore) => {
      const rowSet = rows(snapshotStore, `SELECT * FROM submission_outbox
        WHERE delivery_kind='reviewed'
          AND dispatch_hash=${sqlText(dispatchAuthorizationHash)} LIMIT 2;`,
      'submission_handoff_export_outbox_query_failed');
      if (rowSet.length === 0) return null;
      const row = rowSet[0];
      const blockers = [];
      if (rowSet.length !== 1
          || row.paper_id !== paperId
          || row.message_id !== `submission:${dispatchAuthorizationHash}`) {
        blockers.push('submission_handoff_export_authority_identity_invalid');
      }
      const payload = parsePayload(row, blockers);
      const payloadRecords = payload
        ? validatePayload(payload, row, blockers)
        : null;
      const authorization = queryOne(snapshotStore, `SELECT *
        FROM submission_authorization_consumptions
        WHERE message_id=${sqlText(row.message_id)} LIMIT 2;`,
      'submission_handoff_export_authorization_query_failed');
      const providerCapability = queryOne(snapshotStore, `SELECT *
        FROM submission_provider_capabilities
        WHERE provider=${sqlText(row.provider)}
          AND account_id=${sqlText(row.account_id)}
          AND executor_descriptor_hash=${sqlText(row.executor_descriptor_hash)}
        LIMIT 2;`, 'submission_handoff_export_provider_query_failed');
      const providerReceiptId = `${PROVIDER_CAPABILITY_RECEIPT_STREAM}:${
        row.provider_capability_verification_receipt_hash
      }`;
      const providerReceiptRows = rows(snapshotStore, `SELECT *
        FROM effective_receipt_ledger
        WHERE receipt_id=${sqlText(providerReceiptId)} LIMIT 2;`,
      'submission_handoff_export_provider_receipt_query_failed');
      if (providerReceiptRows.length !== 1) {
        blockers.push(
          'submission_handoff_export_authority_provider_receipt_ledger_missing',
        );
      }
      const releaseLock = queryOne(snapshotStore, `SELECT * FROM submission_release_locks
        WHERE paper_id=${sqlText(row.paper_id)} LIMIT 2;`,
      'submission_handoff_export_release_lock_query_failed');
      const responseCount = Number(queryOne(snapshotStore, `SELECT count(*) AS count
        FROM submission_inbox WHERE message_id=${sqlText(row.message_id)};`,
      'submission_handoff_export_response_query_failed')?.count || 0);
      const deadLetterCount = Number(queryOne(snapshotStore, `SELECT count(*) AS count
        FROM submission_dead_letters WHERE message_id=${sqlText(row.message_id)};`,
      'submission_handoff_export_dead_letter_query_failed')?.count || 0);
      const observedAt = clock.now();
      if (!(observedAt instanceof Date)
          || !Number.isFinite(observedAt.getTime())) {
        throw new Error('submission_handoff_export_authority_clock_invalid');
      }
      validateDurableAuthority({
        row,
        authorization,
        providerCapability,
        releaseLock,
        responseCount,
        deadLetterCount,
        now: observedAt,
        payloadRecords,
        blockers,
      });
      const providerReceiptAuthority =
        validateProviderCapabilityReceiptLedger({
          ledgerRow: providerReceiptRows.length === 1
            ? providerReceiptRows[0] : null,
          providerCapability,
          providerCapabilitySignatureRevalidator,
          row,
          now: observedAt,
          blockers,
        });
      const uniqueBlockers = [...new Set(blockers)];
      const authorityPayload = {
        version: 1,
        kind: 'PersistedSubmissionHandoffExportAuthority',
        status: uniqueBlockers.length
          ? 'submission_handoff_export_authority_blocked'
          : 'submission_handoff_export_authority_ready',
        messageId: row.message_id,
        paperId: row.paper_id,
        dispatchAuthorizationHash: row.dispatch_hash,
        outbox: payloadRecords?.outbox || null,
        reviewedSubmitPreflightPacket: payloadRecords?.preflight || null,
        controlledExecutorReceipt: payloadRecords?.controlled || null,
        dispatchAuthorization: payloadRecords?.dispatch || null,
        payloadBindingHash: hashRecord(
          'SubmissionHandoffExportAuthorityPayloadBinding',
          {
            outboxHash: payloadRecords?.outbox
              ?.externalExecutorHandoffOutboxHash || null,
            reviewedSubmitPreflightPacketHash: payloadRecords?.preflight
              ?.reviewedSubmitPreflightPacketHash || null,
            controlledExternalExecutorReceiptHash: payloadRecords?.controlled
              ?.controlledExternalExecutorReceiptHash || null,
            dispatchAuthorizationHash: payloadRecords?.dispatch
              ?.submissionDispatchAuthorizationHash || null,
          },
        ),
        rowBindingHash: hashRecord('SubmissionHandoffExportOutboxRowBinding', {
          messageId: row.message_id,
          paperId: row.paper_id,
          dispatchHash: row.dispatch_hash,
          provider: row.provider,
          accountId: row.account_id,
          nonce: row.nonce,
          replayKey: row.replay_key,
          actionScopeKey: row.action_scope_key,
          dispatchCycleHash: row.dispatch_cycle_hash,
          authorizationReceiptHash: row.authorization_receipt_hash,
          executorDescriptorHash: row.executor_descriptor_hash,
          executorCapabilitiesHash: row.executor_capabilities_hash,
          providerCapabilityVerificationReceiptHash:
            row.provider_capability_verification_receipt_hash,
          portalRoute: row.portal_route,
          responseDueAt: row.response_due_at,
        }),
        authorizationConsumptionHash: authorization ? hashRecord(
          'SubmissionHandoffExportAuthorizationConsumption',
          authorization,
        ) : null,
        releaseLockHash: releaseLock ? hashRecord(
          'SubmissionHandoffExportReleaseLock',
          releaseLock,
        ) : null,
        providerCapabilityHash: providerCapability ? hashRecord(
          'SubmissionHandoffExportProviderCapability',
          providerCapability,
        ) : null,
        providerCapabilityValidFrom:
          providerCapability?.valid_from || null,
        providerCapabilityExpiresAt:
          providerCapability?.expires_at || null,
        providerCapabilityVerificationReceipt:
          providerReceiptAuthority.receipt,
        providerCapabilityVerificationReceiptInspection:
          providerReceiptAuthority.inspection,
        providerCapabilityLedgerReceiptId:
          providerReceiptRows.length === 1
            ? providerReceiptRows[0].receipt_id : null,
        providerCapabilityLedgerReceiptHash:
          providerReceiptRows.length === 1
            ? providerReceiptRows[0].receipt_sha256 : null,
        providerCapabilityCurrentSignatureRevalidationReceipt:
          providerReceiptAuthority.currentSignature?.receipt || null,
        providerCapabilityCurrentSignatureRevalidationReceiptHash:
          providerReceiptAuthority.currentSignature?.receipt
            ?.providerCapabilityCurrentSignatureRevalidationReceiptHash
              || null,
        providerCapabilityCurrentSignatureRevalidated:
          providerReceiptAuthority.currentSignature?.revalidated === true,
        responseCount,
        deadLetterCount,
        observedAt: observedAt.toISOString(),
        blockers: uniqueBlockers,
        readOnly: true,
        externalActionPerformed: false,
      };
      return Object.freeze({
        ...authorityPayload,
        submissionHandoffExportAuthorityHash: hashRecord(
          'PersistedSubmissionHandoffExportAuthority',
          authorityPayload,
        ),
      });
      };
      return store.transaction(inspectSnapshot, { readOnly: true });
    },
  }));
}
