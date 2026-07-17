import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createAutonomousResearchSupervisorExternalActionRepositorySupport, installAutonomousResearchSupervisorExternalActionJournalSchema } from './autonomous-research-supervisor-external-action-repository-support.mjs';
import { autonomousResearchSupervisorProviderCanaryProgressEvidenceValid, autonomousResearchSupervisorProviderCanarySuccessEvidenceValid, createAutonomousResearchSupervisorProviderCanaryStateOperations } from './autonomous-research-supervisor-provider-canary-state-operations.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const TERMINAL = new Set(['blocked', 'settled']);

function integer(value, fallback, minimum, maximum) {
  const candidate = value === undefined || value === null || value === ''
    ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate)) return fallback;
  return Math.max(minimum, Math.min(maximum, candidate));
}

function number(value, fallback, minimum, maximum) {
  const candidate = value === undefined || value === null || value === ''
    ? fallback : Number(value);
  if (!Number.isFinite(candidate)) return fallback;
  return Math.max(minimum, Math.min(maximum, candidate));
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('autonomous_research_supervisor_clock_invalid');
  }
  return date;
}

export function normalizeAutonomousResearchSupervisorLifecyclePolicy(value = {}) {
  const leaseMs = integer(value.leaseMs, 15 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000);
  const baseCooldownMs = integer(value.baseCooldownMs, 1000, 100, 60 * 60 * 1000);
  const maximumCooldownMs = Math.max(baseCooldownMs, integer(
    value.maximumCooldownMs,
    5 * 60 * 1000,
    baseCooldownMs,
    24 * 60 * 60 * 1000,
  ));
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorLifecyclePolicy',
    maximumDispatches: integer(value.maximumDispatches, 256, 1, 10_000),
    maximumProviderCanaries: integer(value.maximumProviderCanaries, 64, 1, 1000),
    maximumConsecutiveFailures: integer(value.maximumConsecutiveFailures, 32, 1, 1000),
    maximumLifecycleCostUsd: number(value.maximumLifecycleCostUsd, 150, 0.01, 100_000),
    maximumLifetimeMs: integer(value.maximumLifetimeMs,
      7 * 24 * 60 * 60 * 1000, 60 * 1000, 30 * 24 * 60 * 60 * 1000),
    leaseMs,
    baseCooldownMs,
    maximumCooldownMs,
    providerCanaryIntervalMs: integer(value.providerCanaryIntervalMs,
      15 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    providerCanaryReservationCostUsd: number(
      value.providerCanaryReservationCostUsd, 0, 0, 1000),
    qualificationMaximumTotalAttempts: integer(
      value.qualificationMaximumTotalAttempts, 48, 1, 1000),
    qualificationMaximumTotalCostUsd: number(
      value.qualificationMaximumTotalCostUsd, 25, 0.01, 10_000),
    qualificationAttemptReservationCostUsd: number(
      value.qualificationAttemptReservationCostUsd, 0.05, 0.000001, 1000),
    qualificationRenewalLeadMs: integer(value.qualificationRenewalLeadMs,
      15 * 60 * 1000, 0, 24 * 60 * 60 * 1000),
    qualificationActionSafetyMarginMs: integer(value.qualificationActionSafetyMarginMs,
      15 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000),
  });
  if (payload.providerCanaryReservationCostUsd * payload.maximumProviderCanaries
      + payload.qualificationMaximumTotalCostUsd > payload.maximumLifecycleCostUsd) {
    throw new Error('autonomous_research_supervisor_lifecycle_cost_envelope_invalid');
  }
  return Object.freeze({
    ...payload,
    lifecyclePolicyHash: hashRecord('AutonomousResearchSupervisorLifecyclePolicy', payload),
  });
}

