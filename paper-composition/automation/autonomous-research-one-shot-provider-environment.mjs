import path from 'node:path';

import {
  AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS,
} from '../../paper-domain/automation/autonomous-research-one-shot-campaign-execution-binding.mjs';

const PREPARE_BOOKKEEPING_ACTIONS = new Set([
  'campaign_readiness_composition',
  'campaign_readiness_composition_preflight',
]);

export function fixedAutonomousResearchOneShotProviderEnvironment({
  runtimeRoot,
  environment = {},
} = {}) {
  if (!runtimeRoot) {
    throw new Error('autonomous_research_one_shot_runtime_root_required');
  }
  const managedProviderRoot = path.join(
    path.dirname(path.resolve(runtimeRoot)),
    'openclaw-managed-codex',
  );
  const codexBinary = path.join(
    path.resolve(runtimeRoot),
    'local-run',
    'bin',
    'codex-openclaw-managed',
  );
  return Object.freeze({
    ...environment,
    HEPTA_RESEARCH_AUTHOR_PROVIDER: 'codex',
    HEPTA_RESEARCH_AUTHOR_CODEX_BINARY: codexBinary,
    HEPTA_RESEARCH_AUTHOR_CODEX_HOME: path.join(managedProviderRoot, 'research-author'),
    HEPTA_RESEARCH_AUTHOR_MODEL: 'gpt-5.6-sol',
    HEPTA_FORMAL_REVIEW_PROVIDER: 'codex',
    HEPTA_FORMAL_REVIEW_CODEX_BINARY: codexBinary,
    HEPTA_FORMAL_REVIEW_CODEX_HOME: path.join(managedProviderRoot, 'formal-reviewer'),
    HEPTA_FORMAL_REVIEW_MODEL: 'gpt-5.6-sol',
  });
}

export function fixedAutonomousResearchOneShotPrepareEnvironment({
  runtimeRoot,
} = {}) {
  const environment = {
    ...fixedAutonomousResearchOneShotProviderEnvironment({
      runtimeRoot,
      environment: {},
    }),
    HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE: 'deterministic-bounded',
  };
  if (AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS
    .some((key) => Object.hasOwn(environment, key))) {
    throw new Error('autonomous_research_one_shot_prepare_environment_invalid');
  }
  return Object.freeze(environment);
}

export function createAutonomousResearchOneShotPrepareSideEffectGuard() {
  const guard = ({ action } = {}) => {
    if (!PREPARE_BOOKKEEPING_ACTIONS.has(action)) {
      throw new Error('autonomous_research_one_shot_prepare_external_action_forbidden');
    }
  };
  guard.markStarted = guard;
  guard.assertCurrent = guard;
  return Object.freeze(guard);
}
