import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RELEASE_FULL_CLOSEOUT_STEPS = Object.freeze([
  Object.freeze({
    stepId: 'readonly_gate',
    scriptId: 'gate:readonly',
  }),
  Object.freeze({
    stepId: 'readonly_gate_validation',
    scriptId: 'validate:gate',
  }),
  Object.freeze({
    stepId: 'readonly_closeout_summary',
    scriptId: 'summarize:closeout',
  }),
  Object.freeze({
    stepId: 'readonly_closeout_validation',
    scriptId: 'validate:closeout',
  }),
  Object.freeze({
    stepId: 'readonly_release_health',
    scriptId: 'release:health',
  }),
  Object.freeze({
    stepId: 'readonly_release_health_validation',
    scriptId: 'validate:release-health',
  }),
  Object.freeze({
    stepId: 'readonly_release_verification',
    scriptId: 'release:verify',
  }),
  Object.freeze({
    stepId: 'readonly_release_verification_validation',
    scriptId: 'validate:release-verification',
  }),
  Object.freeze({
    stepId: 'readonly_release_archive',
    scriptId: 'release:archive',
  }),
  Object.freeze({
    stepId: 'readonly_release_archive_validation',
    scriptId: 'validate:release-archive',
  }),
  Object.freeze({
    stepId: 'readonly_release_archive_closeout',
    scriptId: 'release:archive-closeout',
  }),
]);

function readPackageScripts() {
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  return packageJson.scripts || {};
}

function reportSafety() {
  return {
    localOnly: true,
    readOnlyReleaseChain: true,
    executesExternalAction: false,
    providerSpend: false,
    browserAutomation: false,
    upload: false,
    submit: false,
    messaging: false,
    payment: false,
    acceptance: false,
    deployment: false,
    fetchesChannelState: false,
    appliesLocalStateTransition: false,
    grantsExecutionPermission: false,
  };
}

function reportFiles() {
  return {
    gate: {
      json: 'reports/read-only-core-gate-latest.json',
      md: 'reports/read-only-core-gate-latest.md',
    },
    closeout: {
      json: 'reports/read-only-closeout-latest.json',
      md: 'reports/read-only-closeout-latest.md',
    },
    releaseHealth: {
      json: 'reports/read-only-release-health-latest.json',
      md: 'reports/read-only-release-health-latest.md',
    },
    releaseVerification: {
      json: 'reports/read-only-release-verification-latest.json',
      md: 'reports/read-only-release-verification-latest.md',
    },
    releaseArchive: {
      json: 'reports/read-only-release-archive-latest.json',
      md: 'reports/read-only-release-archive-latest.md',
    },
    releaseArchiveCloseout: {
      json: 'reports/read-only-release-archive-closeout-latest.json',
      md: 'reports/read-only-release-archive-closeout-latest.md',
    },
  };
}

function summarize({
  status,
  ok,
  startedAt,
  completedAt = new Date().toISOString(),
  steps,
  blockers = [],
}) {
  return {
    version: 1,
    kind: 'ReleaseFullCloseout',
    status,
    ok,
    startedAt,
    completedAt,
    summary: {
      stepCount: RELEASE_FULL_CLOSEOUT_STEPS.length,
      completedStepCount: steps.filter((step) => step.ok === true).length,
      blockerCount: blockers.length,
    },
    steps,
    blockers,
    reportFiles: reportFiles(),
    safety: reportSafety(),
  };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function stepCommandLabel(scriptId) {
  return `npm run ${scriptId}`;
}

function runStep(step) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const child = spawnSync('npm', ['run', step.scriptId], {
    cwd: packageRoot,
    stdio: 'inherit',
    env: process.env,
  });
  const durationMs = Date.now() - startedMs;
  const exitCode = typeof child.status === 'number' ? child.status : 1;
  const ok = !child.error && child.status === 0 && !child.signal;
  return {
    ...step,
    command: stepCommandLabel(step.scriptId),
    status: ok ? 'pass_release_full_closeout_step' : 'blocked_release_full_closeout_step',
    ok,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs,
    exitCode,
    signal: child.signal || null,
    error: child.error ? child.error.message : null,
  };
}

function usage() {
  return [
    'Usage: node src/release-full-closeout.mjs [--list|--help]',
    '',
    'Runs the read-only release closeout chain:',
    ...RELEASE_FULL_CLOSEOUT_STEPS.map((step) => `  - ${stepCommandLabel(step.scriptId)}`),
  ].join('\n');
}

const argSet = new Set(process.argv.slice(2));
if (argSet.has('--help')) {
  console.log(usage());
  process.exit(0);
}

const scripts = readPackageScripts();
if (argSet.has('--list')) {
  printJson({
    version: 1,
    kind: 'ReleaseFullCloseoutPlan',
    status: 'pass_release_full_closeout_plan',
    ok: true,
    steps: RELEASE_FULL_CLOSEOUT_STEPS.map((step) => ({
      ...step,
      command: stepCommandLabel(step.scriptId),
      packageCommand: scripts[step.scriptId] || null,
      present: Boolean(scripts[step.scriptId]),
    })),
    safety: reportSafety(),
  });
  process.exit(0);
}

const startedAt = new Date().toISOString();
const missingScriptIds = RELEASE_FULL_CLOSEOUT_STEPS
  .map((step) => step.scriptId)
  .filter((scriptId) => !scripts[scriptId]);
if (missingScriptIds.length) {
  printJson(summarize({
    status: 'blocked_release_full_closeout',
    ok: false,
    startedAt,
    steps: [],
    blockers: missingScriptIds.map((scriptId) => ({
      code: 'release_full_closeout_package_script_missing',
      scriptId,
      notes: `${scriptId} must exist in package.json scripts before the release closeout chain can run.`,
    })),
  }));
  process.exit(1);
}

const completedSteps = [];
for (const step of RELEASE_FULL_CLOSEOUT_STEPS) {
  const result = runStep(step);
  completedSteps.push(result);
  if (!result.ok) {
    printJson(summarize({
      status: 'blocked_release_full_closeout',
      ok: false,
      startedAt,
      steps: completedSteps,
      blockers: [{
        code: 'release_full_closeout_step_failed',
        stepId: result.stepId,
        scriptId: result.scriptId,
        exitCode: result.exitCode,
        signal: result.signal,
        error: result.error,
        notes: `${stepCommandLabel(result.scriptId)} failed; rerun that script directly for focused output.`,
      }],
    }));
    process.exit(result.exitCode || 1);
  }
}

printJson(summarize({
  status: 'pass_release_full_closeout',
  ok: true,
  startedAt,
  steps: completedSteps,
}));