function parsePolicy(row) {
  let policy;
  try { policy = JSON.parse(String(row.policy_json || '')); }
  catch { throw new Error('autonomous_research_supervisor_policy_state_invalid'); }
  const { lifecyclePolicyHash, ...input } = policy;
  const normalized = normalizeAutonomousResearchSupervisorLifecyclePolicy(input);
  if (!SHA256.test(String(lifecyclePolicyHash || ''))
    || lifecyclePolicyHash !== row.policy_hash
    || lifecyclePolicyHash !== normalized.lifecyclePolicyHash) {
    throw new Error('autonomous_research_supervisor_policy_state_invalid');
  }
  return normalized;
}

function mapRow(row) {
  if (!row) return null;
  const policy = parsePolicy(row);
  let lastOutcome = null;
  if (row.last_outcome_json) {
    try { lastOutcome = JSON.parse(row.last_outcome_json); }
    catch { throw new Error('autonomous_research_supervisor_outcome_state_invalid'); }
  }
  return Object.freeze({
    campaignId: row.campaign_id,
    paperId: row.paper_id,
    disposition: row.disposition,
    policy,
    lifecycleStartedAt: row.lifecycle_started_at,
    absoluteDeadlineAt: row.absolute_deadline_at,
    dispatchCount: Number(row.dispatch_count),
    providerCanaryCount: Number(row.provider_canary_count),
    providerCanaryReservedCostUsd: Number(row.provider_canary_reserved_cost_usd),
    observedCampaignCostUsd: Number(row.observed_campaign_cost_usd),
    observedQualificationReservedCostUsd:
      Number(row.observed_qualification_reserved_cost_usd),
    costKnown: Boolean(row.cost_known),
    consecutiveFailures: Number(row.consecutive_failures),
    nextDispatchAt: row.next_dispatch_at,
    lastProviderCanaryAt: row.last_provider_canary_at || null,
    lastProviderCanaryStatus: row.last_provider_canary_status || null,
    lastProviderCanaryReceiptHash: row.last_provider_canary_receipt_hash || null,
    lastOutcome,
    lastError: row.last_error || null,
    terminalReason: row.terminal_reason || null,
    recoveredLeaseCount: Number(row.recovered_lease_count),
    leaseOwner: row.lease_owner || null,
    leaseToken: row.lease_token || null,
    leaseGeneration: Number(row.lease_generation),
    leaseExpiresAt: row.lease_expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function leaseIdentity(value = {}) {
  if (!SAFE_ID.test(String(value.campaignId || ''))
    || !SAFE_ID.test(String(value.ownerId || ''))
    || !SAFE_ID.test(String(value.leaseToken || ''))
    || !Number.isSafeInteger(Number(value.leaseGeneration))
    || Number(value.leaseGeneration) < 1) {
    throw new Error('autonomous_research_supervisor_lease_identity_invalid');
  }
  return Object.freeze({
    campaignId: String(value.campaignId),
    ownerId: String(value.ownerId),
    leaseToken: String(value.leaseToken),
    leaseGeneration: Number(value.leaseGeneration),
  });
}

function boundedOutcome(value) {
  if (value === null || value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 64 * 1024) {
    throw new Error('autonomous_research_supervisor_outcome_too_large');
  }
  return serialized;
}

export function createAutonomousResearchSupervisorStateRepository({
  runtimeRoot,
  busyTimeoutMs = 10_000,
} = {}) {
  if (!runtimeRoot) throw new Error('autonomous_research_supervisor_runtime_root_required');
  const stateRoot = path.join(path.resolve(runtimeRoot), 'autonomous-research', 'supervisor');
  const databasePath = path.join(stateRoot, 'supervisor-state.sqlite');
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateRoot, 0o700);
  const database = new DatabaseSync(databasePath);
  database.exec(`PRAGMA busy_timeout=${Math.max(1, Number(busyTimeoutMs || 10_000))};`);
  database.exec('PRAGMA journal_mode=WAL;');
  database.exec('PRAGMA synchronous=FULL;');
  database.exec(`CREATE TABLE IF NOT EXISTS autonomous_research_supervisor_campaign (
    campaign_id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK(disposition IN ('active','blocked','settled')),
    policy_json TEXT NOT NULL,
    policy_hash TEXT NOT NULL,
    lifecycle_started_at TEXT NOT NULL,
    absolute_deadline_at TEXT NOT NULL,
    dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_count >= 0),
    provider_canary_count INTEGER NOT NULL DEFAULT 0 CHECK(provider_canary_count >= 0),
    provider_canary_reserved_cost_usd REAL NOT NULL DEFAULT 0 CHECK(provider_canary_reserved_cost_usd >= 0),
    observed_campaign_cost_usd REAL NOT NULL DEFAULT 0 CHECK(observed_campaign_cost_usd >= 0),
    observed_qualification_reserved_cost_usd REAL NOT NULL DEFAULT 0 CHECK(observed_qualification_reserved_cost_usd >= 0),
    cost_known INTEGER NOT NULL DEFAULT 1 CHECK(cost_known IN (0,1)),
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
    next_dispatch_at TEXT NOT NULL,
    last_provider_canary_at TEXT,
    last_provider_canary_status TEXT,
    last_provider_canary_receipt_hash TEXT,
    last_outcome_json TEXT,
    last_error TEXT,
    terminal_reason TEXT,
    recovered_lease_count INTEGER NOT NULL DEFAULT 0 CHECK(recovered_lease_count >= 0),
    lease_owner TEXT,
    lease_token TEXT,
    lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0),
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;`);
  const supervisorColumns = new Set(database.prepare(
    'PRAGMA table_info(autonomous_research_supervisor_campaign)',
  ).all().map((column) => column.name));
  if (!supervisorColumns.has('last_provider_canary_receipt_hash')) {
    database.exec(`ALTER TABLE autonomous_research_supervisor_campaign
      ADD COLUMN last_provider_canary_receipt_hash TEXT;`);
  }
  installAutonomousResearchSupervisorExternalActionJournalSchema(database);
  fs.chmodSync(databasePath, 0o600);
  let closed = false;

  function requireOpen() {
    if (closed) throw new Error('autonomous_research_supervisor_state_repository_closed');
  }

  let externalActionSupport = null;

  function row(campaignId) {
    requireOpen();
    const campaign = mapRow(database.prepare(
      'SELECT * FROM autonomous_research_supervisor_campaign WHERE campaign_id=?',
    ).get(campaignId));
    if (!campaign) return null;
    const activeExternalAction = externalActionSupport?.activeAttemptForCampaign(campaignId) || null;
    if (activeExternalAction && (
      activeExternalAction.dispatchCount > campaign.dispatchCount
      || activeExternalAction.providerCanaryCount > campaign.providerCanaryCount
      || activeExternalAction.leaseGeneration > campaign.leaseGeneration
    )) throw new Error('autonomous_research_supervisor_external_action_journal_invalid');
    return Object.freeze({
      ...campaign,
      externalActionInProgress: Boolean(activeExternalAction),
      activeExternalActionAttempt: activeExternalAction,
    });
  }

  function begin() { database.exec('BEGIN IMMEDIATE;'); }
  function rollback() {
    if (database.isTransaction) {
      try { database.exec('ROLLBACK;'); } catch { /* preserve the original failure */ }
    }
  }

  function fencedRow(identity, now) {
    const current = row(identity.campaignId);
    if (!current || current.leaseOwner !== identity.ownerId
      || current.leaseToken !== identity.leaseToken
      || current.leaseGeneration !== identity.leaseGeneration
      || Date.parse(current.leaseExpiresAt || '') <= now.getTime()) {
      throw new Error('autonomous_research_supervisor_lease_lost');
    }
    return current;
  }

  externalActionSupport = createAutonomousResearchSupervisorExternalActionRepositorySupport({
    database,
    requireOpen,
    beginTransaction: begin,
    rollback,
    fencedRow,
    leaseIdentity,
    timestamp,
    providerCanarySuccessEvidenceValid:
      autonomousResearchSupervisorProviderCanarySuccessEvidenceValid,
    providerCanaryProgressEvidenceValid:
      autonomousResearchSupervisorProviderCanaryProgressEvidenceValid,
  });
  const providerCanaryOperations =
    createAutonomousResearchSupervisorProviderCanaryStateOperations({
      database,
      journalSupport: externalActionSupport,
      requireOpen,
      beginTransaction: begin,
      rollback,
      row,
      fencedRow,
      leaseIdentity,
      timestamp,
    });

  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorStateRepository',
    durable: true,
    sqliteCompareAndSwap: true,
    databasePath,
    registerCampaign({ campaignId, paperId, policy: suppliedPolicy = {}, now = new Date() } = {}) {
      requireOpen();
      if (!SAFE_ID.test(String(campaignId || '')) || !SAFE_ID.test(String(paperId || ''))) {
        throw new Error('autonomous_research_supervisor_campaign_scope_invalid');
      }
      const policy = normalizeAutonomousResearchSupervisorLifecyclePolicy(suppliedPolicy);
      const observedAt = timestamp(now);
      const existing = row(campaignId);
      if (existing) {
        if (existing.paperId !== paperId
          || existing.policy.lifecyclePolicyHash !== policy.lifecyclePolicyHash) {
          throw new Error('autonomous_research_supervisor_lifecycle_policy_immutable');
        }
        return existing;
      }
      database.prepare(`INSERT INTO autonomous_research_supervisor_campaign(
        campaign_id,paper_id,disposition,policy_json,policy_hash,lifecycle_started_at,
        absolute_deadline_at,next_dispatch_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        String(campaignId),
        String(paperId),
        'active',
        JSON.stringify(policy),
        policy.lifecyclePolicyHash,
        observedAt.toISOString(),
        new Date(observedAt.getTime() + policy.maximumLifetimeMs).toISOString(),
        observedAt.toISOString(),
        observedAt.toISOString(),
        observedAt.toISOString(),
      );
      return row(campaignId);
    },
    getCampaign: row,
    listCampaigns({ disposition = null, limit = 1000 } = {}) {
      requireOpen();
      const bounded = Math.max(1, Math.min(10_000, Number(limit || 1000)));
      const rows = disposition
        ? database.prepare(`SELECT * FROM autonomous_research_supervisor_campaign
          WHERE disposition=? ORDER BY next_dispatch_at,campaign_id LIMIT ?`).all(disposition, bounded)
        : database.prepare(`SELECT * FROM autonomous_research_supervisor_campaign
          ORDER BY next_dispatch_at,campaign_id LIMIT ?`).all(bounded);
      return Object.freeze(rows.map((item) => row(item.campaign_id)));
    },
    reconcileStaleLeases({ now = new Date() } = {}) {
      requireOpen();
      const observed = timestamp(now);
      const observedAt = observed.toISOString();
      try {
        begin();
        const recoveredReceipts = externalActionSupport.recoverStaleAttemptsInTransaction({
          observedAt: observed,
        });
        const result = database.prepare(`UPDATE autonomous_research_supervisor_campaign
          SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
            recovered_lease_count=recovered_lease_count+1,updated_at=?
          WHERE lease_expires_at IS NOT NULL AND julianday(lease_expires_at)<=julianday(?)`).run(
          observedAt,
          observedAt,
        );
        database.exec('COMMIT;');
        return Object.freeze({
          recoveredLeaseCount: Number(result.changes),
          recoveredExternalActionCount: recoveredReceipts.length,
          recoveredExternalActionReceipts: Object.freeze(recoveredReceipts),
          reconciledAt: observedAt,
        });
      } catch (error) {
        rollback();
        throw error;
      }
    },
    tryAcquireCampaignLease({ campaignId, ownerId, leaseMs, now = new Date() } = {}) {
      requireOpen();
      if (!SAFE_ID.test(String(campaignId || '')) || !SAFE_ID.test(String(ownerId || ''))) {
        throw new Error('autonomous_research_supervisor_lease_scope_invalid');
      }
      const observedAt = timestamp(now);
      const duration = integer(
        leaseMs,
        15 * 60 * 1000,
        15 * 60 * 1000,
        30 * 60 * 1000,
      );
      try {
        begin();
        let current = row(campaignId);
        const activeAttempt = current?.activeExternalActionAttempt;
        if (activeAttempt && (current.leaseGeneration !== activeAttempt.leaseGeneration
          || !current.leaseExpiresAt
          || Date.parse(current.leaseExpiresAt) <= observedAt.getTime())) {
          externalActionSupport.recoverActiveAttemptInTransaction({
            current,
            observedAt,
            blocker: 'autonomous_research_supervisor_external_action_interrupted_before_lease_reacquire',
          });
          database.prepare(`UPDATE autonomous_research_supervisor_campaign SET
            recovered_lease_count=recovered_lease_count+1 WHERE campaign_id=?`).run(campaignId);
          current = row(campaignId);
        }
        if (current && !TERMINAL.has(current.disposition)
          && Date.parse(current.absoluteDeadlineAt) <= observedAt.getTime()) {
          database.prepare(`UPDATE autonomous_research_supervisor_campaign SET
            disposition='blocked',terminal_reason='supervisor_lifecycle_deadline_exhausted',
            lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
            WHERE campaign_id=?`).run(observedAt.toISOString(), campaignId);
          database.exec('COMMIT;');
          return null;
        }
        if (!current || TERMINAL.has(current.disposition)
          || Date.parse(current.nextDispatchAt) > observedAt.getTime()
          || (current.leaseExpiresAt
            && Date.parse(current.leaseExpiresAt) > observedAt.getTime())) {
          database.exec('COMMIT;');
          return null;
        }
        const lease = Object.freeze({
          campaignId: current.campaignId,
          ownerId: String(ownerId),
          leaseToken: `lease:${crypto.randomUUID()}`,
          leaseGeneration: current.leaseGeneration + 1,
          expiresAt: new Date(observedAt.getTime() + duration).toISOString(),
        });
        const update = database.prepare(`UPDATE autonomous_research_supervisor_campaign
          SET lease_owner=?,lease_token=?,lease_generation=?,lease_expires_at=?,updated_at=?
          WHERE campaign_id=? AND lease_generation=?`).run(
          lease.ownerId,
          lease.leaseToken,
          lease.leaseGeneration,
          lease.expiresAt,
          observedAt.toISOString(),
          campaignId,
          current.leaseGeneration,
        );
        if (Number(update.changes) !== 1) {
          throw new Error('autonomous_research_supervisor_lease_fence_conflict');
        }
        database.exec('COMMIT;');
        return lease;
      } catch (error) {
        rollback();
        throw error;
      }
    },
    renewCampaignLease({ lease, leaseMs, now = new Date() } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      const expiresAt = new Date(observedAt.getTime()
        + integer(
          leaseMs,
          15 * 60 * 1000,
          15 * 60 * 1000,
          30 * 60 * 1000,
        )).toISOString();
      const result = database.prepare(`UPDATE autonomous_research_supervisor_campaign
        SET lease_expires_at=?,updated_at=? WHERE campaign_id=? AND lease_owner=?
        AND lease_token=? AND lease_generation=?
        AND julianday(lease_expires_at)>julianday(?)`).run(
        expiresAt,
        observedAt.toISOString(),
        identity.campaignId,
        identity.ownerId,
        identity.leaseToken,
        identity.leaseGeneration,
        observedAt.toISOString(),
      );
      return Number(result.changes) === 1 ? Object.freeze({ ...identity, expiresAt }) : null;
    },
    assertCampaignLease({ lease, now = new Date() } = {}) {
      requireOpen();
      fencedRow(leaseIdentity(lease), timestamp(now));
      return true;
    },
    beginExternalActionAttempt: externalActionSupport.beginExternalActionAttempt,
    recordExternalActionProgress: externalActionSupport.recordExternalActionProgress,
    finishExternalActionAttempt: externalActionSupport.finishExternalActionAttempt,
    getExternalActionAttempt: externalActionSupport.getExternalActionAttempt,
    listExternalActionAttempts: externalActionSupport.listExternalActionAttempts,
    beginDispatch({ lease, campaignCostLimitUsd, now = new Date() } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      try {
        begin();
        const current = fencedRow(identity, observedAt);
        const reservedEnvelope = Number(campaignCostLimitUsd)
          + current.policy.qualificationMaximumTotalCostUsd
          + current.providerCanaryReservedCostUsd
          + current.policy.providerCanaryReservationCostUsd;
        let blocker = null;
        if (!Number.isFinite(Number(campaignCostLimitUsd)) || campaignCostLimitUsd < 0) {
          blocker = 'supervisor_campaign_cost_limit_unknown';
        } else if (reservedEnvelope > current.policy.maximumLifecycleCostUsd) {
          blocker = 'supervisor_lifecycle_cost_envelope_exceeded';
        } else if (current.dispatchCount >= current.policy.maximumDispatches) {
          blocker = 'supervisor_lifecycle_dispatch_budget_exhausted';
        } else if (Date.parse(current.absoluteDeadlineAt) <= observedAt.getTime()) {
          blocker = 'supervisor_lifecycle_deadline_exhausted';
        } else if (!current.costKnown) {
          blocker = 'supervisor_lifecycle_cost_unknown';
        }
        if (blocker) {
          database.prepare(`UPDATE autonomous_research_supervisor_campaign
            SET disposition='blocked',terminal_reason=?,lease_owner=NULL,lease_token=NULL,
              lease_expires_at=NULL,updated_at=? WHERE campaign_id=?`).run(
            blocker,
            observedAt.toISOString(),
            current.campaignId,
          );
          database.exec('COMMIT;');
          return Object.freeze({ authorized: false, blocker });
        }
        database.prepare(`UPDATE autonomous_research_supervisor_campaign
          SET dispatch_count=dispatch_count+1,updated_at=? WHERE campaign_id=?`).run(
          observedAt.toISOString(), current.campaignId,
        );
        database.exec('COMMIT;');
        return Object.freeze({ authorized: true, dispatchCount: current.dispatchCount + 1 });
      } catch (error) {
        rollback();
        throw error;
      }
    },
    beginProviderCanary: providerCanaryOperations.beginProviderCanary,
    finishProviderCanary: providerCanaryOperations.finishProviderCanary,
    finishDispatch({
      lease,
      outcome = null,
      observedCampaignCostUsd = 0,
      observedQualificationReservedCostUsd = 0,
      costKnown = true,
      successful = false,
      settled = false,
      terminalReason: suppliedTerminalReason = null,
      nextDispatchAt,
      error = null,
      now = new Date(),
    } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      const nextAt = timestamp(nextDispatchAt || observedAt);
      try {
        begin();
        const current = fencedRow(identity, observedAt);
        if (current.activeExternalActionAttempt) {
          throw new Error('autonomous_research_supervisor_external_action_in_progress');
        }
        const failures = successful ? 0 : current.consecutiveFailures + 1;
        let disposition = settled ? 'settled' : 'active';
        let terminalReason = null;
        const campaignCost = Number(observedCampaignCostUsd);
        const qualificationCost = Number(observedQualificationReservedCostUsd);
        const known = Boolean(costKnown && Number.isFinite(campaignCost)
          && campaignCost >= 0 && Number.isFinite(qualificationCost) && qualificationCost >= 0);
        const totalCost = Math.max(current.observedCampaignCostUsd, known ? campaignCost : 0)
          + Math.max(current.observedQualificationReservedCostUsd, known ? qualificationCost : 0)
          + current.providerCanaryReservedCostUsd;
        if (suppliedTerminalReason) {
          disposition = 'blocked';
          terminalReason = String(suppliedTerminalReason).slice(0, 1000);
        } else if (!known) {
          disposition = 'blocked';
          terminalReason = 'supervisor_lifecycle_cost_unknown';
        } else if (totalCost > current.policy.maximumLifecycleCostUsd) {
          disposition = 'blocked';
          terminalReason = 'supervisor_lifecycle_cost_budget_exhausted';
        } else if (failures >= current.policy.maximumConsecutiveFailures) {
          disposition = 'blocked';
          terminalReason = 'supervisor_consecutive_failure_budget_exhausted';
        } else if (nextAt.getTime() > Date.parse(current.absoluteDeadlineAt)) {
          disposition = 'blocked';
          terminalReason = 'supervisor_lifecycle_deadline_exhausted';
        }
        const result = database.prepare(`UPDATE autonomous_research_supervisor_campaign SET
          disposition=?,observed_campaign_cost_usd=max(observed_campaign_cost_usd,?),
          observed_qualification_reserved_cost_usd=max(observed_qualification_reserved_cost_usd,?),
          cost_known=?,consecutive_failures=?,next_dispatch_at=?,last_outcome_json=?,
          last_error=?,terminal_reason=?,lease_owner=NULL,lease_token=NULL,
          lease_expires_at=NULL,updated_at=? WHERE campaign_id=? AND lease_owner=?
          AND lease_token=? AND lease_generation=?`).run(
          disposition, known ? campaignCost : 0, known ? qualificationCost : 0,
          known ? 1 : 0, failures, nextAt.toISOString(), boundedOutcome(outcome),
          error ? String(error).slice(0, 1000) : null, terminalReason,
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
    finishDispatchFailureFallback({
      lease,
      outcome,
      nextDispatchAt,
      error = null,
      now = new Date(),
    } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      const nextAt = timestamp(nextDispatchAt || observedAt);
      try {
        begin();
        const current = fencedRow(identity, observedAt);
        externalActionSupport.recoverActiveAttemptInTransaction({
          current,
          observedAt,
          blocker: 'autonomous_research_supervisor_dispatch_failure_finalization_fallback',
        });
        const failures = current.consecutiveFailures + 1;
        const disposition = 'blocked';
        const terminalReason = 'supervisor_lifecycle_cost_unknown';
        const result = database.prepare(`UPDATE autonomous_research_supervisor_campaign SET
          disposition=?,cost_known=0,consecutive_failures=?,next_dispatch_at=?,last_outcome_json=?,
          last_error=?,terminal_reason=?,lease_owner=NULL,lease_token=NULL,
          lease_expires_at=NULL,updated_at=? WHERE campaign_id=? AND lease_owner=?
          AND lease_token=? AND lease_generation=?`).run(
          disposition,
          failures,
          nextAt.toISOString(),
          boundedOutcome(outcome),
          error ? String(error).slice(0, 1000) : null,
          terminalReason,
          observedAt.toISOString(),
          identity.campaignId,
          identity.ownerId,
          identity.leaseToken,
          identity.leaseGeneration,
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
    releaseCampaignLease({ lease, now = new Date() } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observed = timestamp(now);
      try {
        begin();
        const current = fencedRow(identity, observed);
        if (current.activeExternalActionAttempt) {
          throw new Error('autonomous_research_supervisor_external_action_in_progress');
        }
        const result = database.prepare(`UPDATE autonomous_research_supervisor_campaign SET
          lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
          WHERE campaign_id=? AND lease_owner=? AND lease_token=? AND lease_generation=?`).run(
          observed.toISOString(), identity.campaignId, identity.ownerId,
          identity.leaseToken, identity.leaseGeneration,
        );
        database.exec('COMMIT;');
        return Number(result.changes) === 1;
      } catch (caught) {
        rollback();
        throw caught;
      }
    },
    close() {
      if (!closed) database.close();
      closed = true;
    },
  });
}
