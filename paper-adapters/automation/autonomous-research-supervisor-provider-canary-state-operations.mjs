import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS,
} from '../../paper-domain/automation/autonomous-research-supervisor-external-action-journal.mjs';
import {
  verifyAutonomousResearchProviderCanarySideEffectInspection,
} from '../../paper-domain/automation/autonomous-research-provider-canary-side-effect-inspection.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

function recordHashValid(value, kind, hashField) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !SHA256.test(String(value[hashField] || ''))) return false;
  const { [hashField]: claimedHash, ...payload } = value;
  return hashRecord(kind, payload) === claimedHash;
}

function providerCanaryPairReceiptValid(value) {
  return value?.version === 1
    && value?.kind === 'AutonomousResearchProviderCanaryPairReceipt'
    && value?.status === 'autonomous_research_provider_canary_pair_verified'
    && value?.verified === true
    && SHA256.test(String(value?.researchAuthorProviderCanaryReceiptHash || ''))
    && SHA256.test(String(value?.formalReviewerProviderCanaryReceiptHash || ''))
    && recordHashValid(
      value,
      'AutonomousResearchProviderCanaryPairReceipt',
      'providerCanaryPairReceiptHash',
    );
}

function providerCanaryVerifiedSummary({ marker, receiptHash }) {
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorProviderCanaryVerifiedSummary',
    verified: true,
    attemptId: marker.attemptId,
    reservationHash: marker.reservationHash,
    providerCanaryPairReceiptHash: receiptHash,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchSupervisorProviderCanaryVerifiedSummaryHash: hashRecord(
      'AutonomousResearchSupervisorProviderCanaryVerifiedSummary', payload,
    ),
  });
}

export function autonomousResearchSupervisorProviderCanarySuccessEvidenceValid(value, marker) {
  if (providerCanaryPairReceiptValid(value)) {
    return value.autonomousResearchProviderConfigurationHash
      === marker?.reservation?.providerConfigurationHash;
  }
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([
    'attemptId', 'autonomousResearchSupervisorProviderCanaryVerifiedSummaryHash', 'kind',
    'providerCanaryPairReceiptHash', 'reservationHash', 'verified', 'version',
  ].sort())) return false;
  const {
    autonomousResearchSupervisorProviderCanaryVerifiedSummaryHash: claimedHash,
    ...payload
  } = value;
  return value.version === 1
    && value.kind === 'AutonomousResearchSupervisorProviderCanaryVerifiedSummary'
    && value.verified === true
    && value.attemptId === marker?.attemptId
    && value.reservationHash === marker?.reservationHash
    && SHA256.test(String(value.providerCanaryPairReceiptHash || ''))
    && SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchSupervisorProviderCanaryVerifiedSummary', payload)
      === claimedHash;
}

export function autonomousResearchSupervisorProviderCanaryProgressEvidenceValid(
  evidence,
  reservation,
) {
  return evidence?.kind === 'AutonomousResearchSupervisorProviderCanaryProgress'
    && evidence?.role === 'research_author'
    && SHA256.test(String(evidence?.providerCanaryReceiptHash || ''))
    && evidence?.providerConfigurationHash === reservation.providerConfigurationHash;
}

