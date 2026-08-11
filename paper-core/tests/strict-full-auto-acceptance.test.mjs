import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { StrictFullAutoAcceptanceRepository } from '../../paper-adapters/automation/strict-full-auto-acceptance-repository.mjs';
import { StrictFullAutoAcceptanceCommandRunner } from '../../paper-adapters/automation/strict-full-auto-acceptance-command-runner.mjs';
import { StrictFullAutoAcceptanceOrchestrator } from '../../paper-application/automation/strict-full-auto-acceptance-orchestrator.mjs';
import {
  RECOVERY_REEXECUTION_SAFE_STEPS,
} from '../../paper-application/automation/strict-full-auto-acceptance-state.mjs';
import {
  STRICT_FULL_AUTO_ACCEPTANCE_REFERENCE_POLICY,
  STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER,
  strictFullAutoAcceptanceHash,
} from '../../paper-domain/automation/strict-full-auto-acceptance-contract.mjs';
import {
  parseStrictFullAutoAcceptanceArguments,
  runStrictFullAutoAcceptance,
} from '../bin/strict-full-auto-acceptance.mjs';
import {
  STRICT_FULL_AUTO_ACCEPTANCE_TEST_NOW as NOW,
  sha256File,
  strictFullAutoAcceptanceFixture as fixture,
  strictFullAutoAcceptanceNotReadyOutput as notReadyOutput,
  strictFullAutoAcceptanceOrchestratorFor as orchestratorFor,
  strictFullAutoAcceptanceProductionRunnerBindingTest,
  strictFullAutoAcceptanceRuntimeActivatingRunner as runtimeActivatingRunner,
  strictFullAutoAcceptanceSuccessfulOutput as successfulOutput,
  strictFullAutoAcceptanceSuccessfulRunner as successfulRunner,
} from './support/strict-full-auto-acceptance-fixture.mjs';

