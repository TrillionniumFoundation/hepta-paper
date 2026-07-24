import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { StrictFullAutoAcceptanceRepository } from '../../paper-adapters/automation/strict-full-auto-acceptance-repository.mjs';
import { StrictFullAutoAcceptanceCommandRunner } from '../../paper-adapters/automation/strict-full-auto-acceptance-command-runner.mjs';
import {
  autonomousSubmissionPortalPublicDescriptorHash,
} from '../../paper-adapters/automation/autonomous-submission-portal-public-adapter.mjs';
import { StrictFullAutoAcceptanceOrchestrator } from '../../paper-application/automation/strict-full-auto-acceptance-orchestrator.mjs';
import {
  STRICT_FULL_AUTO_ACCEPTANCE_REFERENCE_POLICY,
  STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER,
  strictFullAutoAcceptanceHash,
} from '../../paper-domain/automation/strict-full-auto-acceptance-contract.mjs';
import {
  parseStrictFullAutoAcceptanceArguments,
  runStrictFullAutoAcceptance,
} from '../bin/strict-full-auto-acceptance.mjs';

const NOW = '2026-07-21T05:00:00.000Z';

function sha256File(candidate) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')}`;
}

const EXAMPLE_CONFIGURATION = JSON.parse(fs.readFileSync(new URL(
  '../deploy/strict-full-auto-acceptance.config.example.json',
  import.meta.url,
), 'utf8'));

test('systemd convergence retries unattended without receiving portal secrets', () => {
  const unit = fs.readFileSync(new URL(
    '../deploy/strict-full-auto-acceptance.service', import.meta.url,
  ), 'utf8');
  const environment = fs.readFileSync(new URL(
    '../deploy/strict-full-auto-acceptance.env.example', import.meta.url,
  ), 'utf8');
  assert.match(unit, /strict-full-auto-acceptance -- --action converge/);
  assert.match(unit, /--execute --require-accepted/);
  assert.doesNotMatch(unit, /--plan-hash/);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^StartLimitIntervalSec=0$/m);
  assert.match(unit, /^TimeoutStartSec=24h$/m);
  assert.match(unit, /autonomous-research-supervisor\.service/);
  assert.match(unit, /autonomous-submission-dispatcher\.service/);
  assert.doesNotMatch(unit, /EnvironmentFile=.*autonomous-submission-dispatcher\.secrets\.env/);
  assert.match(unit, /InaccessiblePaths=.*autonomous-submission-dispatcher\.secrets\.env/);
  assert.match(unit, /^ReadOnlyPaths=.*\/srv\/hepta-paper\/datasets(?:\s|$)/m);
  assert.doesNotMatch(unit, /^ReadWritePaths=.*\/srv\/hepta-paper\/datasets(?:\s|$)/m);
  assert.doesNotMatch(unit, /\/srv\/hepta-paper\/assets\/datasets/);
  assert.equal(environment.trim(),
    'HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_CONFIGURATION=/run/hepta/strict-full-auto-acceptance.json');
});

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

function fixture(t, mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-strict-acceptance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
  const configurationPath = path.join(root, 'acceptance-config.json');
  fs.writeFileSync(configurationPath, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o444 });
  return {
    root, controlRoot, runtimeRoot, assetRoot, datasetRoot, referenceRoot,
    configuration, configurationPath,
  };
}

function orchestratorFor(configurationPath, runner) {
  return new StrictFullAutoAcceptanceOrchestrator({
    repository: new StrictFullAutoAcceptanceRepository({ configurationPath }),
    commandRunner: runtimeActivatingRunner(runner),
    now: () => NOW,
  });
}

function successfulOutput(invocation, extra = {}) {
  const output = { skippedCount: 0, ...extra };
  for (const assertion of invocation.assertions) {
    const segments = assertion.path.split('/').slice(1);
    let cursor = output;
    for (const segment of segments.slice(0, -1)) cursor = cursor[segment] ||= {};
    cursor[segments.at(-1)] = assertion.equals;
  }
  return Object.freeze(output);
}

