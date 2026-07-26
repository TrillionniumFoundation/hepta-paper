import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  StrictFullAutoAcceptanceCommandRunner,
} from '../../../paper-adapters/automation/strict-full-auto-acceptance-command-runner.mjs';
import {
  StrictFullAutoAcceptanceRepository,
} from '../../../paper-adapters/automation/strict-full-auto-acceptance-repository.mjs';
import {
  buildRecoverableReviewerExecutorServiceConfiguration,
} from '../../../paper-adapters/automation/http-recoverable-reviewer-executor-adapter.mjs';
import {
  buildReviewerReceiptSignerServiceConfiguration,
} from '../../../paper-adapters/automation/http-reviewer-receipt-signer-adapter.mjs';
import {
  buildReviewerPrincipalPoolConfiguration,
} from '../../../paper-adapters/automation/reviewer-principal-pool-configuration-reader.mjs';
import {
  autonomousSubmissionPortalPublicDescriptorHash,
} from '../../../paper-adapters/automation/autonomous-submission-portal-public-adapter.mjs';
import {
  StrictFullAutoAcceptanceOrchestrator,
} from '../../../paper-application/automation/strict-full-auto-acceptance-orchestrator.mjs';
import {
  STRICT_FULL_AUTO_ACCEPTANCE_REFERENCE_POLICY,
  STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER,
  strictFullAutoAcceptanceHash,
} from '../../../paper-domain/automation/strict-full-auto-acceptance-contract.mjs';

export const STRICT_FULL_AUTO_ACCEPTANCE_TEST_NOW = '2026-07-21T05:00:00.000Z';

export function sha256File(candidate) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')}`;
}

const EXAMPLE_CONFIGURATION = JSON.parse(fs.readFileSync(new URL(
  '../../deploy/strict-full-auto-acceptance.config.example.json',
  import.meta.url,
), 'utf8'));

function fixtureArgument(value) {
  return value
    .replace('sha256:REPLACE_WITH_CHILD_PLAN', `sha256:${'a'.repeat(64)}`)
    .replaceAll('REPLACE_WITH_GOLDEN_PAPER', 'fixture-golden-paper')
    .replaceAll('REPLACE', '1');
}

const ARGUMENT_REFERENCE_FLAGS = Object.freeze({
  'state-provisioning': Object.freeze({
    '--machine-intake-config': 'machine-intake-principal',
    '--topic-producer-profile': 'topic-producer-profile',
    '--authority-process-config': 'online-state-authority-process-config',
  }),
  'online-transition': Object.freeze({
    '--authority-process-config': 'online-state-authority-process-config',
  }),
  'runtime-reproducibility': Object.freeze({
    '--config': 'runtime-reproducibility-principal',
  }),
  'advanced-numeric-activation': Object.freeze({
    '--signing-config': 'empirical-plugin-signing-config',
  }),
  'external-qualifier': Object.freeze({
    '--external-qualification-config': 'external-qualifier-principal',
  }),
  'golden-qualification': Object.freeze({
    '--external-qualification-config': 'external-qualifier-principal',
  }),
  'restore-drill': Object.freeze({
    '--authority-config': 'backup-restore-authority-principal',
  }),
});

const CHILD_IDEMPOTENCY_FLAGS = Object.freeze({
  'state-provisioning': '--plan-id',
  'online-transition': '--transition-id',
  'submission-dispatcher': '--idempotency-key',
});

function bindFixtureArgumentReferences(stepId, invocation, references) {
  for (const [flag, referenceId] of Object.entries(ARGUMENT_REFERENCE_FLAGS[stepId] || {})) {
    const index = invocation.arguments.indexOf(flag);
    if (index >= 0) invocation.arguments[index + 1] = references[referenceId].path;
  }
  if (stepId === 'submission-dispatcher') {
    const descriptor = JSON.parse(fs.readFileSync(
      references['submission-portal-descriptor-config'].path,
      'utf8',
    ));
    const values = {
      '--portal-id': descriptor.portalId,
      '--portal-configuration-hash': descriptor.configurationHash,
      '--portal-descriptor-hash': autonomousSubmissionPortalPublicDescriptorHash(descriptor),
    };
    for (const [flag, value] of Object.entries(values)) {
      const index = invocation.arguments.indexOf(flag);
      if (index >= 0) invocation.arguments[index + 1] = value;
    }
  }
}