test('systemd convergence retries unattended without receiving portal secrets', () => {
  const unit = fs.readFileSync(new URL(
    '../deploy/strict-full-auto-acceptance.service', import.meta.url,
  ), 'utf8');
  const environment = fs.readFileSync(new URL(
    '../deploy/strict-full-auto-acceptance.env.example', import.meta.url,
  ), 'utf8');
  const timer = fs.readFileSync(new URL(
    '../deploy/strict-full-auto-acceptance.timer', import.meta.url,
  ), 'utf8');
  assert.match(unit, /strict-full-auto-acceptance -- --action converge/);
  assert.match(unit, /--execute --require-accepted/);
  assert.doesNotMatch(unit, /--plan-hash/);
  assert.match(unit, /^Restart=on-failure$/m);
  for (const requiredPath of [
    '/opt/hepta-paper/paper-core/bin/hepta-paper.mjs',
    '/etc/hepta-paper/strict-full-auto-acceptance.env',
    '/etc/hepta-paper/autonomous-research-provider.secrets.env',
    '/srv/hepta-paper/assets',
    '/srv/hepta-paper/datasets',
    '/run/hepta-authority',
    '/etc/hepta-paper/authority-rotation',
    '/etc/hepta-paper/capabilities-public',
    '/etc/hepta-paper/online-mutation-authority',
    '/etc/hepta-paper/state-backup-authority',
    '/etc/hepta-paper/release-attestor',
    '/etc/hepta-paper/submission-portal',
    '/etc/hepta-paper/submission-dispatcher-signer',
    '/etc/hepta-paper/autonomous-submission-dispatcher.secrets.env',
    '/var/lib/hepta-paper',
    '/run/hepta',
  ]) {
    assert.ok(unit.split('\n').includes(`ConditionPathExists=${requiredPath}`));
  }
  assert.doesNotMatch(unit, /^StartLimitIntervalSec=0$/m);
  assert.match(unit, /^StartLimitIntervalSec=15min$/m);
  assert.match(unit, /^StartLimitBurst=5$/m);
  assert.match(unit, /^TimeoutStartSec=24h$/m);
  assert.doesNotMatch(unit, /^RemainAfterExit=yes$/m);
  assert.match(unit, /autonomous-research-supervisor\.service/);
  assert.match(unit, /autonomous-submission-dispatcher\.service/);
  assert.doesNotMatch(unit, /EnvironmentFile=.*autonomous-submission-dispatcher\.secrets\.env/);
  assert.match(unit, /InaccessiblePaths=.*autonomous-submission-dispatcher\.secrets\.env/);
  assert.doesNotMatch(unit,
    /^InaccessiblePaths=.*(?:^|\s)-\/etc\/hepta-paper\/(?:submission-portal|submission-dispatcher-signer|autonomous-submission-dispatcher\.secrets\.env)/m);
  assert.match(unit, /^ReadOnlyPaths=.*\/srv\/hepta-paper\/datasets(?:\s|$)/m);
  assert.doesNotMatch(unit, /^ReadWritePaths=.*\/srv\/hepta-paper\/datasets(?:\s|$)/m);
  assert.doesNotMatch(unit, /\/srv\/hepta-paper\/assets\/datasets/);
  assert.equal(environment.trim(),
    'HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_CONFIGURATION=/run/hepta/strict-full-auto-acceptance.json');
  assert.match(timer, /^OnBootSec=2min$/m);
  assert.match(timer, /^OnUnitInactiveSec=5min$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^Unit=strict-full-auto-acceptance\.service$/m);
});

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
  const genericStep = first.steps.find((step) => (
    step.stepId === 'generic-domain-capability-convergence'
  ));
  assert.equal(genericStep.execute.assertions.some((assertion) => (
    assertion.path === '/snapshotCurrent' && assertion.equals === true
  )), true);
  assert.equal(genericStep.verify.assertions.some((assertion) => (
    assertion.path === '/snapshotCurrent' && assertion.equals === true
  )), true);
  assert.equal(RECOVERY_REEXECUTION_SAFE_STEPS.has(
    'generic-domain-capability-convergence',
  ), false);
  assert.equal(fs.existsSync(path.join(value.controlRoot, 'state.json')), false);
});

test('strict acceptance requires v3 KMS authority and preflights its pinned bundle', (t) => {
  const downgraded = fixture(t, ({ configuration }) => {
    const reference = configuration.references['release-attestor-config'];
    const release = JSON.parse(fs.readFileSync(reference.path, 'utf8'));
    release.version = 2;
    delete release.hardwareAuthorityAttestation;
    fs.chmodSync(reference.path, 0o600);
    fs.writeFileSync(reference.path, `${JSON.stringify(release)}\n`);
    fs.chmodSync(reference.path, 0o400);
  });
  assert.throws(
    () => orchestratorFor(
      downgraded.configurationPath,
      successfulRunner(),
    ).plan(),
    /strict_full_auto_acceptance_release_attestor_config_invalid/,
  );

  const substituted = fixture(t);
  const releaseReference =
    substituted.configuration.references['release-attestor-config'];
  const release = JSON.parse(fs.readFileSync(releaseReference.path, 'utf8'));
  fs.chmodSync(release.hardwareAuthorityAttestation.bundlePath, 0o644);
  fs.writeFileSync(
    release.hardwareAuthorityAttestation.bundlePath,
    '{"substituted":true}\n',
  );
  fs.chmodSync(release.hardwareAuthorityAttestation.bundlePath, 0o444);
  assert.throws(
    () => orchestratorFor(
      substituted.configurationPath,
      successfulRunner(),
    ).plan(),
    /strict_full_auto_acceptance_release_attestor_config_invalid/,
  );
});

