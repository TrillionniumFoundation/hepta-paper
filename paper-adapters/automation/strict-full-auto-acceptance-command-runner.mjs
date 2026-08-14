import fs from 'node:fs';
import path from 'node:path';

import {
  restrictedChildEnvironment,
  runBoundedChildProcess,
} from './bounded-child-process.mjs';
import {
  STRICT_FULL_AUTO_ACCEPTANCE_FINAL_VERIFICATION_STEP_ID,
  strictFullAutoAcceptanceHash,
  strictFullAutoAcceptanceJsonEqual,
} from '../../paper-domain/automation/strict-full-auto-acceptance-contract.mjs';
import {
  inspectInstalledAutonomousEmpiricalPluginRelease,
} from './autonomous-empirical-plugin-release-repository.mjs';

const COMMANDS = Object.freeze({
  'automation-status': 'paper-core/bin/automation-status.mjs',
  'autonomous-empirical-plugin-release': 'paper-core/bin/autonomous-empirical-plugin-release.mjs',
  'autonomous-research': 'paper-core/bin/autonomous-research-readiness.mjs',
  'autonomous-state-backup': 'paper-core/bin/autonomous-research-state-backup.mjs',
  'autonomous-state-provision': 'paper-core/bin/autonomous-research-state-provision.mjs',
  'autonomous-online-transition': 'paper-core/bin/autonomous-research-online-schema-transition.mjs',
  'autonomous-supervisor': 'paper-core/bin/autonomous-research-supervisor.mjs',
  'autonomous-supervisor-health': 'paper-core/bin/autonomous-research-supervisor-health.mjs',
  'generic-domain-capability-evidence':
    'paper-core/bin/generic-domain-capability-evidence.mjs',
  'autonomous-submission-dispatcher': 'paper-core/bin/autonomous-submission-dispatcher.mjs',
  'autonomous-submission-dispatcher-challenge':
    'paper-core/bin/autonomous-submission-dispatcher-challenge.mjs',
  'runtime-image-reproducibility': 'paper-core/bin/runtime-image-reproducibility.mjs',
  'store': 'paper-core/bin/hepta-store.mjs',
});

// A configured reproducibility verifier may legitimately use the full four-hour
// child budget. Keep a bounded grace window for result validation and teardown.
const DEFAULT_EXECUTION_TIMEOUT_MS = (4 * 60 * 60 + 15 * 60) * 1000;
// Exit 2 is reserved by every plan-bound verifier for a successfully produced,
// semantically complete observation that is not ready yet. Exit 1 (and every
// other non-zero code) is an infrastructure or policy failure and must never
// authorize a mutating renewal.
const SEMANTIC_NOT_READY_EXIT_CODE = 2;
const PORTAL_DESCRIPTOR_HASH_ENVIRONMENT_VARIABLE =
  'HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH';

const STEP_COMMANDS = Object.freeze({
  migration: new Set(['store']),
  'state-provisioning': new Set([
    'autonomous-state-provision', 'autonomous-online-transition',
  ]),
  'online-transition': new Set(['autonomous-online-transition', 'automation-status']),
  'runtime-reproducibility': new Set(['runtime-image-reproducibility', 'automation-status']),
  'advanced-numeric-activation': new Set(['autonomous-empirical-plugin-release', 'automation-status']),
  'provider-canaries': new Set(['automation-status']),
  'external-qualifier': new Set(['automation-status', 'autonomous-research']),
  'release-attestor-challenge': new Set(['automation-status']),
  'machine-intake': new Set(['autonomous-supervisor', 'autonomous-supervisor-health']),
  'resident-supervisor': new Set(['autonomous-supervisor', 'autonomous-supervisor-health']),
  'golden-qualification': new Set(['autonomous-research', 'automation-status']),
  'production-campaign-qualification': new Set(['autonomous-supervisor', 'automation-status']),
  'generic-domain-capability-convergence': new Set(['generic-domain-capability-evidence']),
  'restore-drill': new Set(['autonomous-state-backup', 'automation-status']),
  'submission-dispatcher': new Set(['autonomous-submission-dispatcher-challenge']),
  [STRICT_FULL_AUTO_ACCEPTANCE_FINAL_VERIFICATION_STEP_ID]: new Set(['automation-status']),
});

function parseChildJson(stdout, label) {
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    return parsed;
  } catch (error) {
    throw new Error(`strict_full_auto_acceptance_child_output_invalid:${label}`, { cause: error });
  }
}