function runtimeActivatingRunner(runner) {
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

function successfulRunner(calls = []) {
  return runtimeActivatingRunner({
    async run({ step, phase, invocation }) {
      calls.push(`${step.stepId}:${phase}`);
      return successfulOutput(invocation, { stepId: step.stepId, phase });
    },
  });
}

test('plan preflights all external references without reading opaque material or creating runtime state', (t) => {
  const value = fixture(t);
  const service = orchestratorFor(value.configurationPath, successfulRunner());
  const first = service.plan();
  const second = service.plan();
  assert.equal(first.planHash, second.planHash);
  assert.equal(first.referenceBindings.length,
    Object.keys(STRICT_FULL_AUTO_ACCEPTANCE_REFERENCE_POLICY).length);
  assert.equal(first.datasetRoot, value.datasetRoot);
  assert.deepEqual(first.rootBindings.map(({ rootId, accessMode }) => ({
    rootId, accessMode,
  })), [
    { rootId: 'control-root', accessMode: 'read-write' },
    { rootId: 'runtime-root', accessMode: 'read-write' },
    { rootId: 'asset-root', accessMode: 'read-only' },
    { rootId: 'dataset-root', accessMode: 'read-only' },
  ]);
  assert.equal(first.privateKeyMaterialHandled, false);
  assert.equal(first.selfSignedAuthorityPermitted, false);
  assert.equal(fs.existsSync(path.join(value.controlRoot, 'state.json')), false);
});

test('dataset is a separate read-only root and nested asset datasets fail closed', (t) => {
  const nested = fixture(t, ({ assetRoot, configuration }) => {
    const nestedDatasetRoot = path.join(assetRoot, 'datasets');
    fs.mkdirSync(nestedDatasetRoot, { mode: 0o700 });
    configuration.datasetRoot = nestedDatasetRoot;
    configuration.operationalEnvironment.HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT =
      nestedDatasetRoot;
    const invocation = configuration.steps['state-provisioning'].execute;
    invocation.arguments[invocation.arguments.indexOf('--dataset-root') + 1] =
      nestedDatasetRoot;
  });
  assert.throws(
    () => orchestratorFor(nested.configurationPath, successfulRunner()).plan(),
    /strict_full_auto_acceptance_roots_overlap/,
  );
});

test('transition-plan verification breaks the former inventory-before-transition deadlock',
  async (t) => {
    const value = fixture(t);
    const calls = [];
    let transitionExecuted = false;
    const requireInventoryReady = () => {
      if (!transitionExecuted) throw new Error('legacy_inventory_before_transition_deadlock');
    };
    assert.throws(requireInventoryReady, /legacy_inventory_before_transition_deadlock/);
    let plan;
    const service = orchestratorFor(value.configurationPath, {
      async run({ step, phase, invocation }) {
        calls.push(`${step.stepId}:${phase}`);
        if (step.stepId === 'state-provisioning' && phase === 'verify') {
          assert.equal(invocation.command, 'autonomous-online-transition');
          assert.deepEqual(invocation.arguments.slice(0, 2), ['--action', 'plan']);
          assert.equal(invocation.assertions.some((assertion) => (
            assertion.path === '/autonomousStateDatabaseInventoryReady'
          )), false);
          assert.equal(invocation.assertions.find((assertion) => (
            assertion.path === '/plan/transitionId'
          )).equals, plan.steps.find((candidate) => (
            candidate.stepId === 'online-transition'
          )).idempotencyKey);
        }
        if (step.stepId === 'online-transition' && phase === 'execute') {
          transitionExecuted = true;
        }
        if (invocation.assertions.some((assertion) => (
          assertion.path === '/autonomousStateDatabaseInventoryReady'
        ))) {
          assert.equal(step.stepId, 'online-transition');
          assert.equal(phase, 'verify');
          requireInventoryReady();
        }
        return successfulOutput(invocation);
      },
    });
    plan = service.plan();
    const completed = await service.execute({ expectedPlanHash: plan.planHash });
    assert.equal(completed.strictFullAutoAccepted, true);
    assert.ok(calls.indexOf('state-provisioning:verify')
      < calls.indexOf('migration:execute'));
    assert.ok(calls.indexOf('migration:verify')
      < calls.indexOf('online-transition:execute'));
    assert.ok(calls.indexOf('online-transition:execute')
      < calls.indexOf('online-transition:verify'));
  });

test('missing opaque secret and wrong principal separation fail before any action or state write', async (t) => {
  const missing = fixture(t);
  fs.rmSync(missing.configuration.references['release-attestor-signer-credential-root'].path, {
    recursive: true,
  });
  const calls = [];
  const missingService = orchestratorFor(missing.configurationPath, successfulRunner(calls));
  assert.throws(
    () => missingService.plan(),
    /strict_full_auto_acceptance_reference_missing:release-attestor-signer-credential-root/,
  );
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(missing.controlRoot, 'state.json')), false);

  const wrong = fixture(t, ({ configuration }) => {
    const author = configuration.references['research-author-principal'];
    const reviewer = configuration.references['formal-reviewer-principal'];
    fs.chmodSync(reviewer.path, 0o644);
    fs.copyFileSync(author.path, reviewer.path);
    fs.chmodSync(reviewer.path, 0o444);
    reviewer.expectedSha256 = sha256File(reviewer.path);
  });
  const wrongService = orchestratorFor(wrong.configurationPath, successfulRunner(calls));
  assert.throws(() => wrongService.plan(), /principal_reference_alias_forbidden/);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(wrong.controlRoot, 'state.json')), false);
});

