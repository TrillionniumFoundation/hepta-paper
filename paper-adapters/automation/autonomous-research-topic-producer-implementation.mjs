import {
  buildAutonomousResearchTopicProducerPlannedGeneration,
} from '../../paper-domain/automation/autonomous-research-topic-producer-contract.mjs';

/**
 * The production producer is deliberately a registered replication scheduler, not a novelty
 * oracle. Its byte identity is pinned by the producer profile and checked before every mutation.
 */
export function buildRegisteredAutonomousResearchTopicGeneration(input = {}) {
  return buildAutonomousResearchTopicProducerPlannedGeneration(input);
}