test('short-lived author and KMS evidence rotates beneath stable acceptance pins', (t) => {
  const value = fixture(t);
  const service = orchestratorFor(value.configurationPath, successfulRunner());
  const authorReference =
    value.configuration.references['research-author-identity-config'];
  const releaseReference =
    value.configuration.references['release-attestor-config'];
  const release = JSON.parse(fs.readFileSync(releaseReference.path, 'utf8'));
  const originalRawHashes = {
    author: sha256File(authorReference.path),
    release: sha256File(releaseReference.path),
    bundle: sha256File(release.hardwareAuthorityAttestation.bundlePath),
  };
  const first = service.plan();

  value.rotateAuthorIdentity();
  const rotatedRelease = value.rotateReleaseHardwareAuthority();
  const second = service.plan();

  assert.equal(second.planHash, first.planHash);
  for (const referenceId of [
    'research-author-identity-config',
    'release-attestor-config',
  ]) {
    const before = first.referenceBindings.find((item) => item.referenceId === referenceId);
    const after = second.referenceBindings.find((item) => item.referenceId === referenceId);
    assert.equal(after.identity, before.identity);
    assert.equal(after.contentHash, before.contentHash);
    assert.deepEqual(after.documentPins, before.documentPins);
  }
  assert.notEqual(sha256File(authorReference.path), originalRawHashes.author);
  assert.equal(rotatedRelease.configurationFileHash, originalRawHashes.release);
  assert.notEqual(rotatedRelease.bundleHash, originalRawHashes.bundle);

  const driftedAuthor = JSON.parse(fs.readFileSync(authorReference.path, 'utf8'));
  driftedAuthor.identityPolicy.providerAccountIdentityHash =
    strictFullAutoAcceptanceHash({ fixture: 'author-stable-policy-drift' });
  fs.chmodSync(authorReference.path, 0o600);
  fs.writeFileSync(authorReference.path, `${JSON.stringify(driftedAuthor, null, 2)}\n`);
  fs.chmodSync(authorReference.path, 0o444);
  assert.throws(
    () => service.plan(),
    /strict_full_auto_acceptance_document_pin_invalid:research-author-identity-config/,
  );
});

test('stable author and KMS policy drift is rejected before strict actions', (t) => {
  const releaseDrift = fixture(t);
  const releaseReference =
    releaseDrift.configuration.references['release-attestor-config'];
  const release = JSON.parse(fs.readFileSync(releaseReference.path, 'utf8'));
  release.backend.backendId = 'strict-release-kms-substituted';
  fs.chmodSync(releaseReference.path, 0o600);
  fs.writeFileSync(releaseReference.path, `${JSON.stringify(release, null, 2)}\n`);
  fs.chmodSync(releaseReference.path, 0o400);
  assert.throws(
    () => orchestratorFor(
      releaseDrift.configurationPath,
      successfulRunner(),
    ).plan(),
    /strict_full_auto_acceptance_release_attestor_config_invalid/,
  );
  assert.equal(fs.existsSync(path.join(releaseDrift.controlRoot, 'state.json')), false);

  const duplicateRawPin = fixture(t, ({ configuration }) => {
    const author = configuration.references['research-author-identity-config'];
    author.expectedSha256 = sha256File(author.path);
  });
  assert.throws(
    () => orchestratorFor(
      duplicateRawPin.configurationPath,
      successfulRunner(),
    ).plan(),
    /strict_full_auto_acceptance_reference_configuration_invalid:research-author-identity-config/,
  );
  assert.equal(fs.existsSync(path.join(duplicateRawPin.controlRoot, 'state.json')), false);
});

test('plan permits author and reviewer subagents to share one provider credential root', (t) => {
  const value = fixture(t);
  const service = orchestratorFor(value.configurationPath, successfulRunner());
  const plan = service.plan();
  const stateProvisioning = plan.steps.find((step) => (
    step.stepId === 'state-provisioning'
  ));
  assert.equal(
    stateProvisioning.execute.environmentReferences
      .HEPTA_RESEARCH_AUTHOR_CODEX_HOME,
    'research-author-credential-root',
  );
  assert.equal(
    stateProvisioning.execute.environmentReferences
      .HEPTA_FORMAL_REVIEW_CODEX_HOME,
    'research-author-credential-root',
  );
  assert.equal(
    plan.referenceBindings.some((reference) => (
      reference.referenceId === 'formal-reviewer-credential-root'
    )),
    false,
  );
});