function reviewerAuthorityTrustStore(pair, {
  keyId,
  role,
  subjectId,
}) {
  return {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [{
      keyId,
      subjectId,
      organization: 'Strict Acceptance External Reviewer Authority',
      algorithm: 'ed25519',
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
      roles: [role],
      status: 'active',
      effectiveFrom: '2026-07-20T00:00:00.000Z',
      expiresAt: '2027-07-20T00:00:00.000Z',
      revokedAt: null,
    }],
  };
}

function strictReviewerPoolConfiguration({ root, credentialRoot }) {
  const principals = [1, 2, 3].map((index) => {
    const signerKey = crypto.generateKeyPairSync('ed25519');
    const executionKey = crypto.generateKeyPairSync('ed25519');
    const signerTokenVariable = `HEPTA_REVIEWER_${index}_SIGNER_TOKEN_FILE`;
    const executorTokenVariable = `HEPTA_REVIEWER_${index}_EXECUTOR_TOKEN_FILE`;
    for (const [name, value] of [
      [signerTokenVariable, `signer-token-${index}\n`],
      [executorTokenVariable, `executor-token-${index}\n`],
    ]) {
      fs.writeFileSync(path.join(credentialRoot, name), value, { mode: 0o600 });
    }
    return {
      codexBinary: '/usr/local/bin/codex',
      codexHome: path.join(root, `reviewer-codex-home-${index}`),
      model: 'gpt-5.2',
      providerAccountIdentityHash:
        strictFullAutoAcceptanceHash({ reviewer: index, identity: 'account' }),
      roles: index === 1
        ? ['formal-review', 'independent-review'] : ['independent-review'],
      signerConfiguration: buildReviewerReceiptSignerServiceConfiguration({
        version: 3,
        serviceId: `strict-reviewer-signer-${index}`,
        endpoint: `https://strict-reviewer-${index}.example.test/v3/sign`,
        lookupEndpoint:
          `https://strict-reviewer-${index}.example.test/v3/operations`,
        resumeEndpoint:
          `https://strict-reviewer-${index}.example.test/v3/resume`,
        serviceIdentityHash:
          strictFullAutoAcceptanceHash({ reviewer: index, service: 'signer' }),
        tokenEnvironmentVariable: signerTokenVariable,
        receiptTrustStore: reviewerAuthorityTrustStore(signerKey, {
          keyId: `strict-reviewer-signer-key-${index}`,
          role: 'reviewer_receipt_attestor',
          subjectId: `strict-reviewer-signer-authority-${index}`,
        }),
        receiptSignerKeyIds: [`strict-reviewer-signer-key-${index}`],
      }),
      recoverableExecutorConfiguration:
        buildRecoverableReviewerExecutorServiceConfiguration({
          serviceId: `strict-reviewer-executor-${index}`,
          endpoint: `https://strict-reviewer-${index}.example.test/v1/execute`,
          lookupEndpoint:
            `https://strict-reviewer-${index}.example.test/v1/operations`,
          resumeEndpoint:
            `https://strict-reviewer-${index}.example.test/v1/resume`,
          serviceIdentityHash:
            strictFullAutoAcceptanceHash({ reviewer: index, service: 'executor' }),
          tokenEnvironmentVariable: executorTokenVariable,
          outcomeTrustStore: reviewerAuthorityTrustStore(executionKey, {
            keyId: `strict-reviewer-executor-key-${index}`,
            role: 'reviewer_execution_attestor',
            subjectId: `strict-reviewer-executor-authority-${index}`,
          }),
          outcomeSignerKeyIds: [`strict-reviewer-executor-key-${index}`],
        }),
      trustDomainIdentityHash:
        strictFullAutoAcceptanceHash({ reviewer: index, identity: 'trust-domain' }),
    };
  });
  return buildReviewerPrincipalPoolConfiguration({
    version: 2,
    poolId: 'strict-acceptance-reviewers',
    principals,
    minimumReviewerTrustDomains: 3,
  });
}

