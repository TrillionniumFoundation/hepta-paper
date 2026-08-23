import fs from 'node:fs';
import path from 'node:path';

const INSTALLED_LAUNCHER = '/usr/libexec/hepta-paper/hepta-immutable-release-deploy';
const MAXIMUM_PLAN_BYTES = 64 * 1024 * 1024;
const PLAN_HASH = /^sha256:[0-9a-f]{64}$/u;

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function safeError(error) {
  const candidate = String(error?.code || error?.message || 'immutable_release_deployment_failed');
  return /^[A-Za-z0-9_.:-]+$/u.test(candidate)
    ? candidate : 'immutable_release_deployment_failed';
}

function requiredAbsolute(value, code) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw codedError(code);
  }
  return value;
}

export function parseImmutableReleaseDeploymentArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') return Object.freeze({ help: true });
  const [command, ...remaining] = argv;
  if (!['execute', 'plan', 'recover'].includes(command)) {
    throw codedError('immutable_release_deployment_command_required');
  }
  const values = new Map();
  for (let index = 0; index < remaining.length; index += 2) {
    const option = remaining[index];
    const value = remaining[index + 1];
    if (!['--confirm-plan-hash', '--plan-file', '--workspace'].includes(option)
      || !value || value.startsWith('--') || values.has(option)) {
      throw codedError('immutable_release_deployment_arguments_invalid');
    }
    values.set(option, value);
  }
  const workspaceRoot = command === 'recover' ? null : requiredAbsolute(
    values.get('--workspace'),
    'immutable_release_deployment_workspace_absolute_path_required',
  );
  if (command === 'recover' && values.has('--workspace')) {
    throw codedError('immutable_release_deployment_recovery_workspace_forbidden');
  }
  if (command !== 'execute'
    && (values.has('--plan-file') || values.has('--confirm-plan-hash'))) {
    throw codedError('immutable_release_deployment_arguments_invalid');
  }
  let planFile = null;
  let expectedPlanHash = null;
  if (command === 'execute') {
    planFile = requiredAbsolute(
      values.get('--plan-file'),
      'immutable_release_deployment_plan_file_absolute_path_required',
    );
    expectedPlanHash = values.get('--confirm-plan-hash');
    if (!PLAN_HASH.test(String(expectedPlanHash || ''))) {
      throw codedError('immutable_release_deployment_plan_hash_confirmation_required');
    }
  }
  return Object.freeze({
    help: false,
    command,
    workspaceRoot,
    planFile,
    expectedPlanHash,
  });
}

function readPlan(file) {
  let descriptor;
  try {
    if (fs.realpathSync(file) !== file) {
      throw codedError('immutable_release_deployment_plan_file_invalid');
    }
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < 2n || before.size > BigInt(MAXIMUM_PLAN_BYTES)) {
      throw codedError('immutable_release_deployment_plan_file_invalid');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || BigInt(bytes.length) !== before.size) {
      throw codedError('immutable_release_deployment_plan_file_changed');
    }
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return parsed?.plan || parsed;
  } catch (error) {
    if (error?.code?.startsWith?.('immutable_release_')) throw error;
    throw codedError('immutable_release_deployment_plan_file_invalid', { cause: error });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function immutableReleaseDeploymentUsage() {
  return Object.freeze({
    version: 1,
    kind: 'ImmutableReleaseDeploymentUsage',
    commands: Object.freeze([
      `${INSTALLED_LAUNCHER} plan --workspace /absolute/clean/candidate`,
      `${INSTALLED_LAUNCHER} execute --workspace /absolute/clean/candidate --plan-file /absolute/plan.json --confirm-plan-hash sha256:...`,
      `${INSTALLED_LAUNCHER} recover`,
    ]),
    constraints: Object.freeze({
      executionPrincipal: 'root',
      installerBoundary: '--root / --no-systemctl',
      ambientEnvironment: 'discarded',
      providerActions: 'forbidden',
      releaseTagMutation: 'forbidden',
    }),
  });
}

export async function runImmutableReleaseDeploymentCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  createDeployment = null,
  releaseStateAdapters = null,
  executorBoundary = null,
} = {}) {
  let options;
  try {
    options = parseImmutableReleaseDeploymentArguments(argv);
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, error: safeError(error) })}\n`);
    return 2;
  }
  if (options.help) {
    stdout.write(`${JSON.stringify(immutableReleaseDeploymentUsage(), null, 2)}\n`);
    return 0;
  }
  try {
    let selectedCreateDeployment = createDeployment;
    let selectedReleaseStateAdapters = releaseStateAdapters;
    if (selectedCreateDeployment === null || selectedReleaseStateAdapters === null) {
      const [composition, releaseState] = await Promise.all([
        import('./immutable-release-deployment-composition.mjs'),
        import('../../paper-adapters/runtime/release-state-repository.mjs'),
      ]);
      selectedCreateDeployment ||= composition.createProductionImmutableReleaseDeployment;
      selectedReleaseStateAdapters ||= Object.freeze({
        inspectReleaseState: releaseState.inspectWorkspaceReleaseState,
        assertReleaseReady: releaseState.assertWorkspaceReleaseReady,
      });
    }
    const deployment = selectedCreateDeployment({
      candidateWorkspaceRoot: options.workspaceRoot,
      inheritedLockFd: Number(process.env.HEPTA_IMMUTABLE_DEPLOY_LOCK_FD) || null,
      trustedPredecessorClosureHash: executorBoundary?.closureHash || null,
      inspectReleaseState: selectedReleaseStateAdapters.inspectReleaseState,
      assertReleaseReady: selectedReleaseStateAdapters.assertReleaseReady,
    });
    let result;
    if (options.command === 'plan') result = await deployment.transaction.plan();
    else if (options.command === 'recover') result = await deployment.recover();
    else {
      result = await deployment.transaction.execute({
        plan: readPlan(options.planFile),
        expectedPlanHash: options.expectedPlanHash,
      });
    }
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify({
      ok: false,
      error: safeError(error),
      receipt: error?.receipt || null,
    })}\n`);
    return 1;
  }
}
