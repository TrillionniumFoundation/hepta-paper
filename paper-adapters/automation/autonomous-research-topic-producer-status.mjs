import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  verifyAutonomousResearchTopicProducerCapabilityReceipt,
  verifyAutonomousResearchTopicProducerProfile,
} from '../../paper-domain/automation/autonomous-research-topic-producer-contract.mjs';
import {
  parseGeneration,
  topicProducerFailureInspectionSchemaCurrent,
} from './autonomous-research-topic-producer-repository-support.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVENESS_MAXIMUM_AGE_MS = 15 * 60 * 1000;

function empty(blocker) {
  return Object.freeze({
    ready: false,
    live: false,
    currentlyProducible: false,
    latestCapabilityFresh: false,
    blocker,
  });
}

export function inspectAutonomousResearchTopicProducerStatus({
  runtimeRoot,
  machineIntakeConfigurationHash,
  producerProfile,
  implementationSha256,
  now = new Date(),
} = {}) {
  if (!runtimeRoot || !verifyAutonomousResearchTopicProducerProfile(producerProfile)) {
    return empty('autonomous_research_topic_producer_status_dependencies_invalid');
  }
  const observedAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(observedAt.getTime())) {
    return empty('autonomous_research_topic_producer_clock_invalid');
  }
  const databasePath = path.join(
    path.resolve(runtimeRoot),
    'autonomous-research',
    'topic-producer',
    'topic-producer.sqlite',
  );
  let stat;
  try { stat = fs.lstatSync(databasePath); }
  catch { return empty('autonomous_research_topic_producer_state_missing'); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
    return empty('autonomous_research_topic_producer_state_invalid');
  }
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    if (!topicProducerFailureInspectionSchemaCurrent(database)) {
      return empty('autonomous_research_topic_producer_schema_upgrade_required');
    }
    const metadata = database.prepare(`SELECT * FROM autonomous_research_topic_producer_metadata
      WHERE singleton=1`).get();
    if (!metadata
      || metadata.machine_intake_configuration_hash !== machineIntakeConfigurationHash
      || metadata.producer_profile_hash !== producerProfile.producerProfileHash
      || metadata.provider_configuration_hash !== producerProfile.providerConfigurationHash
      || metadata.implementation_sha256 !== implementationSha256) {
      return empty('autonomous_research_topic_producer_authority_mismatch');
    }
    const maximum = Number(database.prepare(`SELECT COALESCE(MAX(generation_sequence),0) AS value
      FROM autonomous_research_topic_producer_generation`).get().value);
    if (maximum !== Number(metadata.generation_high_watermark)) {
      return empty('autonomous_research_topic_producer_high_watermark_invalid');
    }
    for (const generationRow of database.prepare(
      'SELECT * FROM autonomous_research_topic_producer_generation ORDER BY generation_sequence',
    ).all()) {
      parseGeneration(generationRow, {
        providerConfigurationHash: producerProfile.providerConfigurationHash,
      });
    }
    const lastObservedMs = Date.parse(String(metadata.last_observed_at || ''));
    const clockMonotonic = !metadata.last_observed_at
      || observedAt.getTime() >= lastObservedMs;
    const live = clockMonotonic && Number.isFinite(lastObservedMs)
      && observedAt.getTime() - lastObservedMs < LIVENESS_MAXIMUM_AGE_MS;
    const epochStart = new Date(
      Math.floor(observedAt.getTime() / DAY_MS) * DAY_MS,
    ).toISOString();
    const daily = database.prepare(`SELECT * FROM autonomous_research_topic_producer_daily_budget
      WHERE epoch_start=?`).get(epochStart);
    const canaryBudgetAvailable = Number(daily?.provider_canary_attempt_count || 0)
      < producerProfile.maximumProviderCanaryAttemptsPerUtcDay
      && Number(daily?.provider_canary_reserved_cost_usd || 0)
        < producerProfile.maximumProviderCanaryCostUsdPerUtcDay;
    const topicBudgetAvailable = Number(daily?.produced_topic_count || 0)
      < producerProfile.maximumTopicsPerUtcDay;
    const lastProducedMs = Date.parse(String(metadata.last_produced_at || ''));
    const rateEligible = !metadata.last_produced_at
      || observedAt.getTime() - lastProducedMs >= producerProfile.minimumGenerationIntervalMs;
    const retryEligible = !metadata.next_attempt_at
      || observedAt >= new Date(metadata.next_attempt_at);
    const last = database.prepare(`SELECT planned_generation_json,capability_json FROM
      autonomous_research_topic_producer_generation WHERE capability_json IS NOT NULL
      ORDER BY generation_sequence DESC LIMIT 1`).get();
    let latestCapabilityFresh = false;
    if (last) {
      const planned = JSON.parse(last.planned_generation_json);
      const capability = JSON.parse(last.capability_json);
      latestCapabilityFresh = verifyAutonomousResearchTopicProducerCapabilityReceipt(
        capability,
        {
          producerProfile,
          machineIntakeConfigurationHash,
          intake: planned.intake,
          now: observedAt,
          requireFresh: true,
        },
      );
    }
    return Object.freeze({
      ready: clockMonotonic && live,
      live,
      clockMonotonic,
      currentlyProducible: live && canaryBudgetAvailable && topicBudgetAvailable
        && rateEligible && retryEligible && latestCapabilityFresh,
      providerMutationRequiresNewLiveCanary: true,
      latestCapabilityFresh,
      canaryBudgetAvailable,
      topicBudgetAvailable,
      rateEligible,
      retryEligible,
      generationHighWatermark: maximum,
      lastObservedAt: metadata.last_observed_at || null,
      lastProducedAt: metadata.last_produced_at || null,
      nextAttemptAt: metadata.next_attempt_at || null,
      blocker: clockMonotonic && live ? null
        : clockMonotonic
          ? 'autonomous_research_topic_producer_not_live'
          : 'autonomous_research_topic_producer_clock_rollback_detected',
    });
  } catch (error) {
    return empty(String(error?.message || error));
  } finally { database?.close(); }
}