export function strictFullAutoAcceptanceFixture(t, mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-strict-acceptance-'));
  t.after(() => {
    try { fs.chmodSync(path.join(root, 'assets'), 0o700); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const runtimeRoot = path.join(root, 'runtime');
  const controlRoot = path.join(root, 'control');
  const assetRoot = path.join(root, 'assets');
  const datasetRoot = path.join(root, 'datasets');
  const restoreBundle = path.join(root, 'restore-bundle');
  const referenceRoot = path.join(root, 'references');
  fs.mkdirSync(controlRoot, { mode: 0o700 });
  fs.mkdirSync(referenceRoot, { recursive: true });
  fs.mkdirSync(assetRoot, { mode: 0o700 });
  fs.mkdirSync(datasetRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(restoreBundle, { recursive: true });
  const references = {};
  let subjectOrdinal = 0;
  for (const [referenceId, kind] of Object.entries(
    STRICT_FULL_AUTO_ACCEPTANCE_REFERENCE_POLICY,
  )) {
    const candidate = path.join(referenceRoot, `${referenceId}.ref`);
    subjectOrdinal += 1;
    const subjectId = kind.startsWith('opaque-')
      ? `secret-reference-${subjectOrdinal}` : `authority-${subjectOrdinal}`;
    const principalDocument = referenceId.endsWith('-principal');
    const pinnedDocument = [
      'research-author-principal',
      'formal-sandbox-runtime-config',
      'production-mathlib-build-authority-config',
      'autonomous-venue-profile-config',
      'autonomous-submission-metadata-config',
      'submission-portal-descriptor-config',
      'prior-art-service-config',
      'external-replay-config',
    ].includes(referenceId);
    const portalDocument = referenceId === 'submission-portal-descriptor-config';
    if (kind === 'opaque-directory-reference') {
      fs.mkdirSync(candidate, { mode: 0o700 });
    } else {
      fs.writeFileSync(candidate, kind === 'public-reference'
        ? pinnedDocument || principalDocument
          ? `${JSON.stringify({
            ...(pinnedDocument
              ? { configurationHash: strictFullAutoAcceptanceHash({ referenceId }) } : {}),
            ...(principalDocument ? { principalId: subjectId } : {}),
            ...(portalDocument ? {
              version: 1,
              kind: 'AutonomousSubmissionPortalPublicConfiguration',
              portalId: 'strict-acceptance-portal',
              serviceIdentityHash: strictFullAutoAcceptanceHash({ portal: 'service' }),
              portalAccountIdentityHash: strictFullAutoAcceptanceHash({ portal: 'account' }),
              portalTrustDomainIdentityHash: strictFullAutoAcceptanceHash({ portal: 'trust' }),
              tokenEnvironmentVariableNameHash: strictFullAutoAcceptanceHash({ portal: 'token' }),
            } : {}),
            ...(referenceId === 'prior-art-service-config'
              ? { tokenEnvironmentVariable: 'HEPTA_PRIOR_ART_SERVICE_TOKEN_FILE' } : {}),
            ...(referenceId === 'external-replay-config'
              ? { tokenEnvironmentVariable: 'HEPTA_EXTERNAL_REPLAY_SERVICE_TOKEN_FILE' } : {}),
          })}\n`
          : `${referenceId}:public-authority\n`
        : kind === 'private-configuration-reference'
          ? '{}\n'
          : `${referenceId}:opaque\n`, { mode: 0o600 });
      fs.chmodSync(candidate, kind === 'public-reference' ? 0o444 : 0o400);
    }
    references[referenceId] = ['public-reference', 'private-configuration-reference'].includes(kind)
      ? { kind, path: candidate, subjectId,
        expectedSha256: sha256File(candidate) }
      : { kind, path: candidate, subjectId };
  }
  const reviewerPoolReference = references['formal-reviewer-principal'];
  const reviewerCredentialRoot =
    references['formal-reviewer-service-credential-root'].path;
  const reviewerPoolConfiguration = strictReviewerPoolConfiguration({
    root,
    credentialRoot: reviewerCredentialRoot,
  });
  fs.chmodSync(reviewerPoolReference.path, 0o600);
  fs.writeFileSync(
    reviewerPoolReference.path,
    `${JSON.stringify(reviewerPoolConfiguration, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(reviewerPoolReference.path, 0o444);
  reviewerPoolReference.expectedSha256 = sha256File(reviewerPoolReference.path);
  for (const referenceId of [
    'empirical-plugin-signer-command',
    'release-attestor-signer-command',
    'release-attestor-probe-command',
  ]) {
    fs.chmodSync(references[referenceId].path, 0o555);
  }
  const writePrivateConfiguration = (referenceId, value) => {
    const reference = references[referenceId];
    fs.chmodSync(reference.path, 0o600);
    fs.writeFileSync(reference.path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    fs.chmodSync(reference.path, 0o400);
    reference.expectedSha256 = sha256File(reference.path);
  };
  writePrivateConfiguration('empirical-plugin-signing-config', {
    version: 1,
    kind: 'AutonomousEmpiricalPluginSigningAuthorityConfiguration',
    trustStorePath: references['empirical-plugin-trust-store'].path,
    signer: {
      command: references['empirical-plugin-signer-command'].path,
      environmentAllowlist: [],
    },
  });
  writePrivateConfiguration('release-attestor-config', {
    version: 2,
    kind: 'ResearchExecutionReleaseAttestorConfiguration',
    backend: {
      kind: 'external-kms-command',
      signerCommand: {
        principalId: 'release-attestor-signer-production',
        executable: references['release-attestor-signer-command'].path,
        credentialRoot: references['release-attestor-signer-credential-root'].path,
        environmentAllowlist: [],
      },
      probeCommand: {
        principalId: 'release-attestor-probe-production',
        executable: references['release-attestor-probe-command'].path,
        credentialRoot: references['release-attestor-probe-credential-root'].path,
        environmentAllowlist: [],
      },
    },
  });
  const steps = Object.fromEntries(STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER.map((stepId) => {
    const source = structuredClone(EXAMPLE_CONFIGURATION.steps[stepId]);
    source.idempotencyKey = strictFullAutoAcceptanceHash({ stepId, fixture: true });
    source.execute.arguments = source.execute.arguments.map(fixtureArgument);
    source.verify.arguments = source.verify.arguments.map(fixtureArgument);
    bindFixtureArgumentReferences(stepId, source.execute, references);
    bindFixtureArgumentReferences(stepId, source.verify, references);
    const idempotencyFlag = CHILD_IDEMPOTENCY_FLAGS[stepId];
    if (idempotencyFlag) {
      for (const invocation of [source.execute, source.verify]) {
        const index = invocation.arguments.indexOf(idempotencyFlag);
        if (index >= 0) invocation.arguments[index + 1] = source.idempotencyKey;
      }
    }
    return [stepId, source];
  }));
  const stateArguments = steps['state-provisioning'].execute.arguments;
  stateArguments[stateArguments.indexOf('--dataset-root') + 1] = datasetRoot;
  steps['state-provisioning'].verify.assertions.find((assertion) => (
    assertion.path === '/plan/transitionId'
  )).equals = steps['online-transition'].idempotencyKey;
  const restoreArguments = steps['restore-drill'].execute.arguments;
  restoreArguments[restoreArguments.indexOf('--bundle') + 1] = restoreBundle;
  const operationalEnvironment = structuredClone(EXAMPLE_CONFIGURATION.operationalEnvironment);
  operationalEnvironment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT =
    path.join(root, 'runtime-reproducibility-receipt.json');
  operationalEnvironment.HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_ACTIVATION_POINTER =
    path.join(root, 'empirical-plugin-activation-pointer.json');
  operationalEnvironment.HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT = datasetRoot;
  for (const phase of ['execute', 'verify']) {
    const invocation = steps['runtime-reproducibility'][phase];
    invocation.arguments[invocation.arguments.indexOf('--receipt') + 1] =
      operationalEnvironment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT;
    const activation = steps['advanced-numeric-activation'][phase];
    activation.arguments[activation.arguments.indexOf('--activation') + 1] =
      operationalEnvironment.HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_ACTIVATION_POINTER;
  }
  const finalVerification = structuredClone(EXAMPLE_CONFIGURATION.finalVerification);
  const configuration = {
    version: 1,
    kind: 'StrictFullAutoAcceptanceConfiguration',
    controlRoot,
    runtimeRoot,
    assetRoot,
    datasetRoot,
    operationalEnvironment,
    references,
    steps,
    finalVerification,
  };
  mutate({
    root, controlRoot, runtimeRoot, assetRoot, datasetRoot, referenceRoot, configuration,
  });
  fs.chmodSync(assetRoot, 0o500);
  fs.chmodSync(datasetRoot, 0o500);
  fs.chmodSync(configuration.datasetRoot, 0o500);
  const configurationPath = path.join(root, 'acceptance-config.json');
  fs.writeFileSync(configurationPath, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o444 });
  return {
    root, controlRoot, runtimeRoot, assetRoot, datasetRoot, referenceRoot,
    configuration, configurationPath,
  };
}

export function strictFullAutoAcceptanceOrchestratorFor(configurationPath, runner) {
  return new StrictFullAutoAcceptanceOrchestrator({
    repository: new StrictFullAutoAcceptanceRepository({ configurationPath }),
    commandRunner: strictFullAutoAcceptanceRuntimeActivatingRunner(runner),
    now: () => STRICT_FULL_AUTO_ACCEPTANCE_TEST_NOW,
  });
}

export function strictFullAutoAcceptanceSuccessfulOutput(invocation, extra = {}) {
  const output = { skippedCount: 0, ...extra };
  for (const assertion of invocation.assertions) {
    const segments = assertion.path.split('/').slice(1);
    let cursor = output;
    for (const segment of segments.slice(0, -1)) cursor = cursor[segment] ||= {};
    cursor[segments.at(-1)] = assertion.equals;
  }
  return Object.freeze(output);
}

export function strictFullAutoAcceptanceNotReadyOutput(invocation) {
  const output = structuredClone(strictFullAutoAcceptanceSuccessfulOutput(invocation));
  const [assertion] = invocation.assertions;
  const segments = assertion.path.split('/').slice(1);
  let cursor = output;
  for (const segment of segments.slice(0, -1)) cursor = cursor[segment];
  cursor[segments.at(-1)] = assertion.equals === true ? false : 'fixture-not-ready';
  return output;
}

export function strictFullAutoAcceptanceRuntimeActivatingRunner(runner) {
  return {
    async run(request) {
      const output = await runner.run(request);
      if (request.step.stepId === 'state-provisioning' && request.phase === 'execute') {
        fs.mkdirSync(request.plan.runtimeRoot, { recursive: true, mode: 0o700 });
      }
      return output;
    },
  };
}

export function strictFullAutoAcceptanceSuccessfulRunner(calls = []) {
  return strictFullAutoAcceptanceRuntimeActivatingRunner({
    async run({ step, phase, invocation }) {
      calls.push(`${step.stepId}:${phase}`);
      return strictFullAutoAcceptanceSuccessfulOutput(
        invocation,
        { stepId: step.stepId, phase },
      );
    },
  });
}

export async function strictFullAutoAcceptanceProductionRunnerBindingTest(t) {
  const value = strictFullAutoAcceptanceFixture(t);
  const plan = strictFullAutoAcceptanceOrchestratorFor(
    value.configurationPath,
    strictFullAutoAcceptanceSuccessfulRunner(),
  ).plan();
  const captured = [];
  const runner = new StrictFullAutoAcceptanceCommandRunner({
    workspaceRoot: path.resolve('.'),
    environment: { PATH: process.env.PATH, HEPTA_RAW_TOKEN: 'must-not-leak' },
    runProcess: async (request) => {
      captured.push(request);
      return {
        exitCode: 0,
        timedOut: false,
        aborted: false,
        outputTruncated: false,
        stdout: JSON.stringify({ ready: true }),
      };
    },
  });
  const step = plan.steps.find((item) => item.stepId === 'state-provisioning');
  const invocation = step.execute;
  const controller = new AbortController();
  assert.deepEqual(await runner.run({
    plan, step, phase: 'execute', invocation, signal: controller.signal,
  }), { ready: true });
  assert.equal(captured[0].signal, controller.signal);
  assert.equal(captured[0].env.HEPTA_RAW_TOKEN, undefined);
  assert.equal(captured[0].env.HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG,
    value.configuration.references['research-author-principal'].path);
  assert.equal(captured[0].env.HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH,
    JSON.parse(fs.readFileSync(
      value.configuration.references['research-author-principal'].path,
      'utf8',
    )).configurationHash);
  assert.equal(captured[0].env.HEPTA_RESEARCH_AUTHOR_CODEX_HOME,
    value.configuration.references['research-author-credential-root'].path);
  assert.equal(captured[0].env.HEPTA_FORMAL_REVIEW_CODEX_HOME,
    value.configuration.references['formal-reviewer-credential-root'].path);
  const reviewerConfiguration = JSON.parse(fs.readFileSync(
    value.configuration.references['formal-reviewer-principal'].path,
    'utf8',
  ));
  const reviewerServiceVariables = reviewerConfiguration.principals.flatMap(
    (principal) => [
      principal.signerConfiguration.tokenEnvironmentVariable,
      principal.recoverableExecutorConfiguration.tokenEnvironmentVariable,
    ],
  );
  for (const name of reviewerServiceVariables) {
    assert.equal(
      captured[0].env[name],
      path.join(
        value.configuration.references[
          'formal-reviewer-service-credential-root'
        ].path,
        name,
      ),
    );
    assert.notEqual(captured[0].env[name], fs.readFileSync(
      captured[0].env[name],
      'utf8',
    ).trim());
  }
  assert.equal(captured[0].env.HEPTA_PAPER_RUNTIME_ROOT, plan.runtimeRoot);
  assert.equal(captured[0].env.HEPTA_PAPER_ASSET_ROOT, plan.assetRoot);
  assert.equal(captured[0].env.ELAN_HOME,
    plan.operationalEnvironment.HEPTA_FORMAL_ELAN_HOME);
  assert.equal(captured[0].env.HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH,
    plan.operationalEnvironment.HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH);
  assert.equal(captured[0].env.HOME, path.join(plan.controlRoot, 'restricted-child-home'));
  assert.equal(captured[0].env.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY,
    step.idempotencyKey);
  assert.equal(captured[0].env.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH, plan.planHash);
  assert.equal(captured[0].timeoutMs, (4 * 60 * 60 + 15 * 60) * 1000);
  await runner.run({
    plan, step, phase: 'verify', invocation: step.verify, signal: controller.signal,
  });
  assert.equal(captured[1].timeoutMs, 15 * 60 * 1000);
  assert.match(captured[1].args[0],
    /paper-core\/bin\/autonomous-research-online-schema-transition\.mjs$/);
  assert.deepEqual(captured[1].args.slice(1, 3), ['--action', 'plan']);
  await assert.rejects(runner.run({
    plan,
    step,
    phase: 'execute',
    invocation: { ...invocation, command: 'autonomous-submission-dispatcher' },
  }), /command_forbidden/);

  const productionStep = plan.steps.find((item) => (
    item.stepId === 'production-campaign-qualification'
  ));
  const productionRunnerPlan = Object.freeze({
    ...plan,
    operationalEnvironment: Object.freeze({
      ...plan.operationalEnvironment,
      HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_ACTIVATION_POINTER: '',
    }),
  });
  assert.deepEqual(await runner.run({
    plan: productionRunnerPlan,
    step: productionStep,
    phase: 'execute',
    invocation: productionStep.execute,
    signal: controller.signal,
  }), { ready: true });
  assert.match(captured[2].args[0],
    /paper-core\/bin\/autonomous-research-supervisor\.mjs$/);
  assert.deepEqual(captured[2].args.slice(1), ['--request-resident-cycle']);
  assert.equal(captured[2].env.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY,
    productionStep.idempotencyKey);
  assert.equal(captured[2].env.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH,
    plan.planHash);

  const restoreStep = plan.steps.find((item) => item.stepId === 'restore-drill');
  const restoreVerificationPlan = Object.freeze({
    ...plan,
    operationalEnvironment: Object.freeze({
      ...plan.operationalEnvironment,
      HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_ACTIVATION_POINTER: '',
    }),
  });
  assert.deepEqual(await runner.run({
    plan: restoreVerificationPlan,
    step: restoreStep,
    phase: 'verify',
    invocation: restoreStep.verify,
    signal: controller.signal,
  }), { ready: true });
  assert.match(captured[3].args[0], /paper-core\/bin\/automation-status\.mjs$/);
}