test('execute requires the immutable plan hash and completes all steps with zero skips', async (t) => {
  const value = fixture(t);
  const calls = [];
  const service = orchestratorFor(value.configurationPath, successfulRunner(calls));
  const plan = service.plan();
  await assert.rejects(service.execute({ expectedPlanHash: `sha256:${'0'.repeat(64)}` }),
    /explicit_plan_hash_required/);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(value.controlRoot, 'state.json')), false);
  const completed = await service.execute({ expectedPlanHash: plan.planHash });
  assert.equal(completed.strictFullAutoAccepted, true);
  assert.equal(completed.completedStepCount, STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER.length);
  assert.equal(completed.receipt.skippedCount, 0);
  assert.equal(completed.receipt.externalAuthoritiesSelfSigned, false);
  assert.equal(completed.receipt.localCheckpointOnly, true);
  assert.equal(completed.receipt.strictFullAutoAccepted, false);
  assert.equal(completed.liveVerificationReceipt.strictFullAutoAccepted, true);
  const executeCalls = calls.filter((item) => item.endsWith(':execute')).length;
  const repeated = await service.execute({ expectedPlanHash: plan.planHash });
  assert.equal(repeated.strictFullAutoAccepted, true);
  assert.equal(calls.filter((item) => item.endsWith(':execute')).length, executeCalls,
    'completed external actions are not repeated; status is freshly verified');
  const verificationCalls = calls.filter((item) => item.endsWith(':verify')).length;
  await service.status();
  await service.status();
  assert.equal(calls.filter((item) => item.endsWith(':verify')).length - verificationCalls,
    (STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER.length + 1) * 2);
});

test('external failure checkpoints progress and resumes without repeating completed steps', async (t) => {
  const value = fixture(t);
  const calls = [];
  let onlineExecuteFailures = 1;
  let onlineRecoveryVerificationFailures = 1;
  const runner = {
    async run({ step, phase, invocation }) {
      calls.push(`${step.stepId}:${phase}`);
      if (step.stepId === 'online-transition' && phase === 'execute'
        && onlineExecuteFailures-- > 0) throw new Error('external_transition_failed');
      if (step.stepId === 'online-transition' && phase === 'verify'
        && onlineRecoveryVerificationFailures-- > 0) throw new Error('not_converged');
      return successfulOutput(invocation);
    },
  };
  const service = orchestratorFor(value.configurationPath, runner);
  const plan = service.plan();
  await assert.rejects(service.execute({ expectedPlanHash: plan.planHash }),
    /external_transition_failed/);
  assert.equal((await service.status()).completedStepCount, 2);
  const completed = await service.execute({ expectedPlanHash: plan.planHash });
  assert.equal(completed.strictFullAutoAccepted, true);
  assert.equal(calls.filter((item) => item === 'migration:execute').length, 1);
  assert.equal(calls.filter((item) => item === 'state-provisioning:execute').length, 1);
  assert.equal(calls.filter((item) => item === 'online-transition:execute').length, 2);
});

