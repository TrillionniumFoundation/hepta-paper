import fs from 'node:fs';

import {
  installAutonomousResearchSupervisorExternalActionJournalSchema,
} from './autonomous-research-supervisor-external-action-repository-support.mjs';

export function provisionAutonomousResearchSupervisorStateDatabase({
  database,
  databasePath,
} = {}) {
  database.exec('PRAGMA journal_mode=DELETE;');
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
    active_dispatch_phase TEXT CHECK(active_dispatch_phase IN (
      'reserved','started','recovery_pending','resumable'
    )),
    active_dispatch_count INTEGER CHECK(active_dispatch_count >= 1),
    active_dispatch_lease_generation INTEGER CHECK(active_dispatch_lease_generation >= 1),
    active_dispatch_reservation_hash TEXT,
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
  const columns = new Set(database.prepare(
    'PRAGMA table_info(autonomous_research_supervisor_campaign)',
  ).all().map((column) => column.name));
  if (!columns.has('last_provider_canary_receipt_hash')) {
    database.exec(`ALTER TABLE autonomous_research_supervisor_campaign
      ADD COLUMN last_provider_canary_receipt_hash TEXT;`);
  }
  if (!columns.has('active_dispatch_phase')) {
    database.exec(`ALTER TABLE autonomous_research_supervisor_campaign
      ADD COLUMN active_dispatch_phase TEXT;`);
  }
  if (!columns.has('active_dispatch_count')) {
    database.exec(`ALTER TABLE autonomous_research_supervisor_campaign
      ADD COLUMN active_dispatch_count INTEGER;`);
  }
  if (!columns.has('active_dispatch_lease_generation')) {
    database.exec(`ALTER TABLE autonomous_research_supervisor_campaign
      ADD COLUMN active_dispatch_lease_generation INTEGER;`);
  }
  if (!columns.has('active_dispatch_reservation_hash')) {
    database.exec(`ALTER TABLE autonomous_research_supervisor_campaign
      ADD COLUMN active_dispatch_reservation_hash TEXT;`);
  }
  installAutonomousResearchSupervisorExternalActionJournalSchema(database);
  fs.chmodSync(databasePath, 0o600);
}
