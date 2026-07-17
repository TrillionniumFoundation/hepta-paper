import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  composeAutonomousResearchCampaignAction,
  requirePersistedAutonomousProviderConfiguration,
} from '../../paper-composition/automation/autonomous-research-campaign-composition.mjs';
import { composeAutonomousResearchReadiness } from '../../paper-composition/automation/autonomous-research-readiness-composition.mjs';
import { createAutonomousResearchQualificationContextProvider } from '../../paper-composition/automation/autonomous-research-qualification-context.mjs';
import {
  requireAutonomousResearchProviderConfiguration,
  resolveAutonomousResearchProviderConfiguration,
  verifyAutonomousResearchProviderConfiguration,
} from '../../paper-composition/automation/autonomous-research-provider-configuration.mjs';
import { composeCampaignWorkerExecution } from '../../paper-composition/automation/campaign-worker-composition.mjs';

const H = (label) => hashRecord('AutonomousProviderConfigurationBindingTest', { label });

function capabilityPreflights() {
  const authorPayload = {
    version: 1,
    kind: 'CodexResearchAuthorCapabilityReceipt',
    status: 'codex_research_author_capability_ready',
    provider: 'openai',
    model: 'author-capability-model',
    credentialRootIdentityHash: H('author-root'),
    credentialConfigIdentityHash: H('author-config'),
  };
  const authorCapability = Object.freeze({
    ...authorPayload,
    codexResearchAuthorCapabilityReceiptHash:
      hashRecord('CodexResearchAuthorCapabilityReceipt', authorPayload),
  });
  const reviewerPayload = {
    version: 1,
    kind: 'CodexFormalReviewerCapabilityReceipt',
    status: 'codex_formal_reviewer_capability_ready',
    provider: 'openai',
    model: 'reviewer-capability-model',
    credentialRootIdentityHash: H('reviewer-root'),
    credentialConfigIdentityHash: H('reviewer-config'),
    authorCredentialRootIdentityHash: authorCapability.credentialRootIdentityHash,
    credentialIndependenceVerified: true,
    assuranceScope: 'filesystem_credential_root_and_principal_separation',
  };
  const reviewerCapability = Object.freeze({
    ...reviewerPayload,
    codexFormalReviewerCapabilityReceiptHash:
      hashRecord('CodexFormalReviewerCapabilityReceipt', reviewerPayload),
  });
  return Object.freeze({
    author: Object.freeze({
      effectivePrincipalId: 'codex-research-author:provider-binding-fixture',
      codexHome: '/runtime/author-home',
      capabilityReceipt: authorCapability,
    }),
    reviewer: Object.freeze({
      effectivePrincipalId: 'codex-formal-reviewer:provider-binding-fixture',
      codexHome: '/runtime/reviewer-home',
      capabilityReceipt: reviewerCapability,
    }),
  });
}

function cliEquivalentOptions(root) {
  return {
    'agent-provider': 'codex',
    'codex-binary': path.join(root, 'cli-codex'),
    'codex-home': path.join(root, 'cli-author-home'),
    model: 'cli-author-model',
    'formal-review-provider': 'codex',
    'formal-review-codex-binary': path.join(root, 'cli-review-codex'),
    'formal-review-codex-home': path.join(root, 'cli-reviewer-home'),
    'formal-review-model': 'cli-reviewer-model',
  };
}

function conflictingEnvironment(root) {
  return {
    PATH: '/fixture/bin',
    HEPTA_RESEARCH_AUTHOR_PROVIDER: 'codex',
    HEPTA_RESEARCH_AUTHOR_CODEX_BINARY: path.join(root, 'env-codex'),
    HEPTA_RESEARCH_AUTHOR_CODEX_HOME: path.join(root, 'env-author-home'),
    HEPTA_RESEARCH_AUTHOR_MODEL: 'env-author-model',
    HEPTA_FORMAL_REVIEW_PROVIDER: 'codex',
    HEPTA_FORMAL_REVIEW_CODEX_BINARY: path.join(root, 'env-review-codex'),
    HEPTA_FORMAL_REVIEW_CODEX_HOME: path.join(root, 'env-reviewer-home'),
    HEPTA_FORMAL_REVIEW_MODEL: 'env-reviewer-model',
  };
}

function assertPrincipalInput(input, expected) {
  assert.equal(input.provider, 'codex');
  assert.equal(input.codexBinary, expected.codexBinary);
  assert.equal(input.codexHome, expected.codexHome);
  assert.equal(input.model, expected.model);
}

function runtimeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-provider-binding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, 'codex');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(binary, 0o700);
  const authorHome = path.join(root, 'author-home');
  const reviewerHome = path.join(root, 'reviewer-home');
  for (const home of [authorHome, reviewerHome]) {
    fs.mkdirSync(home, { mode: 0o700 });
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 });
  }
  return { root, binary, authorHome, reviewerHome };
}

function codexPreflightSpawn(executable, args) {
  if (executable === 'docker') return { status: 1, stdout: '', stderr: '' };
  if (args[0] === '--version') return { status: 0, signal: null, stdout: 'codex-cli 1.2.3\n', stderr: '' };
  if (args[0] === 'exec' && args[1] === '--help') {
    return { status: 0, signal: null, stdout: 'Usage: codex exec --model MODEL\n', stderr: '' };
  }
  if (args[0] === 'login' && args[1] === 'status') {
    return { status: 0, signal: null, stdout: 'Logged in\n', stderr: '' };
  }
  return { status: 1, signal: null, stdout: '', stderr: '' };
}

test('CLI-equivalent worker overrides take precedence and readiness persists only their configuration hash', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-provider-cli-readiness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = cliEquivalentOptions(root);
  const environment = conflictingEnvironment(root);
  const expected = resolveAutonomousResearchProviderConfiguration({ options, environment });
  const preflights = capabilityPreflights();
  const calls = {};
  const report = await composeAutonomousResearchCampaignAction({
    action: 'prepare',
    launchMode: 'golden-bootstrap',
    paperId: 'provider-cli-readiness',
    root: path.join(root, 'assets'),
    runtimeRoot: path.join(root, 'runtime'),
    environment,
    worker: {
      agentProvider: options['agent-provider'],
      codexBinary: options['codex-binary'],
      codexHome: options['codex-home'],
      model: options.model,
      formalReviewProvider: options['formal-review-provider'],
      formalReviewCodexBinary: options['formal-review-codex-binary'],
      formalReviewCodexHome: options['formal-review-codex-home'],
      formalReviewModel: options['formal-review-model'],
    },
    preflightAuthor(input) { calls.author = input; return preflights.author; },
    preflightReviewer(input) { calls.reviewer = input; return preflights.reviewer; },
    preflightEmpiricalRuntime() { throw new Error('fixture_runtime_unavailable'); },
  });
  assertPrincipalInput(calls.author, expected.researchAuthor);
  assertPrincipalInput(calls.reviewer, expected.formalReviewer);
  assert.equal(
    report.loopPreparation.autonomousResearchProviderConfigurationHash,
    expected.autonomousResearchProviderConfigurationHash,
  );
  assert.equal(
    report.runtimePrincipalPreflight.autonomousResearchProviderConfigurationHash,
    expected.autonomousResearchProviderConfigurationHash,
  );
  const publicReport = JSON.stringify(report);
  assert.doesNotMatch(publicReport, /cli-author-home|cli-reviewer-home|cli-codex|cli-review-codex/);
});

test('environment fallback is deterministic and CLI values win field by field', () => {
  const root = path.resolve('/tmp/hepta-provider-precedence-fixture');
  const environment = conflictingEnvironment(root);
  const fromEnvironment = resolveAutonomousResearchProviderConfiguration({ environment });
  assert.deepEqual(fromEnvironment.researchAuthor, {
    provider: 'codex',
    codexBinary: environment.HEPTA_RESEARCH_AUTHOR_CODEX_BINARY,
    codexHome: environment.HEPTA_RESEARCH_AUTHOR_CODEX_HOME,
    model: environment.HEPTA_RESEARCH_AUTHOR_MODEL,
  });
  assert.deepEqual(fromEnvironment.formalReviewer, {
    provider: 'codex',
    codexBinary: environment.HEPTA_FORMAL_REVIEW_CODEX_BINARY,
    codexHome: environment.HEPTA_FORMAL_REVIEW_CODEX_HOME,
    model: environment.HEPTA_FORMAL_REVIEW_MODEL,
  });
  const mixed = resolveAutonomousResearchProviderConfiguration({
    options: { model: 'cli-author-only', 'formal-review-codex-home': '/cli/reviewer-only' },
    environment,
  });
  assert.equal(mixed.researchAuthor.model, 'cli-author-only');
  assert.equal(mixed.researchAuthor.codexBinary, environment.HEPTA_RESEARCH_AUTHOR_CODEX_BINARY);
  assert.equal(mixed.formalReviewer.codexHome, '/cli/reviewer-only');
  assert.equal(mixed.formalReviewer.model, environment.HEPTA_FORMAL_REVIEW_MODEL);
});

