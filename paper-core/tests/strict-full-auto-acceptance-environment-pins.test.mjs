import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { StrictFullAutoAcceptanceCommandRunner } from '../../paper-adapters/automation/strict-full-auto-acceptance-command-runner.mjs';
import {
  strictFullAutoAcceptanceFixture as fixture,
  strictFullAutoAcceptanceOrchestratorFor as orchestratorFor,
  strictFullAutoAcceptanceSuccessfulOutput as successfulOutput,
  strictFullAutoAcceptanceSuccessfulRunner as successfulRunner,
} from './support/strict-full-auto-acceptance-fixture.mjs';

test('readiness child profile carries pinned prior-art and replay configuration hashes', (t) => {
  const value = fixture(t);
  const plan = orchestratorFor(value.configurationPath, successfulRunner()).plan();
  const runtimeEnvironment = plan.steps.find((step) => (
    step.stepId === 'runtime-reproducibility'
  )).verify.environmentReferences;
  assert.equal(
    runtimeEnvironment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH,
    'runtime-reproducibility-principal',
  );
  const readinessEnvironment = plan.steps.find((step) => (
    step.stepId === 'online-transition'
  )).verify.environmentReferences;
  assert.equal(
    readinessEnvironment.HEPTA_PRIOR_ART_SERVICE_CONFIG_HASH,
    'prior-art-service-config',
  );
  assert.equal(
    readinessEnvironment.HEPTA_EXTERNAL_REPLAY_CONFIG_HASH,
    'external-replay-config',
  );
});

test('runtime reproducibility runner receives the resolved identity pin, never ambient state',
  async (t) => {
    const value = fixture(t);
    const plan = orchestratorFor(value.configurationPath, successfulRunner()).plan();
    const step = plan.steps.find((candidate) => candidate.stepId === 'runtime-reproducibility');
    const captured = [];
    const runner = new StrictFullAutoAcceptanceCommandRunner({
      workspaceRoot: path.resolve('.'),
      environment: {
        PATH: process.env.PATH,
        HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH: 'ambient-wrong',
      },
      runProcess: async (request) => {
        captured.push(request);
        return {
          exitCode: 0,
          timedOut: false,
          aborted: false,
          outputTruncated: false,
          stdout: JSON.stringify(successfulOutput(request.invocation || step.verify)),
        };
      },
    });
    await runner.run({ plan, step, phase: 'verify', invocation: step.verify });
    assert.equal(
      captured[0].env.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH,
      value.configuration.references['runtime-reproducibility-principal']
        .expectedConfigurationIdentityHash,
    );
  });
