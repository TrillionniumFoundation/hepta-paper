import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  assertImmutableReleaseHostSnapshot,
  assertImmutableReleaseDeploymentPlan,
  IMMUTABLE_RELEASE_DEPLOYMENT_INTENT_ROOT,
} from '../../paper-domain/contracts/immutable-release-deployment-contract.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
export const IMMUTABLE_RELEASE_DEPLOYMENT_INTENT_MAXIMUM_BYTES = 64 * 1024 * 1024;
export const IMMUTABLE_RELEASE_DEPLOYMENT_INTENT_FILE =
  'IMMUTABLE-RELEASE-DEPLOYMENT-INTENT.json';
export const IMMUTABLE_RELEASE_DEPLOYMENT_PHASES = Object.freeze([
  'prepared',
  'materialize_attempted',
  'materialized',
  'closure_verified',
  'publish_attempted',
  'published',
  'snapshot_persisted',
  'quiesce_attempted',
  'quiesced',
  'cutover_attempted',
  'cutover_completed',
  'install_attempted',
  'install_completed',
  'postverify_completed',
  'unit_restore_attempted',
  'unit_restore_completed',
  'committed',
  'rollback_attempted',
  'rollback_verified',
]);

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function exactKeys(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function directoryIdentity(stat) {
  return Object.freeze({
    device: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode),
    uid: String(stat.uid), gid: String(stat.gid),
  });
}

function sameDirectory(stat, expected) {
  return String(stat.dev) === expected.device && String(stat.ino) === expected.inode
    && String(stat.mode) === expected.mode && String(stat.uid) === expected.uid
    && String(stat.gid) === expected.gid;
}

function inspectRoot(root, { expectedUid, expectedGid }) {
  const selected = path.resolve(root);
  const stat = fs.lstatSync(selected, { bigint: true });
  if (!path.isAbsolute(root) || selected !== root || fs.realpathSync(root) !== root
    || stat.isSymbolicLink() || !stat.isDirectory()
    || Number(stat.uid) !== expectedUid || Number(stat.gid) !== expectedGid
    || (Number(stat.mode) & 0o7777) !== 0o700) {
    throw codedError('immutable_release_deployment_intent_root_invalid');
  }
  return Object.freeze({ path: selected, identity: directoryIdentity(stat) });
}

function assertRootCurrent(root) {
  const stat = fs.lstatSync(root.path, { bigint: true });
  if (!sameDirectory(stat, root.identity)) {
    throw codedError('immutable_release_deployment_intent_root_changed');
  }
}

function intentPath(root) {
  return path.join(root.path, IMMUTABLE_RELEASE_DEPLOYMENT_INTENT_FILE);
}