test('autonomous provider surface accepts only Codex or auto for both principals', () => {
  for (const researchAuthorProvider of ['auto', 'codex']) {
    for (const formalReviewerProvider of ['auto', 'codex']) {
      const configuration = resolveAutonomousResearchProviderConfiguration({
        options: {
          'agent-provider': researchAuthorProvider,
          'formal-review-provider': formalReviewerProvider,
        },
      });
      assert.equal(configuration.researchAuthor.provider, 'codex');
      assert.equal(configuration.formalReviewer.provider, 'codex');
    }
  }
  for (const provider of ['openclaw', 'ollama']) {
    assert.throws(() => resolveAutonomousResearchProviderConfiguration({
      options: { 'agent-provider': provider },
    }), new RegExp(`autonomous_research_research_author_provider_unsupported:${provider}`));
    assert.throws(() => resolveAutonomousResearchProviderConfiguration({
      options: { 'formal-review-provider': provider },
    }), new RegExp(`autonomous_research_formal_reviewer_provider_unsupported:${provider}`));
  }
});

test('legacy provider bindings permit only read-only status and all mismatches fail closed', () => {
  const configuration = resolveAutonomousResearchProviderConfiguration({
    options: { model: 'persisted-author', 'formal-review-model': 'persisted-reviewer' },
  });
  const substitute = resolveAutonomousResearchProviderConfiguration({
    options: { model: 'substitute-author', 'formal-review-model': 'persisted-reviewer' },
  });
  const matchingCampaign = {
    spec: {
      autonomousResearchPreparation: {
        autonomousResearchProviderConfigurationHash:
          configuration.autonomousResearchProviderConfigurationHash,
      },
    },
  };
  const missingCampaign = { spec: { autonomousResearchPreparation: {} } };
  for (const action of ['launch', 'status', 'resume', 'converge']) {
    assert.equal(requirePersistedAutonomousProviderConfiguration({
      action,
      existingCampaign: matchingCampaign,
      providerConfiguration: configuration,
    }), configuration.autonomousResearchProviderConfigurationHash, action);
    assert.throws(() => requirePersistedAutonomousProviderConfiguration({
      action,
      existingCampaign: matchingCampaign,
      providerConfiguration: substitute,
    }), /autonomous_research_provider_configuration_hash_mismatch/, action);
  }
  assert.equal(requirePersistedAutonomousProviderConfiguration({
    action: 'status',
    existingCampaign: missingCampaign,
    providerConfiguration: configuration,
  }), null);
  for (const action of ['launch', 'resume', 'converge']) {
    assert.throws(() => requirePersistedAutonomousProviderConfiguration({
      action,
      existingCampaign: missingCampaign,
      providerConfiguration: configuration,
    }), /autonomous_research_provider_configuration_binding_required/, action);
  }
  assert.throws(() => composeCampaignWorkerExecution({
    runtimeRoot: '/tmp/legacy-autonomous-provider-binding-test',
    campaignExecutionContext: {},
    services: {},
    plans: [missingCampaign.spec],
  }), /autonomous_research_provider_configuration_binding_required/);
});