test('configuration or authority drift invalidates a partial checkpoint', async (t) => {
  const value = fixture(t);
  const service = orchestratorFor(value.configurationPath, {
    async run({ step, phase, invocation }) {
      if (step.stepId === 'migration' && phase === 'execute') {
        throw new Error('fixture_stop');
      }
      return successfulOutput(invocation);
    },
  });
  const plan = service.plan();
  await assert.rejects(service.execute({ expectedPlanHash: plan.planHash }), /fixture_stop/);
  const publicReference = value.configuration.references['research-author-principal'];
  fs.chmodSync(publicReference.path, 0o644);
  fs.writeFileSync(publicReference.path, `${JSON.stringify({
    configurationHash: strictFullAutoAcceptanceHash({ rotatedAuthority: true }),
    principalId: publicReference.subjectId,
  })}\n`);
  fs.chmodSync(publicReference.path, 0o444);
  publicReference.expectedSha256 = sha256File(publicReference.path);
  fs.chmodSync(value.configurationPath, 0o644);
  fs.writeFileSync(value.configurationPath, `${JSON.stringify(value.configuration, null, 2)}\n`);
  fs.chmodSync(value.configurationPath, 0o444);
  await assert.rejects(service.status(), /state_invalid/);
});

test('partial step receipts are immediately revalidated against every plan identity', async (t) => {
  const value = fixture(t);
  const repository = new StrictFullAutoAcceptanceRepository({
    configurationPath: value.configurationPath,
  });
  const service = new StrictFullAutoAcceptanceOrchestrator({
    repository,
    commandRunner: runtimeActivatingRunner({
      async run({ step, phase, invocation }) {
        if (step.stepId === 'migration' && phase === 'execute') {
          throw new Error('fixture_partial_checkpoint');
        }
        return successfulOutput(invocation);
      },
    }),
    now: () => NOW,
  });
  const plan = service.plan();
  await assert.rejects(service.execute({ expectedPlanHash: plan.planHash }), /partial_checkpoint/);
  const baseline = JSON.parse(fs.readFileSync(repository.statePath(plan), 'utf8'));
  assert.equal(baseline.completedStepReceipts.length, 1);
  const rehashReceipt = (receipt) => {
    const body = { ...receipt };
    delete body.receiptHash;
    receipt.receiptHash = strictFullAutoAcceptanceHash(body);
  };
  const rehashState = (state) => {
    const body = { ...state };
    delete body.stateHash;
    state.stateHash = strictFullAutoAcceptanceHash(body);
  };
  const cases = [
    ['receipt-hash', (receipt) => { receipt.receiptHash = `sha256:${'0'.repeat(64)}`; },
      /step_receipt_hash_invalid/],
    ['timestamp', (receipt) => { receipt.completedAt = 'not-a-timestamp'; rehashReceipt(receipt); },
      /step_receipt_invalid/],
    ['future-timestamp', (receipt) => { receipt.completedAt = '2027-01-01T00:00:00.000Z';
      rehashReceipt(receipt); }, /step_identity_invalid/],
    ['skip', (receipt) => { receipt.skippedCount = 1; rehashReceipt(receipt); },
      /step_receipt_invalid/],
    ['step', (receipt) => { receipt.stepDefinitionHash = `sha256:${'1'.repeat(64)}`;
      rehashReceipt(receipt); }, /step_receipt_invalid/],
    ['plan', (receipt) => { receipt.planHash = `sha256:${'2'.repeat(64)}`;
      rehashReceipt(receipt); }, /step_identity_invalid/],
    ['configuration', (receipt) => { receipt.configurationHash = `sha256:${'3'.repeat(64)}`;
      rehashReceipt(receipt); }, /step_identity_invalid/],
    ['references', (receipt) => { receipt.referenceSetHash = `sha256:${'4'.repeat(64)}`;
      rehashReceipt(receipt); }, /step_identity_invalid/],
  ];
  for (const [label, mutate, expected] of cases) {
    const state = structuredClone(baseline);
    mutate(state.completedStepReceipts[0]);
    rehashState(state);
    fs.writeFileSync(repository.statePath(plan), `${JSON.stringify(state)}\n`);
    await assert.rejects(service.status(), expected, label);
  }
});