function jsonPointer(value, pointer) {
  return pointer.split('/').slice(1).reduce((current, key) => (
    current && Object.prototype.hasOwnProperty.call(current, key) ? current[key] : undefined
  ), value);
}

function reportedSkipCount(value) {
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + reportedSkipCount(item), 0);
  }
  if (!value || typeof value !== 'object') return 0;
  return Object.entries(value).reduce((sum, [key, item]) => {
    if (['skipped', 'skipCount', 'skippedCount'].includes(key)
      && ((Number.isSafeInteger(item) && item > 0) || item === true)) {
      return sum + (item === true ? 1 : item);
    }
    return sum + reportedSkipCount(item);
  }, 0);
}

function isCompleteSemanticNotReadyOutput(output, invocation) {
  if (['error', 'errors', 'fatal', 'stack', 'exception'].some((key) => (
    Object.prototype.hasOwnProperty.call(output, key)
  ))) return false;
  return invocation.assertions.length > 0 && invocation.assertions.every((assertion) => (
    jsonPointer(output, assertion.path) !== undefined
  ));
}

export class StrictFullAutoAcceptanceCommandRunner {
  constructor({
    workspaceRoot,
    environment = process.env,
    executable = process.execPath,
    runProcess = runBoundedChildProcess,
    timeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS,
    verificationTimeoutMs = 15 * 60 * 1000,
  } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
      || !Number.isSafeInteger(verificationTimeoutMs) || verificationTimeoutMs < 1) {
      throw new Error('strict_full_auto_acceptance_timeout_invalid');
    }
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.environment = environment;
    this.executable = executable;
    this.runProcess = runProcess;
    this.timeoutMs = timeoutMs;
    this.verificationTimeoutMs = verificationTimeoutMs;
  }

  async run({ plan, step, phase, invocation, signal = null } = {}) {
    if (!STEP_COMMANDS[step?.stepId]?.has(invocation?.command)
      || !COMMANDS[invocation?.command]
      || !['execute', 'verify'].includes(phase)) {
      throw new Error(`strict_full_auto_acceptance_command_forbidden:${step?.stepId || 'missing'}`);
    }
    const plannedInvocation = step.stepId === STRICT_FULL_AUTO_ACCEPTANCE_FINAL_VERIFICATION_STEP_ID
      ? plan.finalVerification : step[phase];
    if (strictFullAutoAcceptanceHash(invocation)
      !== strictFullAutoAcceptanceHash(plannedInvocation)) {
      throw new Error(`strict_full_auto_acceptance_invocation_not_plan_bound:${step.stepId}:${phase}`);
    }
    const references = new Map(plan.referenceBindings.map((item) => [item.referenceId, item]));
    const overrides = Object.fromEntries(Object.entries(invocation.environmentReferences)
      .map(([name, referenceId]) => {
        const reference = references.get(referenceId);
        const value = name === PORTAL_DESCRIPTOR_HASH_ENVIRONMENT_VARIABLE
          ? reference?.documentPins?.portalDescriptorHash
          : name.endsWith('_HASH')
            ? reference?.documentPins?.configurationHash
            : reference?.resolvedPath;
        return [name, value];
      }));
    for (const name of Object.keys(overrides)) {
      if (Object.prototype.hasOwnProperty.call(plan.operationalEnvironment, name)) {
        throw new Error(`strict_full_auto_acceptance_environment_binding_conflict:${name}`);
      }
    }
    const idempotencyKey = step.idempotencyKey || strictFullAutoAcceptanceHash({
      planHash: plan.planHash,
      stepId: step.stepId,
    });
    Object.assign(overrides, plan.operationalEnvironment);
    // Bind the public Elan installation through the HEPTA-namespaced plan
    // surface instead of admitting an arbitrary ambient ELAN_HOME.
    overrides.ELAN_HOME = plan.operationalEnvironment.HEPTA_FORMAL_ELAN_HOME;
    const activationPointer = plan.operationalEnvironment
      .HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_ACTIVATION_POINTER;
    const activationStep = plan.steps.find((candidate) => (
      candidate.stepId === 'advanced-numeric-activation'
    ));
    const activationStepIndex = plan.steps.indexOf(activationStep);
    const currentStepIndex = plan.steps.indexOf(step);
    if (activationPointer && (currentStepIndex > activationStepIndex
      || step.stepId === STRICT_FULL_AUTO_ACCEPTANCE_FINAL_VERIFICATION_STEP_ID)) {
      const activation = inspectInstalledAutonomousEmpiricalPluginRelease({
        activationPath: activationPointer,
        expectedAcceptancePlanHash: plan.planHash,
        expectedAcceptanceStepIdempotencyKey: activationStep.idempotencyKey,
      });
      Object.assign(overrides, activation.activationEnvironment);
    }
    overrides.HEPTA_PAPER_RUNTIME_ROOT = plan.runtimeRoot;
    overrides.HEPTA_PAPER_ASSET_ROOT = plan.assetRoot;
    overrides.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_CONTROL_ROOT = plan.controlRoot;
    overrides.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY = idempotencyKey;
    overrides.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH = plan.planHash;
    const restrictedHome = path.join(plan.controlRoot, 'restricted-child-home');
    fs.mkdirSync(restrictedHome, { recursive: true, mode: 0o700 });
    const homeStat = fs.lstatSync(restrictedHome);
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink()
      || fs.realpathSync(restrictedHome) !== restrictedHome
      || (homeStat.mode & 0o077) !== 0) {
      throw new Error('strict_full_auto_acceptance_restricted_child_home_invalid');
    }
    overrides.HOME = restrictedHome;
    const childArguments = invocation.arguments.map((argument) => (
      argument === '@acceptance-plan-hash' ? plan.planHash : argument
    ));
    const result = await this.runProcess({
      executable: this.executable,
      args: [path.join(this.workspaceRoot, COMMANDS[invocation.command]), ...childArguments],
      cwd: this.workspaceRoot,
      env: restrictedChildEnvironment({ source: this.environment, overrides }),
      timeoutMs: phase === 'verify'
        ? Math.min(this.timeoutMs, this.verificationTimeoutMs)
        : this.timeoutMs,
      maximumCapturedBytes: 4 * 1024 * 1024,
      signal,
    });
    if (result.timedOut || result.aborted || result.outputTruncated) {
      const error = new Error(
        `strict_full_auto_acceptance_child_infrastructure_failed:${step.stepId}:${phase}`,
      );
      error.code = 'STRICT_FULL_AUTO_ACCEPTANCE_INFRASTRUCTURE_FAILURE';
      throw error;
    }
    let output;
    try {
      output = parseChildJson(result.stdout, `${step.stepId}:${phase}`);
    } catch (cause) {
      const error = new Error(
        `strict_full_auto_acceptance_child_infrastructure_failed:${step.stepId}:${phase}`,
        { cause },
      );
      error.code = 'STRICT_FULL_AUTO_ACCEPTANCE_INFRASTRUCTURE_FAILURE';
      throw error;
    }
    if (result.exitCode !== 0 && phase === 'verify') {
      const skips = reportedSkipCount(output);
      const failedAssertion = invocation.assertions.find((assertion) => (
        !strictFullAutoAcceptanceJsonEqual(
          jsonPointer(output, assertion.path),
          assertion.equals,
        )
      ));
      if (result.exitCode === SEMANTIC_NOT_READY_EXIT_CODE
        && skips === 0 && failedAssertion
        && isCompleteSemanticNotReadyOutput(output, invocation)) {
        const error = new Error(
          `strict_full_auto_acceptance_child_not_ready:${step.stepId}:${failedAssertion.path}`,
        );
        error.code = 'STRICT_FULL_AUTO_ACCEPTANCE_NOT_READY';
        error.assertionPath = failedAssertion.path;
        error.outputHash = strictFullAutoAcceptanceHash(output);
        throw error;
      }
      const error = new Error(
        `strict_full_auto_acceptance_child_infrastructure_failed:${step.stepId}:${phase}`,
      );
      error.code = skips === 0
        ? 'STRICT_FULL_AUTO_ACCEPTANCE_INFRASTRUCTURE_FAILURE'
        : 'STRICT_FULL_AUTO_ACCEPTANCE_POLICY_FAILURE';
      throw error;
    }
    if (result.exitCode !== 0) {
      const error = new Error(
        `strict_full_auto_acceptance_child_failed:${step.stepId}:${phase}`,
      );
      error.code = 'STRICT_FULL_AUTO_ACCEPTANCE_CHILD_ACTION_FAILURE';
      throw error;
    }
    return output;
  }
}
