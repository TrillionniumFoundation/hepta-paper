import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  createAutonomousResearchTopicProducerRepository,
  dropTopicProducerCanaryJournalColumns,
  inspectAutonomousResearchTopicProducerStatus,
  reopenProducerRepository,
  setup,
} from './support/autonomous-research-topic-producer-fixture.mjs';

test('legacy schema upgrade and ambiguity-journal backfill roll back atomically', (t) => {
  const fixture = setup(t);
  const lease = fixture.producerRepository.tryAcquireLease({
    ownerId: 'producer:legacy-atomic-migration', leaseMs: 1000, now: fixture.clock.now(),
  });
  fixture.producerRepository.prepareGeneration({ lease, now: fixture.clock.now() });
  const databasePath = fixture.producerRepository.databasePath;
  fixture.machineIntakeRepository.close();
  fixture.producerRepository.close();
  dropTopicProducerCanaryJournalColumns(databasePath);
  const corrupt = new DatabaseSync(databasePath);
  corrupt.prepare(`UPDATE autonomous_research_topic_producer_generation
    SET planned_generation_json='{}' WHERE generation_sequence=1`).run();
  corrupt.close();

  assert.throws(() => reopenProducerRepository(fixture), /topic_producer_state_invalid/);
  const afterFailure = new DatabaseSync(databasePath, { readOnly: true });
  const columns = new Set(afterFailure.prepare(
    'PRAGMA table_info(autonomous_research_topic_producer_generation)',
  ).all().map((column) => column.name));
  assert.equal(columns.has('provider_canary_attempt_started'), false);
  assert.equal(columns.has('provider_canary_attempt_journal_json'), false);
  assert.equal(columns.has('provider_canary_side_effect_inspection_json'), false);
  afterFailure.close();
});

test('read-only startup rejects the legacy schema without mutating it before writable migration',
  (t) => {
    const fixture = setup(t);
    const lease = fixture.producerRepository.tryAcquireLease({
      ownerId: 'producer:legacy-pre-provider-failure',
      leaseMs: 1000,
      now: fixture.clock.now(),
    });
    const plan = fixture.producerRepository.prepareGeneration({
      lease,
      now: fixture.clock.now(),
    });
    const failed = fixture.producerRepository.failGeneration({
      lease,
      generationSequence: plan.generationSequence,
      error: new Error('legacy_pre_provider_failure'),
      retryAfterMs: 15 * 60 * 1000,
      now: fixture.clock.now(),
    });
    assert.equal(failed.providerCanaryAttemptStarted, false);
    assert.equal(failed.providerCanarySideEffectInspection, null);
    fixture.producerRepository.releaseLease({ lease });
    const databasePath = fixture.producerRepository.databasePath;
    fixture.producerRepository.close();
    dropTopicProducerCanaryJournalColumns(databasePath);
    const legacyBytes = fs.readFileSync(databasePath);
    const legacyMtimeMs = fs.statSync(databasePath).mtimeMs;
    const open = (create) => createAutonomousResearchTopicProducerRepository({
      runtimeRoot: fixture.runtimeRoot,
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      producerProfile: fixture.profile,
      providerCanaryPairMaximumCostUsd: 1,
      liveMutationAuthority: fixture.liveMutationAuthority,
      create,
    });
    assert.equal(inspectAutonomousResearchTopicProducerStatus({
      runtimeRoot: fixture.runtimeRoot,
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      producerProfile: fixture.profile,
      implementationSha256: fixture.profile.implementationSha256,
      now: fixture.clock.now(),
    }).blocker, 'autonomous_research_topic_producer_schema_upgrade_required');
    assert.throws(() => open(false), /topic_producer_schema_upgrade_required/);
    assert.deepEqual(fs.readFileSync(databasePath), legacyBytes);
    assert.equal(fs.statSync(databasePath).mtimeMs, legacyMtimeMs);
    const stillLegacy = new DatabaseSync(databasePath, { readOnly: true });
    const legacyColumns = new Set(stillLegacy.prepare(
      'PRAGMA table_info(autonomous_research_topic_producer_generation)',
    ).all().map((column) => column.name));
    assert.equal(legacyColumns.has('provider_canary_attempt_started'), false);
    assert.equal(legacyColumns.has('provider_canary_attempt_journal_json'), false);
    assert.equal(legacyColumns.has('provider_canary_side_effect_inspection_json'), false);
    stillLegacy.close();
    const migrated = open(true);
    const preserved = migrated.readGeneration(plan.generationSequence);
    assert.equal(preserved.status, 'failed');
    assert.equal(preserved.error, 'legacy_pre_provider_failure');
    assert.equal(preserved.providerCanaryAttemptStarted, false);
    assert.equal(preserved.providerCanaryAttemptJournal, null);
    assert.equal(preserved.providerCanarySideEffectInspection, null);
    migrated.close();
    const current = new DatabaseSync(databasePath, { readOnly: true });
    const currentColumns = new Set(current.prepare(
      'PRAGMA table_info(autonomous_research_topic_producer_generation)',
    ).all().map((column) => column.name));
    assert.equal(currentColumns.has('provider_canary_attempt_started'), true);
    assert.equal(currentColumns.has('provider_canary_attempt_journal_json'), true);
    assert.equal(currentColumns.has('provider_canary_side_effect_inspection_json'), true);
    current.close();
  });