test('configuration path is revalidated and never followed after loader construction', (t) => {
  const value = fixture(t);
  const calls = [];
  const service = orchestratorFor(value.configurationPath, successfulRunner(calls));
  const replacement = path.join(value.root, 'replacement-acceptance-config.json');
  fs.copyFileSync(value.configurationPath, replacement);
  fs.chmodSync(replacement, 0o444);
  fs.unlinkSync(value.configurationPath);
  fs.symlinkSync(replacement, value.configurationPath);
  assert.throws(
    () => service.plan(),
    /strict_full_auto_acceptance_reference_not_regular:configuration/,
  );
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(value.controlRoot, 'state.json')), false);
});

test('private authority validation cannot parse content from a replacement reference inode',
  (t) => {
    const value = fixture(t);
    const calls = [];
    const service = orchestratorFor(value.configurationPath, successfulRunner(calls));
    const selected = value.configuration.references['empirical-plugin-signing-config'].path;
    const replacement = path.join(value.referenceRoot, 'replacement-empirical-config.ref');
    fs.writeFileSync(
      replacement,
      `${fs.readFileSync(selected, 'utf8')}\n`,
      { mode: 0o400 },
    );
    const originalLstatSync = fs.lstatSync;
    let selectedInspectionCount = 0;
    fs.lstatSync = (candidate, ...arguments_) => {
      if (candidate === selected && (selectedInspectionCount += 1) === 2) {
        fs.renameSync(replacement, selected);
      }
      return originalLstatSync(candidate, ...arguments_);
    };
    try {
      assert.throws(
        () => service.plan(),
        /strict_full_auto_acceptance_bound_reference_changed:empirical-plugin-signing-config/,
      );
    } finally {
      fs.lstatSync = originalLstatSync;
    }
    assert.equal(calls.length, 0);
    assert.equal(fs.existsSync(path.join(value.controlRoot, 'state.json')), false);
  });

test('read-only roots require trusted ownership, effective read/traverse and no write access',
  (t) => {
    const value = fixture(t);
    const service = orchestratorFor(value.configurationPath, successfulRunner());
    assert.equal(service.plan().rootBindings.find((binding) => (
      binding.rootId === 'asset-root'
    )).anchorMode, 0o500);
    for (const [candidate, mode] of [
      [value.assetRoot, 0o700],
      [value.datasetRoot, 0o100],
      [value.assetRoot, 0o520],
      [value.datasetRoot, 0o502],
    ]) {
      fs.chmodSync(candidate, mode);
      assert.throws(
        () => service.plan(),
        /strict_full_auto_acceptance_root_anchor_invalid/,
      );
      fs.chmodSync(candidate, 0o500);
    }
    assert.equal(fs.existsSync(path.join(value.controlRoot, 'state.json')), false);
  });