export function createAutonomousResearchSupervisorProviderCanaryStateOperations({
  database,
  journalSupport,
  requireOpen,
  beginTransaction,
  rollback,
  row,
  fencedRow,
  leaseIdentity,
  timestamp,
} = {}) {
  return Object.freeze({
    beginProviderCanary({ lease, providerConfigurationHash, now = new Date() } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      try {
        beginTransaction();
        const current = fencedRow(identity, observedAt);
        const lastAt = Date.parse(current.lastProviderCanaryAt || '');
        if (Number.isFinite(lastAt)
          && lastAt + current.policy.providerCanaryIntervalMs > observedAt.getTime()
          && current.lastProviderCanaryStatus === 'verified'
          && SHA256.test(String(current.lastProviderCanaryReceiptHash || ''))) {
          database.exec('COMMIT;');
          return Object.freeze({ authorized: true, required: false });
        }
        if (!SHA256.test(String(providerConfigurationHash || ''))) {
          throw new Error('autonomous_research_supervisor_provider_configuration_hash_required');
        }
        const nextCost = current.providerCanaryReservedCostUsd
          + current.policy.providerCanaryReservationCostUsd;
        const totalCost = current.observedCampaignCostUsd
          + current.observedQualificationReservedCostUsd + nextCost;
        let blocker = null;
        if (current.providerCanaryCount >= current.policy.maximumProviderCanaries) {
          blocker = 'supervisor_provider_canary_budget_exhausted';
        } else if (totalCost > current.policy.maximumLifecycleCostUsd) {
          blocker = 'supervisor_lifecycle_cost_budget_exhausted';
        }
        if (blocker) {
          database.prepare(`UPDATE autonomous_research_supervisor_campaign
            SET disposition='blocked',terminal_reason=?,lease_owner=NULL,lease_token=NULL,
              lease_expires_at=NULL,updated_at=? WHERE campaign_id=?`).run(
            blocker, observedAt.toISOString(), current.campaignId,
          );
          database.exec('COMMIT;');
          return Object.freeze({ authorized: false, required: true, blocker });
        }
        database.prepare(`UPDATE autonomous_research_supervisor_campaign SET
          provider_canary_count=provider_canary_count+1,
          provider_canary_reserved_cost_usd=?,last_provider_canary_at=?,
          last_provider_canary_status='in_progress',last_provider_canary_receipt_hash=NULL,
          updated_at=? WHERE campaign_id=?`).run(
          nextCost, observedAt.toISOString(), observedAt.toISOString(), current.campaignId,
        );
        const reserved = row(current.campaignId);
        const plannedGenerationHash = hashRecord(
          'AutonomousResearchSupervisorProviderCanaryPlannedAttempt',
          {
            campaignId: reserved.campaignId,
            dispatchCount: reserved.dispatchCount,
            providerCanaryCount: reserved.providerCanaryCount,
            leaseGeneration: identity.leaseGeneration,
            providerConfigurationHash,
            providerCanaryReservedCostUsd:
              reserved.policy.providerCanaryReservationCostUsd,
            startedAt: observedAt.toISOString(),
          },
        );
        const providerCanaryReservation = Object.freeze({
          generationSequence: reserved.providerCanaryCount,
          plannedGenerationHash,
          budgetReservationId: `supervisor-canary:${plannedGenerationHash.slice(7)}`,
          budgetEpochStart: reserved.lifecycleStartedAt,
          providerCanaryReservedAttemptCount: 1,
          providerCanaryReservedCostUsd:
            reserved.policy.providerCanaryReservationCostUsd,
        });
        const reservation = Object.freeze({
          version: 1,
          kind: 'AutonomousResearchSupervisorProviderCanaryReservation',
          campaignId: reserved.campaignId,
          dispatchCount: reserved.dispatchCount,
          providerConfigurationHash,
          providerCanaryReservation,
        });
        const attempt = journalSupport.insertInTransaction({
          identity,
          current: reserved,
          actionKind:
            AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY,
          reservation,
          observedAt,
        });
        database.exec('COMMIT;');
        return Object.freeze({
          authorized: true,
          required: true,
          providerCanaryReservation,
          externalActionAttempt: attempt,
        });
      } catch (error) {
        rollback();
        throw error;
      }
    },
    finishProviderCanary({
      lease,
      attempt,
      verified,
      receiptHash = null,
      receipt = null,
      sideEffectInspection = null,
      error = null,
      now = new Date(),
    } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      if (verified && !SHA256.test(String(receiptHash || ''))) {
        throw new Error('autonomous_research_supervisor_provider_canary_receipt_required');
      }
      try {
        beginTransaction();
        const externalAction = journalSupport.requireFencedAttempt(
          identity, attempt, observedAt,
        );
        if (externalAction.actionKind
          !== AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY) {
          throw new Error('autonomous_research_supervisor_provider_canary_attempt_invalid');
        }
        const reservation = externalAction.marker.reservation;
        let evidence = null;
        let actionAccountingComplete = false;
        let externalActionPerformed = false;
        if (verified) {
          evidence = providerCanaryPairReceiptValid(receipt)
            && receipt.providerCanaryPairReceiptHash === receiptHash
            ? receipt : providerCanaryVerifiedSummary({
              marker: externalAction.marker, receiptHash,
            });
          if (!autonomousResearchSupervisorProviderCanarySuccessEvidenceValid(
            evidence, externalAction.marker,
          )) {
            throw new Error('autonomous_research_supervisor_provider_canary_receipt_invalid');
          }
          actionAccountingComplete = true;
          externalActionPerformed = true;
        } else if (sideEffectInspection !== null) {
          if (!verifyAutonomousResearchProviderCanarySideEffectInspection(
            sideEffectInspection,
            {
              providerConfigurationHash: reservation.providerConfigurationHash,
              reservation: reservation.providerCanaryReservation,
            },
          )) {
            throw new Error(
              'autonomous_research_supervisor_provider_canary_side_effect_inspection_invalid',
            );
          }
          evidence = sideEffectInspection;
          actionAccountingComplete = sideEffectInspection.actionAccountingComplete;
          externalActionPerformed = sideEffectInspection.externalActionPerformed;
        }
        journalSupport.finishInTransaction({
          identity,
          attempt,
          observedAt,
          successful: Boolean(verified),
          evidence,
          actionAccountingComplete,
          externalActionPerformed,
          blocker: verified ? null : String(error?.message || error
            || 'autonomous_research_supervisor_provider_canary_failed'),
        });
        const result = database.prepare(`UPDATE autonomous_research_supervisor_campaign SET
          last_provider_canary_status=?,last_provider_canary_receipt_hash=?,last_error=?,
          updated_at=? WHERE campaign_id=?
          AND lease_owner=? AND lease_token=? AND lease_generation=?`).run(
          verified ? 'verified' : 'failed',
          verified ? String(receiptHash) : null,
          error ? String(error).slice(0, 1000) : null,
          observedAt.toISOString(), identity.campaignId, identity.ownerId,
          identity.leaseToken, identity.leaseGeneration,
        );
        if (Number(result.changes) !== 1) {
          throw new Error('autonomous_research_supervisor_lease_lost');
        }
        database.exec('COMMIT;');
        return row(identity.campaignId);
      } catch (caught) {
        rollback();
        throw caught;
      }
    },
  });
}