test('one hash-bound configuration reaches readiness, worker composition, and qualification context', async (t) => {
  const fixture = runtimeFixture(t);
  const options = {
    'agent-provider': 'codex',
    'codex-binary': fixture.binary,
    'codex-home': fixture.authorHome,
    model: 'bound-author-model',
    'formal-review-provider': 'codex',
    'formal-review-codex-binary': fixture.binary,
    'formal-review-codex-home': fixture.reviewerHome,
    'formal-review-model': 'bound-reviewer-model',
  };
  const environment = { PATH: path.dirname(fixture.binary) };
  const configuration = resolveAutonomousResearchProviderConfiguration({ options, environment });
  const preflights = capabilityPreflights();
  const readinessInputs = {};
  const readiness = await composeAutonomousResearchReadiness({
    paperId: 'three-way-provider-binding',
    environment: conflictingEnvironment(fixture.root),
    providerConfiguration: configuration,
    expectedProviderConfigurationHash: configuration.autonomousResearchProviderConfigurationHash,
    preflightAuthor(input) { readinessInputs.author = input; return preflights.author; },
    preflightReviewer(input) { readinessInputs.reviewer = input; return preflights.reviewer; },
    preflightEmpiricalRuntime() { throw new Error('fixture_runtime_unavailable'); },
  });
  const plan = {
    sourceWorkspace: fixture.root,
    campaignPlanHash: H('worker-plan'),
    paperQualityRequirements: {
      formalVerificationRequired: true,
      empiricalVerificationRequired: true,
    },
    researchVerificationRequired: true,
    releaseHandoffRequired: true,
    nodes: [{ kind: 'writer' }, { kind: 'formal-verify' }],
    autonomousResearchPreparation: readiness.loopPreparation,
  };
  let formalWorkerInput = null;
  const worker = composeCampaignWorkerExecution({
    options: {},
    plans: [plan],
    runtimeRoot: path.join(fixture.root, 'runtime'),
    datasetMounts: [],
    workspaceRegistry: {},
    campaignExecutionContext: {
      createFormalReviewAgentExecutor(input) {
        formalWorkerInput = input;
        return { async execute() { return null; } };
      },
    },
    services: {},
    spawnSyncImpl: codexPreflightSpawn,
    environment,
    providerConfiguration: configuration,
    expectedProviderConfigurationHash:
      readiness.loopPreparation.autonomousResearchProviderConfigurationHash,
  });
  const qualificationInputs = [];
  const qualificationContext = createAutonomousResearchQualificationContextProvider({
    schemaVersionReceipt: { version: 23 },
    providerConfiguration: configuration,
    expectedProviderConfigurationHash:
      readiness.loopPreparation.autonomousResearchProviderConfigurationHash,
    environment,
    spawnSyncImpl: codexPreflightSpawn,
    preflightAuthor(input) { qualificationInputs.push(input); return preflights.author; },
    preflightReviewer(input) { qualificationInputs.push(input); return preflights.reviewer; },
    probeModelAvailability(input) {
      return { kind: 'FixtureCanary', model: input.model, errorPrefix: input.errorPrefix };
    },
    codeProvenanceProvider: () => ({ status: 'fixture-code-provenance' }),
  });
  const qualification = await qualificationContext({ preparation: readiness.loopPreparation });
  assertPrincipalInput(readinessInputs.author, configuration.researchAuthor);
  assertPrincipalInput(readinessInputs.reviewer, configuration.formalReviewer);
  assert.equal(worker.researchAuthorCapabilityReceipt.model, options.model);
  assertPrincipalInput(formalWorkerInput, configuration.formalReviewer);
  assertPrincipalInput(qualificationInputs[0], configuration.researchAuthor);
  assertPrincipalInput(qualificationInputs[1], configuration.formalReviewer);
  assert.equal(worker.autonomousResearchProviderConfigurationHash,
    configuration.autonomousResearchProviderConfigurationHash);
  assert.equal(qualification.autonomousResearchProviderConfigurationHash,
    configuration.autonomousResearchProviderConfigurationHash);
});

test('tampering and readiness, worker, or qualification hash disagreement fail closed', async () => {
  const original = resolveAutonomousResearchProviderConfiguration({
    options: {
      model: 'original-author',
      'formal-review-model': 'original-reviewer',
    },
  });
  const directlyTampered = structuredClone(original);
  directlyTampered.researchAuthor.model = 'tampered-without-rehash';
  assert.equal(verifyAutonomousResearchProviderConfiguration(directlyTampered), false);
  assert.throws(
    () => requireAutonomousResearchProviderConfiguration(directlyTampered),
    /autonomous_research_provider_configuration_invalid/,
  );
  const fullyRehashedSubstitute = resolveAutonomousResearchProviderConfiguration({
    options: {
      model: 'substitute-author',
      'formal-review-model': 'original-reviewer',
    },
  });
  await assert.rejects(() => composeAutonomousResearchReadiness({
    paperId: 'readiness-provider-mismatch',
    providerConfiguration: fullyRehashedSubstitute,
    expectedProviderConfigurationHash: original.autonomousResearchProviderConfigurationHash,
  }), /autonomous_research_provider_configuration_hash_mismatch/);
  assert.throws(() => composeCampaignWorkerExecution({
    plans: [{
      autonomousResearchPreparation: {
        autonomousResearchProviderConfigurationHash:
          original.autonomousResearchProviderConfigurationHash,
      },
    }],
    runtimeRoot: '/tmp/provider-worker-mismatch',
    campaignExecutionContext: {},
    services: {},
    providerConfiguration: fullyRehashedSubstitute,
  }), /autonomous_research_provider_configuration_hash_mismatch/);
  assert.throws(() => createAutonomousResearchQualificationContextProvider({
    providerConfiguration: fullyRehashedSubstitute,
    expectedProviderConfigurationHash: original.autonomousResearchProviderConfigurationHash,
  }), /autonomous_research_provider_configuration_hash_mismatch/);
  const provider = createAutonomousResearchQualificationContextProvider({
    providerConfiguration: original,
    expectedProviderConfigurationHash: original.autonomousResearchProviderConfigurationHash,
  });
  await assert.rejects(() => provider({
    preparation: {
      autonomousResearchProviderConfigurationHash:
        fullyRehashedSubstitute.autonomousResearchProviderConfigurationHash,
    },
  }), /autonomous_research_provider_configuration_hash_mismatch/);
});