test('execute and status revalidate read-only root bindings before state or verifier actions',
  async (t) => {
    const beforeExecute = fixture(t);
    const executeCalls = [];
    const executing = orchestratorFor(
      beforeExecute.configurationPath,
      successfulRunner(executeCalls),
    );
    const plan = executing.plan();
    fs.chmodSync(beforeExecute.assetRoot, 0o700);
    await assert.rejects(
      executing.execute({ expectedPlanHash: plan.planHash }),
      /strict_full_auto_acceptance_root_anchor_invalid/,
    );
    assert.equal(executeCalls.length, 0);
    assert.equal(fs.existsSync(path.join(beforeExecute.controlRoot, 'state.json')), false);

    const beforeStatus = fixture(t);
    const statusCalls = [];
    const completed = orchestratorFor(
      beforeStatus.configurationPath,
      successfulRunner(statusCalls),
    );
    const completedPlan = completed.plan();
    await completed.execute({ expectedPlanHash: completedPlan.planHash });
    const callsBeforeDriftedStatus = statusCalls.length;
    fs.chmodSync(beforeStatus.datasetRoot, 0o100);
    await assert.rejects(
      completed.status(),
      /strict_full_auto_acceptance_root_anchor_invalid/,
    );
    assert.equal(statusCalls.length, callsBeforeDriftedStatus);
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
    const online = configuration.references['online-state-authority-principal'];
    const qualifier = configuration.references['external-qualifier-principal'];
    fs.chmodSync(online.path, 0o644);
    fs.copyFileSync(qualifier.path, online.path);
    fs.chmodSync(online.path, 0o444);
    online.expectedSha256 = sha256File(online.path);
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

test('a completed plan renews only a typed stale renewable step and appends its intent',
  async (t) => {
    const value = fixture(t);
    const repository = new StrictFullAutoAcceptanceRepository({
      configurationPath: value.configurationPath,
    });
    const calls = [];
    let submissionStale = false;
    const service = new StrictFullAutoAcceptanceOrchestrator({
      repository,
      commandRunner: runtimeActivatingRunner({
        async run({ step, phase, invocation }) {
          calls.push(`${step.stepId}:${phase}`);
          if (step.stepId === 'submission-dispatcher' && phase === 'verify'
            && submissionStale) {
            return notReadyOutput(invocation);
          }
          if (step.stepId === 'submission-dispatcher' && phase === 'execute') {
            submissionStale = false;
          }
          return successfulOutput(invocation);
        },
      }),
      now: () => NOW,
    });
    const plan = service.plan();
    await service.execute({ expectedPlanHash: plan.planHash });
    const initialExecuteCounts = Object.fromEntries(plan.steps.map((step) => [
      step.stepId,
      calls.filter((item) => item === `${step.stepId}:execute`).length,
    ]));
    submissionStale = true;
    const renewed = await service.execute({ expectedPlanHash: plan.planHash });
    assert.equal(renewed.strictFullAutoAccepted, true);
    for (const step of plan.steps) {
      const observed = calls.filter((item) => item === `${step.stepId}:execute`).length;
      assert.equal(
        observed,
        initialExecuteCounts[step.stepId] + (step.stepId === 'submission-dispatcher' ? 1 : 0),
        step.stepId,
      );
    }
    const renewalDirectory = path.join(repository.controlStore.planScopePath(plan), 'renewals');
    assert.deepEqual(
      fs.readdirSync(renewalDirectory).map((name) => name.replace(/^[0-9]+-/, '')),
      ['submission-dispatcher.json'],
    );
    assert.ok(fs.readdirSync(path.join(
      repository.controlStore.planScopePath(plan), 'live-receipts',
    )).length >= 1);
  });

test('infrastructure failure on a renewable verifier never dispatches renewal action',
  async (t) => {
    const value = fixture(t);
    const repository = new StrictFullAutoAcceptanceRepository({
      configurationPath: value.configurationPath,
    });
    const initial = new StrictFullAutoAcceptanceOrchestrator({
      repository,
      commandRunner: successfulRunner(),
      now: () => NOW,
    });
    const plan = initial.plan();
    await initial.execute({ expectedPlanHash: plan.planHash });
    const calls = [];
    const failing = new StrictFullAutoAcceptanceOrchestrator({
      repository,
      commandRunner: {
        async run({ step, phase, invocation }) {
          calls.push(`${step.stepId}:${phase}`);
          if (step.stepId === 'submission-dispatcher' && phase === 'verify') {
            const error = new Error('fixture_verifier_transport_failed');
            error.code = 'STRICT_FULL_AUTO_ACCEPTANCE_INFRASTRUCTURE_FAILURE';
            throw error;
          }
          return successfulOutput(invocation);
        },
      },
      now: () => NOW,
    });
    await assert.rejects(
      failing.execute({ expectedPlanHash: plan.planHash }),
      /fixture_verifier_transport_failed/,
    );
    assert.equal(calls.includes('submission-dispatcher:execute'), false);

    const nonRenewableCalls = [];
    const nonRenewable = new StrictFullAutoAcceptanceOrchestrator({
      repository,
      commandRunner: {
        async run({ step, phase, invocation }) {
          nonRenewableCalls.push(`${step.stepId}:${phase}`);
          if (step.stepId === 'migration' && phase === 'verify') {
            return notReadyOutput(invocation);
          }
          return successfulOutput(invocation);
        },
      },
      now: () => NOW,
    });
    await assert.rejects(
      nonRenewable.execute({ expectedPlanHash: plan.planHash }),
      /assertion_failed:migration/,
    );
    assert.equal(nonRenewableCalls.includes('migration:execute'), false);
  });

test('a stale final live verifier is retried without replacing the checkpoint or replaying steps',
  async (t) => {
    const value = fixture(t);
    const repository = new StrictFullAutoAcceptanceRepository({
      configurationPath: value.configurationPath,
    });
    const calls = [];
    let finalStaleRemaining = 0;
    const service = new StrictFullAutoAcceptanceOrchestrator({
      repository,
      commandRunner: runtimeActivatingRunner({
        async run({ step, phase, invocation }) {
          calls.push(`${step.stepId}:${phase}`);
          if (step.stepId === 'final-aggregate-live-verification'
            && phase === 'verify' && finalStaleRemaining > 0) {
            finalStaleRemaining -= 1;
            return notReadyOutput(invocation);
          }
          return successfulOutput(invocation);
        },
      }),
      now: () => NOW,
    });
    const plan = service.plan();
    const initial = await service.execute({ expectedPlanHash: plan.planHash });
    const checkpointHash = initial.receipt.receiptHash;
    const executeCount = calls.filter((item) => item.endsWith(':execute')).length;
    const finalCount = calls.filter((item) => (
      item === 'final-aggregate-live-verification:verify'
    )).length;
    finalStaleRemaining = 1;
    const recovered = await service.execute({ expectedPlanHash: plan.planHash });
    assert.equal(recovered.strictFullAutoAccepted, true);
    assert.equal(recovered.receipt.receiptHash, checkpointHash);
    assert.equal(calls.filter((item) => item.endsWith(':execute')).length, executeCount);
    assert.equal(calls.filter((item) => (
      item === 'final-aggregate-live-verification:verify'
    )).length - finalCount, 2);
  });

test('plan hashes isolate control state and a live-verified successor permanently supersedes its base',
  async (t) => {
    const value = fixture(t);
    const configurationB = structuredClone(value.configuration);
    configurationB.steps['generic-domain-capability-convergence'].idempotencyKey =
      `sha256:${'9'.repeat(64)}`;
    const configurationPathB = path.join(value.root, 'acceptance-config-b.json');
    fs.writeFileSync(
      configurationPathB,
      `${JSON.stringify(configurationB, null, 2)}\n`,
      { mode: 0o444 },
    );
    const callsA = [];
    const repositoryA = new StrictFullAutoAcceptanceRepository({
      configurationPath: value.configurationPath,
    });
    const serviceA = new StrictFullAutoAcceptanceOrchestrator({
      repository: repositoryA,
      commandRunner: successfulRunner(callsA),
      now: () => NOW,
    });
    const planA = serviceA.plan();
    await serviceA.execute({ expectedPlanHash: planA.planHash });

    const callsB = [];
    const repositoryB = new StrictFullAutoAcceptanceRepository({
      configurationPath: configurationPathB,
    });
    const serviceB = new StrictFullAutoAcceptanceOrchestrator({
      repository: repositoryB,
      commandRunner: successfulRunner(callsB),
      now: () => NOW,
    });
    const planB = serviceB.plan();
    assert.notEqual(planA.planHash, planB.planHash);
    const completedB = await serviceB.execute({ expectedPlanHash: planB.planHash });
    assert.equal(completedB.strictFullAutoAccepted, true);
    assert.notEqual(repositoryA.statePath(planA), repositoryB.statePath(planB));
    assert.match(repositoryA.statePath(planA), new RegExp(
      `/plans/${planA.planHash.slice('sha256:'.length)}/state\\.json$`,
    ));
    assert.match(repositoryB.statePath(planB), new RegExp(
      `/plans/${planB.planHash.slice('sha256:'.length)}/state\\.json$`,
    ));
    const callsBeforeSupersededStatus = callsA.length;
    const superseded = await serviceA.status();
    assert.equal(superseded.status, 'superseded');
    assert.equal(superseded.strictFullAutoAccepted, false);
    assert.equal(superseded.supersededByPlanHash, planB.planHash);
    assert.equal(callsA.length, callsBeforeSupersededStatus);
    await assert.rejects(
      serviceA.execute({ expectedPlanHash: planA.planHash }),
      /superseded_plan_reactivation_forbidden/,
    );
  });

test('legacy flat complete checkpoints remain readable and converge without replaying actions',
  async (t) => {
    const value = fixture(t);
    const repository = new StrictFullAutoAcceptanceRepository({
      configurationPath: value.configurationPath,
    });
    const initialCalls = [];
    const initial = new StrictFullAutoAcceptanceOrchestrator({
      repository,
      commandRunner: successfulRunner(initialCalls),
      now: () => NOW,
    });
    const plan = initial.plan();
    await initial.execute({ expectedPlanHash: plan.planHash });
    const scope = repository.controlStore.planScopePath(plan);
    const documents = Object.fromEntries([
      ['state.json', 'state.json'],
      ['acceptance-receipt.json', 'acceptance-receipt.json'],
      ['runtime-root-activation.json', 'runtime-root-activation.json'],
    ].map(([name, target]) => [
      target,
      fs.readFileSync(path.join(scope, name), 'utf8'),
    ]));
    fs.rmSync(scope, { recursive: true });
    for (const [name, bytes] of Object.entries(documents)) {
      fs.writeFileSync(path.join(value.controlRoot, name), bytes, { mode: 0o600 });
    }
    fs.unlinkSync(path.join(value.controlRoot, 'active-plan.json'));

    const calls = [];
    const legacy = new StrictFullAutoAcceptanceOrchestrator({
      repository,
      commandRunner: successfulRunner(calls),
      now: () => NOW,
    });
    const status = await legacy.status();
    assert.equal(status.strictFullAutoAccepted, true);
    const beforeExecute = calls.filter((item) => item.endsWith(':execute')).length;
    const converged = await legacy.execute({ expectedPlanHash: plan.planHash });
    assert.equal(converged.strictFullAutoAccepted, true);
    assert.equal(
      calls.filter((item) => item.endsWith(':execute')).length,
      beforeExecute,
    );
    assert.equal(repository.statePath(plan), path.join(value.controlRoot, 'state.json'));
    assert.equal(
      JSON.parse(fs.readFileSync(
        path.join(value.controlRoot, 'active-plan.json'),
        'utf8',
      )).activePlanHash,
      plan.planHash,
    );
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

test('configuration or authority drift selects a new isolated candidate checkpoint', async (t) => {
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
  const publicReference =
    value.configuration.references['online-state-authority-principal'];
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
  const drifted = await service.status();
  assert.equal(drifted.status, 'not-started');
  assert.equal(drifted.completedStepCount, 0);
  assert.equal(drifted.strictFullAutoAccepted, false);
  assert.notEqual(drifted.planHash, plan.planHash);
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

test(
  'production runner binds the exact plan invocation, reference paths and idempotency identity',
  strictFullAutoAcceptanceProductionRunnerBindingTest,
);

test('production runner distinguishes typed JSON not-ready from infrastructure failure',
  async (t) => {
    const value = fixture(t);
    const plan = orchestratorFor(value.configurationPath, successfulRunner()).plan();
    const step = plan.steps.find((item) => item.stepId === 'state-provisioning');
    const controller = new AbortController();
    const result = (stdout, overrides = {}) => ({
      exitCode: 2,
      timedOut: false,
      aborted: false,
      outputTruncated: false,
      stdout: JSON.stringify(stdout),
      ...overrides,
    });
    const notReadyRunner = new StrictFullAutoAcceptanceCommandRunner({
      workspaceRoot: path.resolve('.'),
      runProcess: async () => result(notReadyOutput(step.verify)),
    });
    await assert.rejects(
      notReadyRunner.run({
        plan, step, phase: 'verify', invocation: step.verify,
        signal: controller.signal,
      }),
      (error) => error.code === 'STRICT_FULL_AUTO_ACCEPTANCE_NOT_READY',
    );

    const contradictoryRunner = new StrictFullAutoAcceptanceCommandRunner({
      workspaceRoot: path.resolve('.'),
      runProcess: async () => result(successfulOutput(step.verify)),
    });
    await assert.rejects(
      contradictoryRunner.run({
        plan, step, phase: 'verify', invocation: step.verify,
        signal: controller.signal,
      }),
      (error) => error.code === 'STRICT_FULL_AUTO_ACCEPTANCE_INFRASTRUCTURE_FAILURE',
    );

    const fatalRunner = new StrictFullAutoAcceptanceCommandRunner({
      workspaceRoot: path.resolve('.'),
      runProcess: async () => result({ ready: false, fatal: 'database unavailable' }, {
        exitCode: 1,
      }),
    });
    await assert.rejects(
      fatalRunner.run({
        plan, step, phase: 'verify', invocation: step.verify,
        signal: controller.signal,
      }),
      (error) => error.code === 'STRICT_FULL_AUTO_ACCEPTANCE_INFRASTRUCTURE_FAILURE',
    );

    const incompleteSemanticRunner = new StrictFullAutoAcceptanceCommandRunner({
      workspaceRoot: path.resolve('.'),
      runProcess: async () => result({ ready: false }),
    });
    await assert.rejects(
      incompleteSemanticRunner.run({
        plan, step, phase: 'verify', invocation: step.verify,
        signal: controller.signal,
      }),
      (error) => error.code === 'STRICT_FULL_AUTO_ACCEPTANCE_INFRASTRUCTURE_FAILURE',
    );

    const timedOutRunner = new StrictFullAutoAcceptanceCommandRunner({
      workspaceRoot: path.resolve('.'),
      runProcess: async () => result({}, { timedOut: true }),
    });
    await assert.rejects(
      timedOutRunner.run({
        plan, step, phase: 'verify', invocation: step.verify,
        signal: controller.signal,
      }),
      (error) => error.code === 'STRICT_FULL_AUTO_ACCEPTANCE_INFRASTRUCTURE_FAILURE',
    );
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

  const missingFormalClosure = fixture(t, ({ configuration }) => {
    delete configuration.operationalEnvironment
      .HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH;
  });
  assert.throws(() => orchestratorFor(
    missingFormalClosure.configurationPath,
    successfulRunner(),
  ).plan(), /operational_environment_invalid/);

  const escapedFormalProject = fixture(t, ({ configuration }) => {
    configuration.operationalEnvironment.HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT =
      '/srv/unbound-formal-project';
  });
  assert.throws(() => orchestratorFor(
    escapedFormalProject.configurationPath,
    successfulRunner(),
  ).plan(), /operational_environment_incomplete/);
});