test('any skipped operational check is a hard failure and remains resumable', async (t) => {
  const value = fixture(t);
  let first = true;
  const service = orchestratorFor(value.configurationPath, {
    async run({ invocation }) {
      if (first) {
        first = false;
        return successfulOutput(invocation, { skippedCount: 1 });
      }
      return successfulOutput(invocation);
    },
  });
  const plan = service.plan();
  await assert.rejects(service.execute({ expectedPlanHash: plan.planHash }), /skip_forbidden/);
  assert.equal((await service.status()).status, 'failed');
  assert.equal((await service.status()).strictFullAutoAccepted, false);
});

test('CLI exposes plan/status/execute/converge and requires explicit mutation confirmation', () => {
  const configuration = '/tmp/strict-full-auto-acceptance.json';
  assert.equal(parseStrictFullAutoAcceptanceArguments([
    '--action', 'plan', '--configuration', configuration,
  ]).action, 'plan');
  assert.throws(() => parseStrictFullAutoAcceptanceArguments([
    '--action', 'execute', '--configuration', configuration,
    '--plan-hash', `sha256:${'a'.repeat(64)}`,
  ]), /confirmation_and_plan_hash_required/);
  assert.equal(parseStrictFullAutoAcceptanceArguments([
    '--action', 'execute', '--configuration', configuration,
    '--plan-hash', `sha256:${'a'.repeat(64)}`, '--execute',
  ]).action, 'execute');
  assert.throws(() => parseStrictFullAutoAcceptanceArguments([
    '--action', 'converge', '--configuration', configuration,
  ]), /converge_confirmation_required/);
  assert.throws(() => parseStrictFullAutoAcceptanceArguments([
    '--action', 'converge', '--configuration', configuration,
    '--plan-hash', `sha256:${'a'.repeat(64)}`, '--execute',
  ]), /converge_confirmation_required/);
  assert.equal(parseStrictFullAutoAcceptanceArguments([
    '--action', 'converge', '--configuration', configuration, '--execute',
  ]).action, 'converge');
});

test('converge binds the freshly inspected plan hash without an operator handoff', async () => {
  const planHash = `sha256:${'b'.repeat(64)}`;
  let inspected = 0;
  let executedHash = null;
  const result = await runStrictFullAutoAcceptance({
    argv: [
      '--action', 'converge', '--configuration', '/tmp/strict.json', '--execute',
    ],
    compose: () => ({
      plan() {
        inspected += 1;
        return Object.freeze({ planHash });
      },
      async execute({ expectedPlanHash }) {
        executedHash = expectedPlanHash;
        return Object.freeze({ strictFullAutoAccepted: true });
      },
    }),
  });
  assert.equal(inspected, 1);
  assert.equal(executedHash, planHash);
  assert.equal(result.report.strictFullAutoAccepted, true);
});

test('production runner binds the exact plan invocation, reference paths and idempotency identity', async (t) => {
  const value = fixture(t);
  const plan = orchestratorFor(value.configurationPath, successfulRunner()).plan();
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
  assert.equal(captured[0].env.HEPTA_PAPER_RUNTIME_ROOT, plan.runtimeRoot);
  assert.equal(captured[0].env.HEPTA_PAPER_ASSET_ROOT, plan.assetRoot);
  assert.equal(captured[0].env.HOME, path.join(plan.controlRoot, 'restricted-child-home'));
  assert.equal(captured[0].env.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY,
    step.idempotencyKey);
  assert.equal(captured[0].env.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH, plan.planHash);
  await runner.run({
    plan, step, phase: 'verify', invocation: step.verify, signal: controller.signal,
  });
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
});

