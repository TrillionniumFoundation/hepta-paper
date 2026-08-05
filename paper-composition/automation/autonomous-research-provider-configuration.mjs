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

function normalizedProvider(value, role, { localOnly = false } = {}) {
  const provider = configured(value, 'codex').toLowerCase();
  const selected = provider === 'auto' ? 'codex' : provider;
  if (selected !== 'codex' && !(localOnly === true && selected === 'ollama')) {
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

function principalConfiguration({ provider, codexBinary, codexHome, model }, role, {
  localOnly = false,
} = {}) {
  const selectedProvider = normalizedProvider(provider, role, { localOnly });
  const selectedModel = configured(model);
  if (selectedProvider === 'ollama' && !selectedModel) {
    throw new Error(`autonomous_research_${role}_ollama_model_required`);
  }
  return Object.freeze({
    provider: selectedProvider,
    codexBinary: selectedProvider === 'codex' ? normalizedBinary(codexBinary) : null,
    codexHome: selectedProvider === 'codex' ? normalizedHome(codexHome) : null,
    model: selectedModel,
  });
}

export function resolveAutonomousResearchProviderConfiguration({
  options = {},
  environment = {},
  localOnly = false,
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
    }, 'research_author', { localOnly }),
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
        options['codex-home'],
        environment.HEPTA_RESEARCH_AUTHOR_CODEX_HOME,
        environment.CODEX_HOME,
      ),
      model: configured(
        options['formal-review-model'],
        environment.HEPTA_FORMAL_REVIEW_MODEL,
      ),
    }, 'formal_reviewer', { localOnly }),
  };
  const providers = [payload.researchAuthor.provider, payload.formalReviewer.provider];
  if (providers.includes('ollama') && !providers.every((provider) => provider === 'ollama')) {
    throw new Error('autonomous_research_local_ollama_principals_must_use_same_provider');
  }
  return Object.freeze({
    ...payload,
    autonomousResearchProviderConfigurationHash:
      hashRecord('AutonomousResearchProviderConfiguration', payload),
  });
}

export function verifyAutonomousResearchProviderConfiguration(configuration, {
  allowLocalOnlyOllama = false,
} = {}) {
  if (!hasExactObjectKeys(configuration, CONFIGURATION_KEYS)
    || configuration.version !== 1
    || configuration.kind !== 'AutonomousResearchProviderConfiguration'
    || configuration.status !== 'autonomous_research_provider_configuration_resolved'
    || !hasExactObjectKeys(configuration.researchAuthor, PRINCIPAL_KEYS)
    || !hasExactObjectKeys(configuration.formalReviewer, PRINCIPAL_KEYS)) return false;
  let normalized;
  try {
    const localOllama = configuration.researchAuthor.provider === 'ollama'
      || configuration.formalReviewer.provider === 'ollama';
    if (localOllama && allowLocalOnlyOllama !== true) return false;
    normalized = resolveAutonomousResearchProviderConfiguration({
      localOnly: localOllama,
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
  { expectedHash = null, allowLocalOnlyOllama = false } = {},
) {
  if (!verifyAutonomousResearchProviderConfiguration(configuration, {
    allowLocalOnlyOllama,
  })) {
    throw new Error('autonomous_research_provider_configuration_invalid');
  }
  if (expectedHash
    && configuration.autonomousResearchProviderConfigurationHash !== expectedHash) {
    throw new Error('autonomous_research_provider_configuration_hash_mismatch');
  }
  return configuration;
}
