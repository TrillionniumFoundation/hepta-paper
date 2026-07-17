import {
  buildAutonomousResearchProviderCanaryAttemptJournal,
  verifyAutonomousResearchProviderCanaryAttemptJournal,
  verifyAutonomousResearchProviderCanarySideEffectInspection,
} from '../../paper-domain/automation/autonomous-research-provider-canary-side-effect-inspection.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export function observedDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('autonomous_research_topic_producer_clock_invalid');
  }
  return date;
}

export function begin(database) {
  database.exec('BEGIN IMMEDIATE;');
}

export function rollback(database) {
  if (database.isTransaction) {
    try { database.exec('ROLLBACK;'); } catch { /* retain the original failure */ }
  }
}

export function leaseIdentity({ ownerId, leaseToken, leaseGeneration } = {}) {
  if (![ownerId, leaseToken].every((value) => SAFE_ID.test(String(value || '')))
    || !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) {
    throw new Error('autonomous_research_topic_producer_lease_identity_invalid');
  }
  return Object.freeze({ ownerId, leaseToken, leaseGeneration });
}

export function leaseDuration(value) {
  if (!Number.isSafeInteger(value) || value < 1000 || value > 30 * 60 * 1000) {
    throw new Error('autonomous_research_topic_producer_lease_duration_invalid');
  }
  return value;
}

export function utcDayStart(date) {
  return new Date(Math.floor(date.getTime() / DAY_MS) * DAY_MS).toISOString();
}

export function parseGeneration(row, {
  providerCanaryPairMaximumCostUsd = null,
  providerConfigurationHash = null,
} = {}) {
  if (!row) return null;
  let planned;
  try { planned = JSON.parse(row.planned_generation_json); }
  catch { throw new Error('autonomous_research_topic_producer_state_invalid'); }
  if (!SHA256.test(String(planned?.plannedGenerationHash || ''))
    || planned.plannedGenerationHash !== row.planned_generation_hash
    || planned.generationSequence !== Number(row.generation_sequence)
    || planned.producerTopicId !== row.producer_topic_id
    || planned.topicFingerprint !== row.topic_fingerprint
    || planned.canonicalResearchTopicHash !== row.canonical_research_topic_hash
    || planned.budgetReservationId !== row.budget_reservation_id
    || planned.budgetEpochStart !== row.budget_epoch_start
    || !['planned', 'authorized', 'produced', 'failed'].includes(row.status)) {
    throw new Error('autonomous_research_topic_producer_state_invalid');
  }
  let capability = null;
  if (row.capability_json) {
    try { capability = JSON.parse(row.capability_json); }
    catch { throw new Error('autonomous_research_topic_producer_state_invalid'); }
    if (capability.autonomousResearchTopicProducerCapabilityReceiptHash
        !== row.capability_hash
      || capability.capabilityNonce !== row.capability_nonce) {
      throw new Error('autonomous_research_topic_producer_state_invalid');
    }
  }
  const reservation = Object.freeze({
    generationSequence: planned.generationSequence,
    plannedGenerationHash: planned.plannedGenerationHash,
    budgetReservationId: planned.budgetReservationId,
    budgetEpochStart: planned.budgetEpochStart,
    providerCanaryReservedAttemptCount: 1,
    providerCanaryReservedCostUsd: providerCanaryPairMaximumCostUsd,
  });
  const providerCanaryAttemptStarted = Number(row.provider_canary_attempt_started);
  if (![0, 1].includes(providerCanaryAttemptStarted)) {
    throw new Error('autonomous_research_topic_producer_state_invalid');
  }
  let providerCanaryAttemptJournal = null;
  if (row.provider_canary_attempt_journal_json) {
    try {
      providerCanaryAttemptJournal = JSON.parse(row.provider_canary_attempt_journal_json);
    } catch { throw new Error('autonomous_research_topic_producer_state_invalid'); }
    const journalReservation = Object.freeze({
      ...reservation,
      providerCanaryReservedCostUsd: providerCanaryPairMaximumCostUsd
        ?? providerCanaryAttemptJournal?.reservation?.providerCanaryReservedCostUsd,
    });
    if (providerCanaryAttemptStarted !== 1
      || !verifyAutonomousResearchProviderCanaryAttemptJournal(
        providerCanaryAttemptJournal,
        { providerConfigurationHash, reservation: journalReservation },
      )) throw new Error('autonomous_research_topic_producer_state_invalid');
  }
  if (providerCanaryAttemptStarted === 1
    && ['planned', 'authorized'].includes(row.status)
    && !providerCanaryAttemptJournal) {
    throw new Error('autonomous_research_topic_producer_state_invalid');
  }
  let providerCanarySideEffectInspection = null;
  if (row.provider_canary_side_effect_inspection_json) {
    try {
      providerCanarySideEffectInspection = JSON.parse(
        row.provider_canary_side_effect_inspection_json,
      );
    } catch { throw new Error('autonomous_research_topic_producer_state_invalid'); }
    const inspectionReservation = Object.freeze({
      ...reservation,
      providerCanaryReservedCostUsd: providerCanaryPairMaximumCostUsd
        ?? providerCanarySideEffectInspection?.reservation?.providerCanaryReservedCostUsd,
    });
    const journalActionsBound = !providerCanaryAttemptJournal
      || providerCanaryAttemptJournal.actions.every((action, index) =>
        JSON.stringify(action) === JSON.stringify(
          providerCanarySideEffectInspection.actions[index],
        ));
    if (row.status !== 'failed'
      || !verifyAutonomousResearchProviderCanarySideEffectInspection(
        providerCanarySideEffectInspection,
        { providerConfigurationHash, reservation: inspectionReservation },
      )
      || row.error !== providerCanarySideEffectInspection.failureCode
      || !journalActionsBound) throw new Error('autonomous_research_topic_producer_state_invalid');
  }
  if (providerCanaryAttemptStarted === 1 && row.status === 'failed'
    && !providerCanarySideEffectInspection) {
    throw new Error('autonomous_research_topic_producer_state_invalid');
  }
  return Object.freeze({
    generationSequence: Number(row.generation_sequence),
    status: row.status,
    leaseGeneration: Number(row.lease_generation),
    plannedGeneration: Object.freeze(planned),
    capability: capability ? Object.freeze(capability) : null,
    intakeId: row.intake_id || null,
    intakeHash: row.intake_hash || null,
    admissionHash: row.admission_hash || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error || null,
    providerCanaryAttemptStarted: providerCanaryAttemptStarted === 1,
    providerCanaryAttemptJournal: providerCanaryAttemptJournal
      ? Object.freeze(providerCanaryAttemptJournal) : null,
    providerCanarySideEffectInspection: providerCanarySideEffectInspection
      ? Object.freeze(providerCanarySideEffectInspection) : null,
  });
}