test('a completed local checkpoint is not acceptance authority without fresh live verification', async (t) => {
  const value = fixture(t);
  const service = orchestratorFor(value.configurationPath, successfulRunner());
  const plan = service.plan();
  const completed = await service.execute({ expectedPlanHash: plan.planHash });
  assert.equal(completed.strictFullAutoAccepted, true);

  const rejecting = orchestratorFor(value.configurationPath, {
    async run({ invocation }) {
      const [assertion] = invocation.assertions;
      return { [assertion.path.slice(1)]: assertion.equals === true ? false : true,
        skippedCount: 0 };
    },
  });
  await assert.rejects(rejecting.status(), /assertion_failed/);
});

test('a failing live verifier aborts and reaps every concurrent child verifier', async (t) => {
  const value = fixture(t);
  const completed = orchestratorFor(value.configurationPath, successfulRunner());
  const plan = completed.plan();
  await completed.execute({ expectedPlanHash: plan.planHash });
  let waiting = 0;
  let aborted = 0;
  const rejecting = orchestratorFor(value.configurationPath, {
    async run({ step, signal }) {
      if (step.stepId === 'migration') throw new Error('fixture_live_verifier_failed');
      waiting += 1;
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          aborted += 1;
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => {
          aborted += 1;
          reject(signal.reason);
        }, { once: true });
      });
    },
  });
  await assert.rejects(rejecting.status(), /fixture_live_verifier_failed/);
  assert.equal(waiting, STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER.length - 1);
  assert.equal(aborted, waiting);
});

test('crash after an external success verifies first and never repeats that action', async (t) => {
  const value = fixture(t);
  const repository = new StrictFullAutoAcceptanceRepository({
    configurationPath: value.configurationPath,
  });
  const originalWriteState = repository.writeState.bind(repository);
  let crashWritesRemaining = 2;
  repository.writeState = (plan, state, options) => {
    if (crashWritesRemaining > 0 && state.activeStep?.stepId === 'migration'
      && (state.activeStep.phase === 'verify' || state.status === 'failed')) {
      crashWritesRemaining -= 1;
      throw new Error('simulated_process_crash_before_output_checkpoint');
    }
    return originalWriteState(plan, state, options);
  };
  const calls = [];
  const runner = successfulRunner(calls);
  const service = new StrictFullAutoAcceptanceOrchestrator({ repository, commandRunner: runner,
    now: () => NOW });
  const plan = service.plan();
  await assert.rejects(service.execute({ expectedPlanHash: plan.planHash }), /simulated_process/);
  const completed = await service.execute({ expectedPlanHash: plan.planHash });
  assert.equal(completed.strictFullAutoAccepted, true);
  assert.equal(calls.filter((item) => item === 'migration:execute').length, 1);
  assert.ok(calls.filter((item) => item === 'migration:verify').length >= 2);
});

test('ambiguous recovery verification never repeats an action without a durable child id',
  async (t) => {
    const value = fixture(t);
    const repository = new StrictFullAutoAcceptanceRepository({
      configurationPath: value.configurationPath,
    });
    const originalWriteState = repository.writeState.bind(repository);
    let crashWritesRemaining = 2;
    repository.writeState = (plan, state, options) => {
      if (crashWritesRemaining > 0 && state.activeStep?.stepId === 'migration'
        && (state.activeStep.phase === 'verify' || state.status === 'failed')) {
        crashWritesRemaining -= 1;
        throw new Error('simulated_process_crash_before_output_checkpoint');
      }
      return originalWriteState(plan, state, options);
    };
    const calls = [];
    let recoveryUnavailableOnce = true;
    const runner = {
      async run({ step, phase, invocation }) {
        calls.push(`${step.stepId}:${phase}`);
        if (step.stepId === 'migration' && phase === 'verify'
          && recoveryUnavailableOnce) {
          recoveryUnavailableOnce = false;
          throw new Error('temporary_verifier_unavailable');
        }
        return successfulOutput(invocation);
      },
    };
    const service = new StrictFullAutoAcceptanceOrchestrator({
      repository, commandRunner: runtimeActivatingRunner(runner),
      now: () => NOW });
    const plan = service.plan();
    await assert.rejects(service.execute({ expectedPlanHash: plan.planHash }), /simulated_process/);
    await assert.rejects(service.execute({ expectedPlanHash: plan.planHash }), /outcome_uncertain/);
    assert.equal(calls.filter((item) => item === 'migration:execute').length, 1);
    const completed = await service.execute({ expectedPlanHash: plan.planHash });
    assert.equal(completed.strictFullAutoAccepted, true);
    assert.equal(calls.filter((item) => item === 'migration:execute').length, 1);
  });

