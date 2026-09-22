// Owned offline storage regression only. Original repository acquire/release
// produces the rows; no supervisor/provider/authority process is dispatched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createAutonomousResearchSupervisorInstanceRepository} from '../../paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs';
import {productionOracleProfile} from './production-record-hash-v1.mjs';

const encoded = process.argv[2];
if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 8192) {
  throw Error('owned_health_wal_argument_invalid');
}
const input = JSON.parse(encoded);
if (input?.action !== 'hold-original-release' || typeof input.root !== 'string'
    || Object.keys(input).sort().join(',') !== 'action,root') {
  throw Error('owned_health_wal_action_invalid');
}
const root = path.resolve(input.root);
const temporary = fs.realpathSync(os.tmpdir());
const metadata = fs.lstatSync(root);
if (root !== input.root || !root.startsWith(temporary + path.sep)
    || !path.basename(root).startsWith('hepta-health-wal-parity-')
    || fs.realpathSync(root) !== root || !metadata.isDirectory()
    || metadata.isSymbolicLink() || metadata.uid !== process.getuid()
    || (metadata.mode & 0o777) !== 0o700) {
  throw Error('owned_health_wal_root_required');
}
const markerName = '.owned-health-wal-fixture';
const markerContents = 'owned supervisor health WAL fixture\n';
const marker = path.join(root, markerName);
const markerMetadata = fs.lstatSync(marker);
if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()
    || markerMetadata.uid !== process.getuid() || markerMetadata.nlink !== 1
    || (markerMetadata.mode & 0o777) !== 0o600
    || markerMetadata.size !== Buffer.byteLength(markerContents)
    || fs.readFileSync(marker, 'utf8') !== markerContents
    || fs.readdirSync(root).join(',') !== markerName) {
  throw Error('owned_health_wal_fresh_fixture_required');
}

const scope = 'resident-autonomous-research-supervisor';
const query = 'SELECT status FROM autonomous_research_supervisor_instance WHERE scope_id=?';
const repository = createAutonomousResearchSupervisorInstanceRepository({runtimeRoot: root});
let keeper = null;
try {
  const now = new Date();
  const lease = repository.acquireInstanceLease({
    ownerId: 'owned-health-wal-observer', leaseMs: 900000, heartbeatMs: 30000, now,
  });
  if (lease === null) throw Error('owned_health_wal_initial_lease_required');
  const database = path.join(root, 'autonomous-research/supervisor/resident-instance.sqlite');
  keeper = new DatabaseSync(database);
  keeper.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; BEGIN;');
  const before = keeper.prepare(query).get(scope)?.status;
  if (before !== 'running') throw Error('owned_health_wal_old_running_snapshot_required');
  if (repository.releaseInstanceLease({lease, reason: 'owned-committed-wal-stop', now}) !== true) {
    throw Error('owned_health_wal_original_release_required');
  }
  repository.close();
  const current = new DatabaseSync(database);
  let checkpoint;
  let after;
  try {
    after = current.prepare(query).get(scope)?.status;
    checkpoint = current.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
  } finally {
    current.close();
  }
  const pinned = keeper.prepare(query).get(scope)?.status;
  if (after !== 'stopped' || pinned !== 'running'
      || !Number.isInteger(checkpoint?.log) || !Number.isInteger(checkpoint?.checkpointed)
      || checkpoint.log <= checkpoint.checkpointed || checkpoint.checkpointed < 0) {
    throw Error('owned_health_wal_committed_uncheckpointed_release_required');
  }
  process.stdout.write(JSON.stringify({
    profile: productionOracleProfile(),
    value: {
      evidenceScope: 'owned_original_repository_committed_wal_diagnostic_no_live_authority',
      held: true, oldSnapshotStatus: pinned, committedStatus: after,
      walFrames: checkpoint.log, checkpointedFrames: checkpoint.checkpointed,
    },
  }) + '\n');
  // Parent owns this child and SIGKILL/reaps it. The fallback timer bounds a
  // disconnected test runner; tests also require this child still be alive.
  await new Promise(resolve => setTimeout(resolve, 180000));
} finally {
  repository.close();
  if (keeper !== null) keeper.close();
}