export function topicProducerFailureInspectionSchemaCurrent(database) {
  const columns = new Set(database.prepare(
    'PRAGMA table_info(autonomous_research_topic_producer_generation)',
  ).all().map((column) => column.name));
  return [
    'provider_canary_attempt_started',
    'provider_canary_attempt_journal_json',
    'provider_canary_side_effect_inspection_json',
  ].every((column) => columns.has(column));
}

function migrationCanaryReservation(plannedGeneration, providerCanaryPairMaximumCostUsd) {
  return Object.freeze({
    generationSequence: plannedGeneration.generationSequence,
    plannedGenerationHash: plannedGeneration.plannedGenerationHash,
    budgetReservationId: plannedGeneration.budgetReservationId,
    budgetEpochStart: plannedGeneration.budgetEpochStart,
    providerCanaryReservedAttemptCount: 1,
    providerCanaryReservedCostUsd: providerCanaryPairMaximumCostUsd,
  });
}

function markLegacyOutstandingProviderCanaries(database, {
  providerConfigurationHash,
  providerCanaryPairMaximumCostUsd,
} = {}) {
  // Terminal produced/failed rows are never replay candidates and retain their
  // legacy capability or pre-journal failure evidence. Outstanding rows remain
  // recoverable long enough for the application to find an already-committed
  // authorized intake, but this marker blocks every new canary transition.
  const rows = database.prepare(`SELECT * FROM
    autonomous_research_topic_producer_generation
    WHERE status IN ('planned','authorized') ORDER BY generation_sequence`).all();
  for (const row of rows) {
    if (!row.provider_canary_attempt_journal_json) {
      const generation = parseGeneration({
        ...row,
        provider_canary_attempt_started: 0,
      }, {
        providerCanaryPairMaximumCostUsd,
        providerConfigurationHash,
      });
      const journal = buildAutonomousResearchProviderCanaryAttemptJournal({
        providerConfigurationHash,
        reservation: migrationCanaryReservation(
          generation.plannedGeneration,
          providerCanaryPairMaximumCostUsd,
        ),
        actions: [],
        currentRole: null,
        failurePhase: 'provider_canary_reserved',
      });
      database.prepare(`UPDATE autonomous_research_topic_producer_generation SET
        provider_canary_attempt_started=1,provider_canary_attempt_journal_json=?
        WHERE generation_sequence=? AND status IN ('planned','authorized')`).run(
        JSON.stringify(journal),
        generation.generationSequence,
      );
    } else {
      database.prepare(`UPDATE autonomous_research_topic_producer_generation SET
        provider_canary_attempt_started=1 WHERE generation_sequence=?
        AND status IN ('planned','authorized')`).run(row.generation_sequence);
    }
    parseGeneration(database.prepare(`SELECT * FROM
      autonomous_research_topic_producer_generation WHERE generation_sequence=?`).get(
      row.generation_sequence,
    ), {
      providerCanaryPairMaximumCostUsd,
      providerConfigurationHash,
    });
  }
}