function existsNoFollow(candidate) {
  try { fs.lstatSync(candidate); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function validateProgress(progress) {
  return exactKeys(progress, [
    'closureHash', 'installedArtifactIdentityHash', 'postverificationHash',
    'publicationIdentityHash',
  ]) && Object.values(progress).every((value) => value === null || SHA256.test(String(value)));
}

export function assertImmutableReleaseDeploymentIntent(intent) {
  if (!exactKeys(intent, [
    'hostSnapshot', 'intentHash', 'kind', 'phase', 'plan', 'previousIntentHash',
    'progress', 'version',
  ]) || intent.version !== 1 || intent.kind !== 'ImmutableReleaseDeploymentIntent'
    || !IMMUTABLE_RELEASE_DEPLOYMENT_PHASES.includes(intent.phase)
    || (intent.previousIntentHash !== null
      && !SHA256.test(String(intent.previousIntentHash || '')))
    || !validateProgress(intent.progress)) {
    throw codedError('immutable_release_deployment_intent_invalid');
  }
  assertImmutableReleaseDeploymentPlan(intent.plan);
  if (intent.hostSnapshot !== null) {
    try {
      assertImmutableReleaseHostSnapshot(intent.hostSnapshot, { plan: intent.plan });
    } catch (error) {
      throw codedError('immutable_release_deployment_intent_snapshot_invalid', { cause: error });
    }
  }
  const { intentHash, ...payload } = intent;
  const phaseIndex = IMMUTABLE_RELEASE_DEPLOYMENT_PHASES.indexOf(intent.phase);
  const rollbackPhase = ['rollback_attempted', 'rollback_verified'].includes(intent.phase);
  if (!SHA256.test(String(intentHash || ''))
    || hashRecord('ImmutableReleaseDeploymentIntent', payload) !== intentHash
    || (!rollbackPhase && ((phaseIndex
      >= IMMUTABLE_RELEASE_DEPLOYMENT_PHASES.indexOf('snapshot_persisted'))
      !== (intent.hostSnapshot !== null)))
    || (!rollbackPhase && phaseIndex >= IMMUTABLE_RELEASE_DEPLOYMENT_PHASES.indexOf('closure_verified')
      && intent.progress.closureHash === null)
    || (!rollbackPhase && phaseIndex >= IMMUTABLE_RELEASE_DEPLOYMENT_PHASES.indexOf('published')
      && intent.progress.publicationIdentityHash === null)
    || (!rollbackPhase && phaseIndex
      >= IMMUTABLE_RELEASE_DEPLOYMENT_PHASES.indexOf('install_completed')
      && intent.progress.installedArtifactIdentityHash === null)
    || (!rollbackPhase && phaseIndex >= IMMUTABLE_RELEASE_DEPLOYMENT_PHASES.indexOf('postverify_completed')
      && intent.progress.postverificationHash === null)) {
    throw codedError('immutable_release_deployment_intent_invalid');
  }
  return intent;
}

function createIntent({ plan, phase, previousIntentHash, hostSnapshot, progress }) {
  const payload = Object.freeze({
    version: 1,
    kind: 'ImmutableReleaseDeploymentIntent',
    plan,
    phase,
    previousIntentHash,
    hostSnapshot,
    progress: Object.freeze({ ...progress }),
  });
  return Object.freeze({
    ...payload,
    intentHash: hashRecord('ImmutableReleaseDeploymentIntent', payload),
  });
}

function fsyncRoot(root) {
  const descriptor = fs.openSync(root.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    assertRootCurrent(root);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeIntent(root, intent, { replace }) {
  assertImmutableReleaseDeploymentIntent(intent);
  const serialized = `${JSON.stringify(intent)}\n`;
  if (Buffer.byteLength(serialized) > IMMUTABLE_RELEASE_DEPLOYMENT_INTENT_MAXIMUM_BYTES) {
    throw codedError('immutable_release_deployment_intent_budget_exceeded');
  }
  const destination = intentPath(root);
  const currentExists = existsNoFollow(destination);
  if (currentExists !== replace) {
    throw codedError(replace
      ? 'immutable_release_deployment_intent_missing'
      : 'immutable_release_deployment_intent_already_exists');
  }
  const temporary = path.join(
    root.path,
    `.immutable-release-intent.${process.pid}.${crypto.randomBytes(12).toString('hex')}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    fs.fchownSync(descriptor, Number(root.identity.uid), Number(root.identity.gid));
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, serialized);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertRootCurrent(root);
    fs.renameSync(temporary, destination);
    fsyncRoot(root);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
  return intent;
}

function readIntentFile(root) {
  const file = intentPath(root);
  if (!existsNoFollow(file)) return null;
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
    const before = fs.fstatSync(descriptor, { bigint: true });
    const selected = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || selected.isSymbolicLink() || !selected.isFile()
      || before.dev !== selected.dev || before.ino !== selected.ino || before.nlink !== 1n
      || before.size < 1n
      || before.size > BigInt(IMMUTABLE_RELEASE_DEPLOYMENT_INTENT_MAXIMUM_BYTES)
      || Number(before.uid) !== Number(root.identity.uid)
      || Number(before.gid) !== Number(root.identity.gid)
      || (Number(before.mode) & 0o7777) !== 0o600) {
      throw codedError('immutable_release_deployment_intent_file_invalid');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || BigInt(bytes.length) !== before.size) {
      throw codedError('immutable_release_deployment_intent_file_changed');
    }
    assertRootCurrent(root);
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed = JSON.parse(raw);
    if (raw !== `${JSON.stringify(parsed)}\n`) {
      throw codedError('immutable_release_deployment_intent_noncanonical');
    }
    return assertImmutableReleaseDeploymentIntent(parsed);
  } catch (error) {
    if (error?.code?.startsWith?.('immutable_release_')) throw error;
    throw codedError('immutable_release_deployment_intent_file_invalid', { cause: error });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function createImmutableReleaseDeploymentIntentRepository({
  root = IMMUTABLE_RELEASE_DEPLOYMENT_INTENT_ROOT,
  expectedUid = 0,
  expectedGid = 0,
  testOnlyAllowUnpinnedRoot = false,
} = {}) {
  if (root !== IMMUTABLE_RELEASE_DEPLOYMENT_INTENT_ROOT
    && testOnlyAllowUnpinnedRoot !== true) {
    throw codedError('immutable_release_deployment_intent_root_unpinned');
  }
  const openedRoot = inspectRoot(root, { expectedUid, expectedGid });
  const read = () => readIntentFile(openedRoot);
  return Object.freeze({
    read,
    begin({ plan }) {
      assertImmutableReleaseDeploymentPlan(plan);
      return writeIntent(openedRoot, createIntent({
        plan,
        phase: 'prepared',
        previousIntentHash: null,
        hostSnapshot: null,
        progress: {
          closureHash: null,
          installedArtifactIdentityHash: null,
          publicationIdentityHash: null,
          postverificationHash: null,
        },
      }), { replace: false });
    },
    advance({ expectedIntentHash, phase, hostSnapshot = undefined, progress = {} }) {
      const current = read();
      if (!current || current.intentHash !== expectedIntentHash) {
        throw codedError('immutable_release_deployment_intent_conflict');
      }
      const currentIndex = IMMUTABLE_RELEASE_DEPLOYMENT_PHASES.indexOf(current.phase);
      const nextIndex = IMMUTABLE_RELEASE_DEPLOYMENT_PHASES.indexOf(phase);
      const normalTransition = nextIndex === currentIndex + 1
        && !['rollback_attempted', 'rollback_verified'].includes(phase);
      const rollbackTransition = phase === 'rollback_attempted'
        && !['rollback_attempted', 'rollback_verified'].includes(current.phase);
      const rollbackCompletion = current.phase === 'rollback_attempted'
        && phase === 'rollback_verified';
      if (!normalTransition && !rollbackTransition && !rollbackCompletion) {
        throw codedError('immutable_release_deployment_intent_transition_invalid');
      }
      const nextSnapshot = hostSnapshot === undefined ? current.hostSnapshot : hostSnapshot;
      const nextProgress = { ...current.progress, ...progress };
      if ((current.hostSnapshot !== null
          && JSON.stringify(nextSnapshot) !== JSON.stringify(current.hostSnapshot))
        || Object.keys(current.progress).some((key) => current.progress[key] !== null
          && nextProgress[key] !== current.progress[key])) {
        throw codedError('immutable_release_deployment_intent_progress_rewrite_forbidden');
      }
      return writeIntent(openedRoot, createIntent({
        plan: current.plan,
        phase,
        previousIntentHash: current.intentHash,
        hostSnapshot: nextSnapshot,
        progress: nextProgress,
      }), { replace: true });
    },
    remove({ expectedIntentHash }) {
      const current = read();
      if (!current || current.intentHash !== expectedIntentHash
        || !['committed', 'rollback_verified'].includes(current.phase)) {
        throw codedError('immutable_release_deployment_intent_remove_forbidden');
      }
      fs.unlinkSync(intentPath(openedRoot));
      fsyncRoot(openedRoot);
      return true;
    },
  });
}
