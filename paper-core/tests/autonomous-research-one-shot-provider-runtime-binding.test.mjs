import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS,
  AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
  autonomousResearchOneShotProviderRuntimeBindingHash,
} from '../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs';
import {
  verifyAutonomousResearchOneShotProviderRuntimeBinding,
} from '../../paper-domain/automation/autonomous-research-one-shot-provider-runtime-binding.mjs';
import {
  createAutonomousResearchOneShotPrepareSideEffectGuard,
  fixedAutonomousResearchOneShotPrepareEnvironment,
  fixedAutonomousResearchOneShotProviderEnvironment,
  inspectAutonomousResearchOneShotProviderRuntimeBinding,
} from '../../paper-composition/automation/autonomous-research-one-shot-campaign-attempt-composition.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from '../../paper-composition/automation/autonomous-research-provider-configuration.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  gatewayProviderRuntimeBinding,
  legacyProviderRuntimeBinding,
  providerRuntimeBinding,
} from './support/autonomous-research-one-shot-campaign-attempt-fixture.mjs';

function H(label) {
  return hashRecord('AutonomousResearchOneShotCampaignAttemptTestHash', { label });
}

test('one-shot prepare environment is isolated from hostile provider ambient state', () => {
  const runtimeRoot = '/data/home-data/hepta-paper-runtime/native-runtime';
  const forbiddenEnvironment = Object.fromEntries(
    AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS
      .map((key) => [key, `/private/hostile/${key}.json`]),
  );
  const environment = fixedAutonomousResearchOneShotProviderEnvironment({
    runtimeRoot,
    environment: {
      HEPTA_RESEARCH_AUTHOR_MODEL: 'arbitrary-model',
      HEPTA_FORMAL_REVIEW_CODEX_HOME: '/tmp/arbitrary-home',
      HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE: 'agent-evidence-bound',
      ...forbiddenEnvironment,
      PRESERVED_UNRELATED_VALUE: 'preserved',
    },
  });
  const prepareEnvironment = fixedAutonomousResearchOneShotPrepareEnvironment({
    runtimeRoot,
  });
  const configuration = resolveAutonomousResearchProviderConfiguration({ environment });
  assert.equal(configuration.autonomousResearchProviderConfigurationHash,
    AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH);
  assert.equal(configuration.researchAuthor.model, 'gpt-5.6-sol');
  assert.equal(configuration.formalReviewer.codexHome,
    '/data/home-data/hepta-paper-runtime/openclaw-managed-codex/formal-reviewer');
  assert.equal(environment.PRESERVED_UNRELATED_VALUE, 'preserved');
  assert.equal(environment.HEPTA_PRIOR_ART_SERVICE_CONFIG,
    forbiddenEnvironment.HEPTA_PRIOR_ART_SERVICE_CONFIG);
  assert.equal(prepareEnvironment.HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE,
    'deterministic-bounded');
  assert.equal(prepareEnvironment.PRESERVED_UNRELATED_VALUE, undefined);
  for (const key of AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS) {
    assert.equal(Object.hasOwn(prepareEnvironment, key), false);
  }
  assert.equal(Object.isFrozen(prepareEnvironment), true);
  const prepareSideEffectGuard =
    createAutonomousResearchOneShotPrepareSideEffectGuard();
  for (const action of [
    'campaign_readiness_composition',
    'campaign_readiness_composition_preflight',
  ]) {
    prepareSideEffectGuard({ action });
    prepareSideEffectGuard.assertCurrent({ action });
    prepareSideEffectGuard.markStarted({ action });
  }
  for (const action of ['bounded_prior_art_retrieval', 'provider_live_canary']) {
    for (const guard of [
      prepareSideEffectGuard,
      prepareSideEffectGuard.assertCurrent,
      prepareSideEffectGuard.markStarted,
    ]) {
      assert.throws(() => guard({ action }),
        /autonomous_research_one_shot_prepare_external_action_forbidden/);
    }
  }
});

