import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';

const CONFIGURATION_KEYS = Object.freeze([
  'version',
  'kind',
  'status',
  'researchAuthor',
  'formalReviewer',
  'autonomousResearchProviderConfigurationHash',
]);
const PRINCIPAL_KEYS = Object.freeze(['provider', 'codexBinary', 'codexHome', 'model']);

function configured(...values) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || null;
}

function normalizedProvider(value, role) {
  const provider = configured(value, 'codex').toLowerCase();
  const selected = provider === 'auto' ? 'codex' : provider;
  if (selected !== 'codex') {
    throw new Error(`autonomous_research_${role}_provider_unsupported:${selected}`);
  }
  return selected;
}

function normalizedBinary(value) {
  const candidate = configured(value, 'codex');
  return candidate.includes(path.sep) ? path.resolve(candidate) : candidate;
}

function normalizedHome(value) {
  const candidate = configured(value);
  return candidate ? path.resolve(candidate) : null;
}

function principalConfiguration({ provider, codexBinary, codexHome, model }, role) {
  return Object.freeze({
    provider: normalizedProvider(provider, role),
    codexBinary: normalizedBinary(codexBinary),
    codexHome: normalizedHome(codexHome),
    model: configured(model),
  });
}

export function resolveAutonomousResearchProviderConfiguration({
  options = {},
  environment = {},
} = {}) {
  const payload = {
    version: 1,
    kind: 'AutonomousResearchProviderConfiguration',
    status: 'autonomous_research_provider_configuration_resolved',
    researchAuthor: principalConfiguration({
      provider: configured(
        options['agent-provider'],
        environment.HEPTA_RESEARCH_AUTHOR_PROVIDER,
        'codex',
      ),
      codexBinary: configured(
        options['codex-binary'],
        environment.HEPTA_RESEARCH_AUTHOR_CODEX_BINARY,
        'codex',
      ),
      codexHome: configured(
        options['codex-home'],
        environment.HEPTA_RESEARCH_AUTHOR_CODEX_HOME,
        environment.CODEX_HOME,
      ),
      model: configured(options.model, environment.HEPTA_RESEARCH_AUTHOR_MODEL),
    }, 'research_author'),
    formalReviewer: principalConfiguration({
      provider: configured(
        options['formal-review-provider'],
        environment.HEPTA_FORMAL_REVIEW_PROVIDER,
        'codex',
      ),
      codexBinary: configured(
        options['formal-review-codex-binary'],
        environment.HEPTA_FORMAL_REVIEW_CODEX_BINARY,
        'codex',
      ),
      codexHome: configured(
        options['formal-review-codex-home'],
        environment.HEPTA_FORMAL_REVIEW_CODEX_HOME,
      ),
      model: configured(
        options['formal-review-model'],
        environment.HEPTA_FORMAL_REVIEW_MODEL,
      ),
    }, 'formal_reviewer'),
  };
  return Object.freeze({
    ...payload,
    autonomousResearchProviderConfigurationHash:
      hashRecord('AutonomousResearchProviderConfiguration', payload),
  });
}

export function verifyAutonomousResearchProviderConfiguration(configuration) {
  if (!hasExactObjectKeys(configuration, CONFIGURATION_KEYS)
    || configuration.version !== 1
    || configuration.kind !== 'AutonomousResearchProviderConfiguration'
    || configuration.status !== 'autonomous_research_provider_configuration_resolved'
    || !hasExactObjectKeys(configuration.researchAuthor, PRINCIPAL_KEYS)
    || !hasExactObjectKeys(configuration.formalReviewer, PRINCIPAL_KEYS)) return false;
  let normalized;
  try {
    normalized = resolveAutonomousResearchProviderConfiguration({
      options: {
        'agent-provider': configuration.researchAuthor.provider,
        'codex-binary': configuration.researchAuthor.codexBinary,
        'codex-home': configuration.researchAuthor.codexHome,
        model: configuration.researchAuthor.model,
        'formal-review-provider': configuration.formalReviewer.provider,
        'formal-review-codex-binary': configuration.formalReviewer.codexBinary,
        'formal-review-codex-home': configuration.formalReviewer.codexHome,
        'formal-review-model': configuration.formalReviewer.model,
      },
    });
  } catch { return false; }
  return hashRecord('AutonomousResearchProviderConfigurationExpected', configuration)
    === hashRecord('AutonomousResearchProviderConfigurationExpected', normalized);
}

export function requireAutonomousResearchProviderConfiguration(
  configuration,
  { expectedHash = null } = {},
) {
  if (!verifyAutonomousResearchProviderConfiguration(configuration)) {
    throw new Error('autonomous_research_provider_configuration_invalid');
  }
  if (expectedHash
    && configuration.autonomousResearchProviderConfigurationHash !== expectedHash) {
    throw new Error('autonomous_research_provider_configuration_hash_mismatch');
  }
  return configuration;
}