export function createTopicProducerSchema(database, {
  machineIntakeConfigurationHash = null,
  producerProfileHash = null,
  providerConfigurationHash = null,
  implementationSha256 = null,
  providerCanaryPairMaximumCostUsd = null,
} = {}) {
  try {
    begin(database);
    const generationTableExists = Boolean(database.prepare(`SELECT 1 AS present FROM sqlite_master
      WHERE type='table' AND name='autonomous_research_topic_producer_generation'`).get());
    if (generationTableExists) {
      const metadata = database.prepare(`SELECT * FROM
        autonomous_research_topic_producer_metadata WHERE singleton=1`).get();
      if (!metadata
        || metadata.machine_intake_configuration_hash !== machineIntakeConfigurationHash
        || metadata.producer_profile_hash !== producerProfileHash
        || metadata.provider_configuration_hash !== providerConfigurationHash
        || metadata.implementation_sha256 !== implementationSha256) {
        throw new Error('autonomous_research_topic_producer_authority_mismatch');
      }
    }
    const legacyFailureInspectionSchema = generationTableExists
      && !topicProducerFailureInspectionSchemaCurrent(database);
    database.exec(`CREATE TABLE IF NOT EXISTS autonomous_research_topic_producer_metadata (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    machine_intake_configuration_hash TEXT NOT NULL,
    producer_profile_hash TEXT NOT NULL,
    provider_configuration_hash TEXT NOT NULL,
    implementation_sha256 TEXT NOT NULL,
    lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation>=0),
    generation_high_watermark INTEGER NOT NULL DEFAULT 0 CHECK(generation_high_watermark>=0),
    last_observed_at TEXT,
    last_produced_at TEXT,
    next_attempt_at TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS autonomous_research_topic_producer_lease (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    owner_id TEXT NOT NULL, lease_token TEXT NOT NULL,
    lease_generation INTEGER NOT NULL CHECK(lease_generation>=1),
    acquired_at TEXT NOT NULL, renewed_at TEXT NOT NULL, expires_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS autonomous_research_topic_producer_generation (
    generation_sequence INTEGER PRIMARY KEY CHECK(generation_sequence>=1),
    status TEXT NOT NULL CHECK(status IN ('planned','authorized','produced','failed')),
    lease_generation INTEGER NOT NULL CHECK(lease_generation>=1),
    producer_topic_id TEXT NOT NULL UNIQUE,
    topic_fingerprint TEXT NOT NULL UNIQUE,
    canonical_research_topic_hash TEXT NOT NULL,
    budget_reservation_id TEXT NOT NULL UNIQUE,
    budget_epoch_start TEXT NOT NULL,
    planned_generation_hash TEXT NOT NULL UNIQUE,
    planned_generation_json TEXT NOT NULL,
    capability_hash TEXT UNIQUE, capability_nonce TEXT UNIQUE, capability_json TEXT,
    intake_id TEXT UNIQUE, intake_hash TEXT UNIQUE, admission_hash TEXT UNIQUE,
    error TEXT,
    provider_canary_attempt_started INTEGER NOT NULL DEFAULT 0
      CHECK(provider_canary_attempt_started IN (0,1)),
    provider_canary_attempt_journal_json TEXT,
    provider_canary_side_effect_inspection_json TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS autonomous_research_topic_producer_daily_budget (
    epoch_start TEXT PRIMARY KEY,
    provider_canary_attempt_count INTEGER NOT NULL CHECK(provider_canary_attempt_count>=0),
    provider_canary_reserved_cost_usd REAL NOT NULL CHECK(provider_canary_reserved_cost_usd>=0),
    produced_topic_count INTEGER NOT NULL CHECK(produced_topic_count>=0),
    updated_at TEXT NOT NULL
  ) STRICT;`);
  const columns = new Set(database.prepare(
    'PRAGMA table_info(autonomous_research_topic_producer_generation)',
  ).all().map((column) => column.name));
  if (!columns.has('provider_canary_side_effect_inspection_json')) {
    database.exec(`ALTER TABLE autonomous_research_topic_producer_generation
      ADD COLUMN provider_canary_side_effect_inspection_json TEXT;`);
  }
  if (!columns.has('provider_canary_attempt_started')) {
    database.exec(`ALTER TABLE autonomous_research_topic_producer_generation
      ADD COLUMN provider_canary_attempt_started INTEGER NOT NULL DEFAULT 0
      CHECK(provider_canary_attempt_started IN (0,1));`);
  }
  if (!columns.has('provider_canary_attempt_journal_json')) {
    database.exec(`ALTER TABLE autonomous_research_topic_producer_generation
      ADD COLUMN provider_canary_attempt_journal_json TEXT;`);
  }
  database.exec(`UPDATE autonomous_research_topic_producer_generation
    SET provider_canary_attempt_started=1
    WHERE provider_canary_attempt_started=0 AND (
      provider_canary_side_effect_inspection_json IS NOT NULL
      OR provider_canary_attempt_journal_json IS NOT NULL
    );`);
    if (legacyFailureInspectionSchema) {
      markLegacyOutstandingProviderCanaries(database, {
        providerConfigurationHash,
        providerCanaryPairMaximumCostUsd,
      });
    }
    database.exec('COMMIT;');
  } catch (error) {
    rollback(database);
    throw error;
  }
}