test('provider runtime binding v2 captures the profile auth union and config identities', () => {
  const providerConfiguration = {
    autonomousResearchProviderConfigurationHash:
      AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
    researchAuthor: { provider: 'codex', codexHome: '/author' },
    formalReviewer: { provider: 'codex', codexHome: '/reviewer' },
  };
  const binding = inspectAutonomousResearchOneShotProviderRuntimeBinding({
    providerConfiguration,
    environment: {},
    preflightAuthor: () => ({
      codexHome: '/author',
      capabilityReceipt: {
        codexResearchAuthorCapabilityReceiptHash: H('author-capability'),
        credentialConfigIdentityHash: H('author-config'),
        openClawManagedAuthProfileIdentityHash: H('author-profile'),
        openClawManagedAuthBindingMode: 'user-locked-profile',
        openClawManagedGatewayRouteIdentityHash: null,
        openClawManagedRuntimeProvenanceHash: H('runtime'),
        openClawManagedAuthSourceIdentityHash: H('auth-source'),
      },
    }),
    preflightReviewer: () => ({
      capabilityReceipt: {
        codexFormalReviewerCapabilityReceiptHash: H('reviewer-capability'),
        credentialConfigIdentityHash: H('reviewer-config'),
        openClawManagedAuthProfileIdentityHash: H('reviewer-profile'),
        openClawManagedAuthBindingMode: 'user-locked-profile',
        openClawManagedGatewayRouteIdentityHash: null,
        openClawManagedRuntimeProvenanceHash: H('runtime'),
        openClawManagedAuthSourceIdentityHash: H('auth-source'),
      },
    }),
  });
  assert.equal(binding.version, 2);
  assert.equal(binding.openClawManagedAuthBindingMode, 'user-locked-profile');
  assert.equal(binding.openClawManagedGatewayRouteIdentityHash, null);
  assert.equal(
    binding.researchAuthorOpenClawManagedAuthProfileIdentityHash,
    H('author-profile'),
  );
  assert.equal(
    binding.formalReviewerOpenClawManagedAuthProfileIdentityHash,
    H('reviewer-profile'),
  );
  assert.equal(binding.researchAuthorCredentialConfigIdentityHash, H('author-config'));
  assert.equal(binding.formalReviewerCredentialConfigIdentityHash, H('reviewer-config'));
  assert.equal(verifyAutonomousResearchOneShotProviderRuntimeBinding(binding), true);
  assert.notEqual(
    autonomousResearchOneShotProviderRuntimeBindingHash(binding),
    autonomousResearchOneShotProviderRuntimeBindingHash({
      ...binding,
      researchAuthorOpenClawManagedAuthProfileIdentityHash: H('other-profile'),
    }),
  );
});

test('provider runtime binding v2 captures one shared Gateway route without profiles', () => {
  const providerConfiguration = {
    autonomousResearchProviderConfigurationHash:
      AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
    researchAuthor: { provider: 'codex', codexHome: '/author' },
    formalReviewer: { provider: 'codex', codexHome: '/reviewer' },
  };
  const capabilityReceipt = (role) => ({
    [`codex${role === 'author' ? 'ResearchAuthor' : 'FormalReviewer'}CapabilityReceiptHash`]:
      H(`${role}-capability`),
    credentialConfigIdentityHash: H(`${role}-config`),
    openClawManagedAuthProfileIdentityHash: null,
    openClawManagedAuthBindingMode: 'current-agent-gateway-oauth-route',
    openClawManagedGatewayRouteIdentityHash: H('gateway-route'),
    openClawManagedRuntimeProvenanceHash: H('runtime'),
    openClawManagedAuthSourceIdentityHash: H('auth-source'),
  });
  const binding = inspectAutonomousResearchOneShotProviderRuntimeBinding({
    providerConfiguration,
    environment: {},
    preflightAuthor: () => ({
      codexHome: '/author',
      capabilityReceipt: capabilityReceipt('author'),
    }),
    preflightReviewer: () => ({
      capabilityReceipt: capabilityReceipt('reviewer'),
    }),
  });
  assert.equal(binding.version, 2);
  assert.equal(
    binding.openClawManagedAuthBindingMode,
    'current-agent-gateway-oauth-route',
  );
  assert.equal(binding.researchAuthorOpenClawManagedAuthProfileIdentityHash, null);
  assert.equal(binding.formalReviewerOpenClawManagedAuthProfileIdentityHash, null);
  assert.equal(binding.openClawManagedGatewayRouteIdentityHash, H('gateway-route'));
  assert.equal(verifyAutonomousResearchOneShotProviderRuntimeBinding(binding), true);

  assert.throws(
    () => inspectAutonomousResearchOneShotProviderRuntimeBinding({
      providerConfiguration,
      environment: {},
      preflightAuthor: () => ({
        codexHome: '/author',
        capabilityReceipt: capabilityReceipt('author'),
      }),
      preflightReviewer: () => ({
        capabilityReceipt: {
          ...capabilityReceipt('reviewer'),
          openClawManagedGatewayRouteIdentityHash: H('other-gateway-route'),
        },
      }),
    }),
    /autonomous_research_one_shot_provider_runtime_binding_invalid/,
  );
});

test('provider runtime binding verifier retains strict version 1 support', () => {
  const legacyBinding = legacyProviderRuntimeBinding();
  assert.equal(verifyAutonomousResearchOneShotProviderRuntimeBinding(legacyBinding), true);
  assert.equal(verifyAutonomousResearchOneShotProviderRuntimeBinding({
    ...legacyBinding,
    openClawManagedGatewayRouteIdentityHash: null,
  }), false);
  assert.equal(verifyAutonomousResearchOneShotProviderRuntimeBinding({
    ...providerRuntimeBinding(),
    researchAuthorOpenClawManagedAuthProfileIdentityHash: null,
  }), false);
  assert.equal(verifyAutonomousResearchOneShotProviderRuntimeBinding({
    ...gatewayProviderRuntimeBinding(),
    formalReviewerOpenClawManagedAuthProfileIdentityHash: H('reviewer-profile'),
  }), false);
});