test('configuration cannot replace fixed semantics with help or dangerous environment injection', (t) => {
  const help = fixture(t, ({ configuration }) => {
    configuration.steps.migration.execute.arguments = ['--help'];
  });
  assert.throws(() => orchestratorFor(help.configurationPath, successfulRunner()).plan(),
    /invocation_policy_mismatch/);

  const injected = fixture(t, ({ configuration }) => {
    configuration.steps.migration.execute.environmentReferences = {
      LD_PRELOAD: 'release-attestor-signer-credential-root',
    };
  });
  assert.throws(() => orchestratorFor(injected.configurationPath, successfulRunner()).plan(),
    /environment_reference_invalid|invocation_policy_mismatch/);

  const duplicateAction = fixture(t, ({ configuration }) => {
    configuration.steps['state-provisioning'].execute.arguments.push('--action', 'plan');
  });
  assert.throws(() => orchestratorFor(
    duplicateAction.configurationPath,
    successfulRunner(),
  ).plan(), /invocation_policy_mismatch/);

  const unboundAuthorityPath = fixture(t, ({ configuration }) => {
    const invocation = configuration.steps['online-transition'].execute;
    invocation.arguments[invocation.arguments.indexOf('--authority-process-config') + 1]
      = '/tmp/unbound-online-authority.json';
  });
  assert.throws(() => orchestratorFor(
    unboundAuthorityPath.configurationPath,
    successfulRunner(),
  ).plan(), /argument_reference_mismatch/);

  const mismatchedChildIdentity = fixture(t, ({ configuration }) => {
    const invocation = configuration.steps['state-provisioning'].execute;
    invocation.arguments[invocation.arguments.indexOf('--plan-id') + 1]
      = `sha256:${'f'.repeat(64)}`;
  });
  assert.throws(() => orchestratorFor(
    mismatchedChildIdentity.configurationPath,
    successfulRunner(),
  ).plan(), /child_idempotency_mismatch/);

  const mismatchedTransitionIdentity = fixture(t, ({ configuration }) => {
    configuration.steps['state-provisioning'].verify.assertions.find((assertion) => (
      assertion.path === '/plan/transitionId'
    )).equals = `sha256:${'e'.repeat(64)}`;
  });
  assert.throws(() => orchestratorFor(
    mismatchedTransitionIdentity.configurationPath,
    successfulRunner(),
  ).plan(), /online_transition_id_binding_mismatch/);

  const expandedDispatcherScope = fixture(t, ({ configuration }) => {
    configuration.steps['submission-dispatcher'].execute.arguments.push(
      '--campaign-id',
      'unbound-campaign',
    );
  });
  assert.throws(() => orchestratorFor(
    expandedDispatcherScope.configurationPath,
    successfulRunner(),
  ).plan(), /argument_grammar_invalid/);

  const mismatchedProductionPaper = fixture(t, ({ configuration }) => {
    const invocation = configuration.steps['generic-domain-capability-convergence'].execute;
    invocation.arguments[invocation.arguments.indexOf('--paper-id') + 1]
      = 'different-production-paper';
    invocation.assertions.find((item) => item.path === '/paperId').equals
      = 'different-production-paper';
  });
  assert.throws(() => orchestratorFor(
    mismatchedProductionPaper.configurationPath,
    successfulRunner(),
  ).plan(), /production_paper_binding_invalid/);
});
