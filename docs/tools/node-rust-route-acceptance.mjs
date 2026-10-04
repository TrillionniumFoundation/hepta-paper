// Independent local behavior acceptance. Incoming JSON never grants acceptance:
// the consumer rebuilds the current Rust owners and replays the ordinary CLIs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COMMAND_REGISTRY_ROUTES } from '../../paper-core/src/command-registry-routes.mjs';
import { captureCommittedSourceSubject, fail as failSourceInput, git as sourceGit, readPinnedSource } from '../../paper-core/src/source-evidence-git-inputs.mjs';
import { readPublicRSourceGraphTargetV1 } from '../../paper-core/src/source-evidence-public-r-inputs.mjs';
import { captureOwnRouteReplayGuardV1, assertOwnRouteReplayGuardV1 } from './node-rust-route-replay-guard.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { ASSET_DOMAIN_PROFILES_V1, assetHandoffDiagnosticV1 } from './node-rust-asset-route-acceptance.mjs';
import { REFERENCE_STATUS_PROFILES_V1, referenceStatusFixtureV1, closeReferenceStatusFixtureV1, expectedReferenceStatusV1 } from './node-rust-reference-route-acceptance.mjs';
import { STORE_STATUS_PROFILES_V1, storeStatusFixtureV1, expectedStoreStatusV1, closeStoreStatusFixtureV1, observeStoreWalFilesV1, storeWalContentV1, validateStoreWalReadCoordinationV1, assertStoreWalReadCoordinationClaimV1, observeStoreClosedWalFilesV1, validateStoreClosedWalReadCoordinationV1, assertStoreClosedWalReadCoordinationClaimV1 } from './node-rust-store-route-acceptance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
const verified = new WeakSet();
const verifiedContexts = new WeakMap(), runtimeContexts = new WeakMap(), observationContexts = new WeakMap();
const invalidatedContexts = new WeakSet();
let ownIndependentReplay = null, ownReplayInFlight = null; // module-private, this consumer/process only
let physicalGeneration = Object.freeze({}); // route selection alone does not revoke a current summary
const authority = Object.freeze({ productionActivation: false, targetHostQualification: false,
  releaseAuthority: false, submissionAuthority: false, writerCutover: false, nodeRetirement: false });
const environmentKeys = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'USER', 'TMPDIR', 'CARGO_HOME',
  'CARGO_TARGET_DIR', 'CARGO_BUILD_JOBS', 'RUSTFLAGS', 'RUSTUP_HOME', 'CARGO_TERM_COLOR', 'TZ'];
export const safeEnvironment = () => Object.fromEntries(environmentKeys.filter(key => typeof process.env[key] === 'string')
  .map(key => [key, process.env[key]]));
function run(program, args, options = {}) {
  const output = spawnSync(program, args, { cwd: ROOT, env: safeEnvironment(), encoding: 'utf8',
    shell: false, timeout: 600_000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (output.error) throw output.error;
  return output;
}
function sourceSubject() {
  return captureCommittedSourceSubject(ROOT);
}
// Cargo preparation may create/remove its SQLite journal. Observe that exact
// development-cache lifecycle before establishing a reusable input epoch.
// This helper cannot create a replay context or grant product authority.
async function beginOwnCargoPreparationWatchV1() {
  const environment = safeEnvironment(), home = environment.CARGO_HOME || path.join(environment.HOME || '', '.cargo');
  const script = path.join(ROOT, 'docs/tools/node-rust-route-build-watch.py');
  const scriptBefore = capturePinnedJsonBytes(script);
  const child = spawn('python3', [script], { cwd: ROOT, env: environment, shell: false,
    stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [], waiters = []; let buffered = '', bytes = 0, stderr = '', failure = null;
  const closed = new Promise(resolve => {
    child.once('error', error => { failure ||= error; resolve({ code: null, signal: null }); });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdin.on('error', error => { failure ||= error; });
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) { failure ||= new Error('route_acceptance_cargo_watch_output_limit'); child.kill('SIGTERM'); return; }
    buffered += chunk;
    while (buffered.includes('\n')) {
      const at = buffered.indexOf('\n'), line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
      try {
        const message = JSON.parse(line), waiting = waiters.shift();
        if (waiting) waiting(message); else messages.push(message);
      } catch (error) { failure ||= error; child.kill('SIGTERM'); }
    }
  });
  child.stderr.on('data', chunk => {
    if (Buffer.byteLength(stderr) + chunk.length > 65536) { failure ||= new Error('route_acceptance_cargo_watch_output_limit'); child.kill('SIGTERM'); }
    else stderr += chunk;
  });
  const within = async (promise, milliseconds) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('route_acceptance_cargo_watch_timeout')), milliseconds);
    })]); } finally { clearTimeout(timer); }
  };
  const next = () => within(messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiters.push(resolve)), 30000);
  const abort = async () => { child.kill('SIGTERM'); await within(closed, 30000); };
  try {
    child.stdin.write(`${JSON.stringify({ parent: home })}\n`);
    const ready = await next();
    if (failure || ready.ready !== true || ready.parent !== home) throw failure || new Error('route_acceptance_cargo_watch_unavailable');
    return { ready, abort, complete: async () => {
      child.stdin.end('finish\n');
      const proof = await next(), status = await within(closed, 30000);
      const scriptAfter = capturePinnedJsonBytes(script);
      if (failure || status.code !== 0 || status.signal || proof.complete !== true || proof.failure !== null
        || JSON.stringify(scriptBefore.identity) !== JSON.stringify(scriptAfter.identity)
        || !scriptBefore.bytes.equals(scriptAfter.bytes) || buffered !== '' || messages.length !== 0) {
        throw failure || new Error('route_acceptance_cargo_watch_changed_or_incomplete');
      }
      return proof;
    } };
  } catch (error) { await abort(); throw error; }
}
function assertOwnCargoPreparationTransitionV1(before, after, ready, proof) {
  const error = () => { throw new Error('route_acceptance_own_replay_current_inputs_changed'); };
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const identity = value => Array.isArray(value) && value.length === 9 && value.every(field => typeof field === 'string' && /^\d+$/u.test(field));
  if (proof.parent !== ready.parent || !identity(ready.identity) || !identity(proof.beforeIdentity) || !identity(proof.afterIdentity)
    || !same(ready.identity, proof.beforeIdentity) || !same(ready.namespace, proof.namespace)
    || !same(proof.beforeIdentity.slice(0, 7), proof.afterIdentity.slice(0, 7))
    || !Number.isSafeInteger(proof.journalCreates) || proof.journalCreates < 0 || proof.journalCreates > 4096
    || proof.journalCreates !== proof.journalDeletes || !Array.isArray(proof.journals)
    || proof.journals.length !== proof.journalCreates || !Array.isArray(proof.events) || proof.events.length > 4096) error();
  for (const journal of proof.journals) {
    if (!identity(journal.createdIdentity) || !identity(journal.deletedIdentity)
      || !same(journal.createdIdentity.slice(0, 5), journal.deletedIdentity.slice(0, 5))
      || journal.createdIdentity[5] !== '1' || journal.deletedIdentity[5] !== '0') error();
  }
  if (!proof.cacheFiles || Object.keys(proof.cacheFiles).sort().join(',') !== '.global-cache,.package-cache,.package-cache-mutate') error();
  for (const [name, entry] of Object.entries(proof.cacheFiles)) {
    if (!identity(entry.beforeIdentity) || !identity(entry.afterIdentity)
      || !same(entry.beforeIdentity.slice(0, 6), entry.afterIdentity.slice(0, 6))) error();
    if (name !== '.global-cache' && (!same(entry.beforeIdentity, entry.afterIdentity)
      || !/^sha256:[a-f0-9]{64}$/u.test(entry.beforeSha256) || entry.beforeSha256 !== entry.afterSha256)) error();
  }
  for (const event of proof.events) {
    if (!Number.isSafeInteger(event.mask) || event.cookie !== 0
      || (event.name === '.global-cache' ? ![2, 8].includes(event.mask)
        : ['.package-cache', '.package-cache-mutate'].includes(event.name) ? event.mask !== 8
          : event.name === '.global-cache-journal' ? ![2, 8, 256, 512].includes(event.mask) : true)) error();
  }
  const adjusted = structuredClone(after); adjusted.native = null;
  for (const [index, entry] of before.configurations.entries()) if (entry.absent && entry.parent.path === proof.parent) {
    const current = adjusted.configurations[index];
    if (!current?.absent || current.parent.path !== proof.parent
      || !same(entry.parent.identity, proof.beforeIdentity) || !same(current.parent.identity, proof.afterIdentity)
      || !same({ namesCount: entry.parent.namesCount, namesSha256: entry.parent.namesSha256 }, ready.namespace)
      || !same({ namesCount: current.parent.namesCount, namesSha256: current.parent.namesSha256 }, proof.namespace)) error();
    if (!same(entry.parent.identity, current.parent.identity) && proof.journalCreates === 0) error();
    // The sole preparation exception is the observed journal's parent clocks.
    // Complete namespaces, modes, principals, inodes, sizes and all other
    // missing paths/config bytes remain exact. Reusable epochs have no exception.
    current.parent.identity[7] = entry.parent.identity[7]; current.parent.identity[8] = entry.parent.identity[8];
  }
  if (!same(before, adjusted)) {
    // Preserve bounded physical field diagnostics without accepting any drift.
    // Captured contexts contain physical inputs and hashed ambient environment,
    // and this diagnostic never becomes a replay context or verdict.
    throw ownReplayInputsChangedV1(before, adjusted);
  }
}
function ownReplayInputsChangedV1(before, after, generationRevoked = false) {
  const differences = []; let inspected = 0;
  const visit = (left, right, field) => {
    if (++inspected > 131072 || differences.length >= 32 || left === right) return;
    if (left && right && typeof left === 'object' && typeof right === 'object') {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])]) {
        visit(left[key], right[key], `${field}.${key}`);
        if (inspected > 131072 || differences.length >= 32) break;
      }
    } else {
      const bounded = value => {
        const bytes = JSON.stringify(value);
        return bytes === undefined ? null : bytes.length <= 1024 ? value : { sha256: hash(bytes), bytes: Buffer.byteLength(bytes) };
      };
      differences.push({ field, beforePresent: left !== undefined, afterPresent: right !== undefined,
        before: bounded(left), after: bounded(right) });
    }
  };
  visit(before, after, '$');
  const changed = new Error('route_acceptance_own_replay_current_inputs_changed');
  changed.physicalContextDifferences = differences;
  changed.generationRevoked = generationRevoked;
  return changed;
}
function currentPublicRGraphTargetsV1(subject) {
  return readPublicRSourceGraphTargetV1(ROOT, subject.publicRSourceContentProfile, {
    fail: failSourceInput, git: sourceGit, readPinnedSource,
  });
}
async function prepareOwnConsumerRuntimeV1(pending) {
  if (pending.preparedReplay) {
    assertOwnConsumerCurrent(pending.preparedReplay);
    return pending.preparedReplay;
  }
  const watcher = await beginOwnCargoPreparationWatchV1();
  try {
    const before = captureOwnRouteReplayGuardV1(ROOT, safeEnvironment(), undefined, undefined, currentPublicRGraphTargetsV1(pending.ownedSubjectContext.subject));
    if (invalidatedContexts.has(pending.generation)
      || JSON.stringify(before) !== JSON.stringify(pending.startingGuard)) {
      throw new Error('route_acceptance_own_replay_current_inputs_changed');
    }
    const runtime = buildNativeOwners(), buildContext = runtimeContexts.get(runtime);
    const guard = captureOwnRouteReplayGuardV1(ROOT, safeEnvironment(), runtime, buildContext, currentPublicRGraphTargetsV1(pending.ownedSubjectContext.subject));
    const proof = await watcher.complete();
    assertOwnCargoPreparationTransitionV1(before, guard, watcher.ready, proof);
    assertOwnRouteReplayGuardV1(guard, ROOT, safeEnvironment(), runtime, buildContext, currentPublicRGraphTargetsV1(pending.ownedSubjectContext.subject));
    return { runtime, buildContext, guard, generation: pending.generation };
  } catch (error) { await watcher.abort(); invalidateOwnPhysicalGeneration(pending.generation); throw error; }
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

const workspaceProfiles = ['present', 'missing', 'relative', 'overlap', 'workspace-overlap',
  'symlink-missing', 'symlink-cycle', 'symlink-hop-limit', 'file-parent', 'utf8-paths'];
const assetProfiles = ['pending', 'ready', 'identity-drift', 'identity-missing', 'identity-symlink',
  'source-symlink', 'invalid-version', 'duplicate-id', 'manifest-missing', 'manifest-malformed', 'utf8-paths'];
const grammar = flags => [
  { id: 'unknown', argv: ['--unknown'], error: 'unknown_cli_option:--unknown' },
  { id: 'help-unsupported', argv: ['--help'], error: 'unknown_cli_option:--help' },
  { id: 'positional', argv: ['unexpected'], error: 'unexpected_cli_positional:unexpected' },
  { id: 'multiple-positionals', argv: ['first', 'second'], error: 'unexpected_cli_positional:first' },
  { id: 'legal-flag-then-positional', argv: [`--${flags[0]}`, 'unexpected'], error: 'unexpected_cli_positional:unexpected' },
  { id: 'single-dash', argv: ['-'], error: 'unexpected_cli_positional:-' },
  { id: 'separator', argv: ['--'], error: 'unexpected_cli_argument_separator' },
  { id: 'empty-option', argv: ['--=x'], error: 'empty_cli_option' },
  { id: 'missing-route-separator', argv: [`--${flags[0]}`], omitSeparator: true, error: 'command_arguments_require_separator' },
  ...flags.flatMap(flag => [
    { id: `inline-${flag}`, argv: [`--${flag}=true`], error: `boolean_cli_option_does_not_take_value:--${flag}` },
    { id: `inline-false-${flag}`, argv: [`--${flag}=false`], error: `boolean_cli_option_does_not_take_value:--${flag}` },
    { id: `inline-empty-${flag}`, argv: [`--${flag}=`], error: `boolean_cli_option_does_not_take_value:--${flag}` },
    { id: `duplicate-${flag}`, argv: [`--${flag}`, `--${flag}`], error: `duplicate_cli_option:--${flag}` },
  ]),
];
const contracts = [
  { routeId: 'operator/store', binary: 'hepta-paper-rust', nativePrefix: ['operator', 'store'],
    sqliteCoordination: 'validated-live-wal-header-and-closed-wal-exact-zero-frame-creation-v1', readerOrder: 'alternating-node-first-and-native-first-v1', inputNormalization: 'validated-wal-salt-checksum-only-v1',
    flags: ['allow-isolated-verification-evidence', 'require-trust-clean'], profiles: STORE_STATUS_PROFILES_V1,
    modes: [[], ['--allow-isolated-verification-evidence'], ['--require-trust-clean'],
      ['--allow-isolated-verification-evidence', '--require-trust-clean'],
      ['--require-trust-clean', '--allow-isolated-verification-evidence']] },
  { routeId: 'operator/workspace', binary: 'hepta-paper-rust', nativePrefix: ['operator', 'workspace'],
    flags: ['require-decoupled'], profiles: workspaceProfiles, modes: [[], ['--require-decoupled']] },
  { routeId: 'verify/repository-assets', binary: 'hepta-paper-rust', nativePrefix: ['verify', 'repository-assets'],
    flags: ['handoff', 'require-externalized'], profiles: [...assetProfiles, ...ASSET_DOMAIN_PROFILES_V1.map(row => row.profile)],
    dataDomainProfiles: ASSET_DOMAIN_PROFILES_V1,
    modes: [[], ['--handoff'], ['--require-externalized'], ['--handoff', '--require-externalized'],
      ['--require-externalized', '--handoff']] },
].map(contract => ({ ...contract, strategy: 'semantic-readonly-utf8-v1',
  normalization: 'fixture-and-workspace-path-prefixes-only-v1',
  inputRefusal: 'same-error-category-and-exit-2',
  recovery: 'SIGTERM-and-SIGKILL-at-an-unknown-process-execution-point-then-fresh-retry',
  grammar: grammar(contract.flags) }));
// Newly observed routes remain explicit opt-in candidates until their complete
// argument/input/effect/recovery matrix actually passes independent replay.
// The default keeps the three previously closed local behavior contracts.
const noneGrammar = ['--', '--help', '--unknown', '', 'unexpected', '-', '-h', '--=x', '--root',
  '--flag=true'].flatMap((token, index) => [
    { id: `none-forwarded-${index}`, argv: [token], error: 'command_does_not_accept_arguments' },
    ...(token === '--' ? [] : [{ id: `none-unseparated-${index}`, argv: [token], omitSeparator: true,
      error: 'command_arguments_require_separator' }]),
  ]).concat([
  { id: 'none-multiple-positionals', argv: ['first', 'second'], error: 'command_does_not_accept_arguments' },
  { id: 'none-repeated-separator', argv: ['--', '--'], error: 'command_does_not_accept_arguments' },
]);
const candidates = [{ routeId: 'retirement/reference', binary: 'hepta-paper-rust',
  nativePrefix: ['retirement', 'reference'], flags: [], forwardingPolicy: 'none',
  profiles: REFERENCE_STATUS_PROFILES_V1, modes: [[]],
  strategy: 'semantic-readonly-utf8-v1', normalization: 'fixture-and-workspace-path-prefixes-only-v1',
  inputRefusal: 'same-error-category-and-exit-2',
  recovery: 'SIGTERM-and-SIGKILL-at-an-unknown-process-execution-point-then-fresh-retry', grammar: noneGrammar,
}];
const allContracts = [...contracts, ...candidates];
export const ROUTE_ACCEPTANCE_CONTRACTS_V1 = freeze(allContracts);
export const DEFAULT_ROUTE_ACCEPTANCE_IDS_V1 = freeze(contracts.map(row => row.routeId));

export function routeAcceptanceRequirementsV1(routes = COMMAND_REGISTRY_ROUTES) {
  return routes.map(route => {
    const id = `${route.group}/${route.name}`;
    const contract = allContracts.find(value => value.routeId === id);
    const argumentContract = structuredClone({ nodeArgv: route.argv, forwardingPolicy: route.forwardingPolicy,
      forwardedArgumentSchema: route.forwardedArgumentSchema, unsupportedModes: route.unsupportedModes,
      mutability: route.mutability, effects: route.effects });
    if (contract && (route.mutability !== 'read-only'
      || (contract.forwardingPolicy === 'none' ? route.forwardingPolicy !== 'none' || route.forwardedArgumentSchema !== null
        : route.forwardedArgumentSchema?.positional !== false
          || (route.forwardedArgumentSchema?.valueFlags?.length || 0) !== 0
          || JSON.stringify([...(route.forwardedArgumentSchema?.booleanFlags || [])].sort()) !== JSON.stringify([...contract.flags].sort()))
      || route.effects.localMutation !== 'read-only'
      || Object.entries(route.effects).some(([key, effect]) => key !== 'localMutation' && effect !== 'none'))) {
      throw new Error(`route_acceptance_contract_drift:${id}`);
    }
    return { routeId: id, argumentContract, argumentContractSha256: digest(argumentContract),
      behaviorContractSha256: contract ? digest(contract) : null,
      remaining: contract ? ['normal-argument-and-data-matrix', 'input-refusal-before-effects',
        'process-death-unknown-result-and-retry', 'independent-current-subject-replay']
        : ['complete-argument-value-domain', 'ordinary-product-effect-and-recovery-matrix',
          'independent-current-subject-replay'] };
  }).sort((left, right) => left.routeId.localeCompare(right.routeId));
}

function normalize(value, fixture) {
  if (typeof value === 'string') {
    const relativeFixture = path.relative(ROOT, fixture);
    const relative = value === relativeFixture || value.startsWith(`${relativeFixture}${path.sep}`)
      ? value.replace(relativeFixture, '$FIXTURE_RELATIVE_TO_WORKSPACE') : value;
    return relative.replaceAll(fixture, '$FIXTURE').replaceAll(ROOT, '$WORKSPACE');
  }
  if (Array.isArray(value)) return value.map(item => normalize(item, fixture));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, normalize(item, fixture)]));
  return value;
}
function inventory(root, identities, wal = null, purpose = null) {
  const rows = [];
  function visit(relative) {
    const full = path.join(root, relative);
    const stat = fs.lstatSync(full, { bigint: true });
    const row = { path: relative, mode: String(stat.mode), kind: stat.isSymbolicLink() ? 'symlink'
      : stat.isDirectory() ? 'directory' : 'file' };
    if (identities) Object.assign(row, { dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid), gid: String(stat.gid),
      nlink: String(stat.nlink), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
    if (wal?.kind === 'SQLiteClosedWalPhysicalObservationV1' && purpose === 'effects') {
      if (wal.coordinationPaths.includes(relative)) return;
      if (relative === wal.parentPath) { delete row.size; delete row.mtimeNs; delete row.ctimeNs; }
    }
    if (identities && wal && relative === wal.shmPath && purpose === 'effects') {
      delete row.mtimeNs; delete row.ctimeNs;
    }
    if (stat.isSymbolicLink()) row.target = normalize(fs.readlinkSync(full), root);
    else if (stat.isFile()) row.contentSha256 = hash(wal && wal.kind !== 'SQLiteClosedWalPhysicalObservationV1' && storeWalContentV1(wal, relative, purpose) || fs.readFileSync(full));
    rows.push(row);
    if (stat.isDirectory()) for (const name of fs.readdirSync(full).sort()) visit(path.join(relative, name));
  }
  visit('');
  return digest(rows);
}
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
function assetFixture(fixture, profile) {
  const domain = ASSET_DOMAIN_PROFILES_V1.find(row => row.profile === profile);
  const deployed = path.join(fixture, 'deployment');
  for (const file of ['hepta-paper.mjs', 'repository-asset-status.mjs']) {
    write(path.join(deployed, 'paper-core/bin', file), fs.readFileSync(path.join(ROOT, 'paper-core/bin', file)));
  }
  fs.symlinkSync(path.join(ROOT, 'paper-core/src'), path.join(deployed, 'paper-core/src'));
  fs.symlinkSync(path.join(ROOT, 'paper-composition'), path.join(deployed, 'paper-composition'));
  fs.mkdirSync(path.join(deployed, 'paper-core/config'), { recursive: true });
  const identity = Buffer.from('independent ordinary CLI asset fixture\n');
  write(path.join(deployed, 'asset/identity.txt'), identity);
  const asset = { assetId: 'fixture', sourcePath: 'asset', identityFile: 'asset/identity.txt',
    expectedIdentitySha256: hash(identity), currentStorage: 'repository', targetStorage: 'immutable-registry',
    requiredExternalReferenceKind: 'content-addressed-artifact', retentionPolicy: 'retain-reference',
    migrationStatus: 'pending-external-registry-reference' };
  if (profile === 'utf8-paths') {
    fs.renameSync(path.join(deployed, 'asset'), path.join(deployed, '资产'));
    fs.renameSync(path.join(deployed, '资产/identity.txt'), path.join(deployed, '资产/身份.txt'));
    Object.assign(asset, { assetId: '资产-fixture', sourcePath: '资产', identityFile: '资产/身份.txt' });
  }
  if (profile === 'ready' || domain) {
    asset.migrationStatus = 'externalized';
    const receipt = { version: 1, kind: 'RepositoryAssetExternalRestoreDrillReceipt',
      status: 'repository_asset_external_restore_verified', assetId: asset.assetId,
      externalReferenceDigest: hash('controlled fixture reference'), restoredIdentitySha256: asset.expectedIdentitySha256,
      verifiedAt: '2026-01-01T00:00:00.000Z' };
    receipt.repositoryAssetExternalRestoreDrillReceiptHash = hashRecord('RepositoryAssetExternalRestoreDrillReceipt', receipt);
    asset.externalReference = { kind: asset.requiredExternalReferenceKind, location: 'cas://controlled-fixture',
      digest: receipt.externalReferenceDigest, restoreDrillReceipt: receipt };
  }
  if (domain) {
    if (domain.kind === 'date') asset.externalReference.restoreDrillReceipt.verifiedAt = structuredClone(domain.value);
    else asset[domain.field] = domain.usesIdentityHash ? [asset.expectedIdentitySha256] : structuredClone(domain.value);
    const receipt = asset.externalReference.restoreDrillReceipt;
    delete receipt.repositoryAssetExternalRestoreDrillReceiptHash;
    receipt.repositoryAssetExternalRestoreDrillReceiptHash = hashRecord('RepositoryAssetExternalRestoreDrillReceipt', receipt);
  }
  if (profile === 'identity-drift') write(path.join(deployed, 'asset/identity.txt'), 'changed\n');
  if (profile === 'identity-missing') fs.unlinkSync(path.join(deployed, 'asset/identity.txt'));
  if (profile === 'identity-symlink') {
    write(path.join(deployed, 'original-identity'), identity);
    fs.unlinkSync(path.join(deployed, 'asset/identity.txt'));
    fs.symlinkSync('../original-identity', path.join(deployed, 'asset/identity.txt'));
  }
  if (profile === 'source-symlink') {
    fs.renameSync(path.join(deployed, 'asset'), path.join(deployed, 'real-asset'));
    fs.symlinkSync('real-asset', path.join(deployed, 'asset'));
  }
  const manifest = { version: profile === 'invalid-version' ? 2 : 1,
    kind: 'RepositoryAssetExternalizationManifest', assets: profile === 'duplicate-id' ? [asset, asset] : [asset] };
  const manifestPath = path.join(deployed, 'paper-core/config/repository-asset-externalization.v1.json');
  let encoded = JSON.stringify(manifest);
  if (domain?.rawJsonValue) encoded = encoded.replace(JSON.stringify(domain.value), domain.rawJsonValue);
  if (profile !== 'manifest-missing') write(manifestPath, profile === 'manifest-malformed' ? '{not JSON' : encoded);
  return { cwd: deployed, environment: { HEPTA_PAPER_WORKSPACE_ROOT: deployed }, node: [path.join(deployed, 'paper-core/bin/hepta-paper.mjs'), 'verify', 'repository-assets'] };
}
function workspaceFixture(fixture, profile) {
  const environment = { HEPTA_PAPER_ASSET_ROOT: path.join(fixture, 'asset'),
    HEPTA_PAPER_RUNTIME_ROOT: path.join(fixture, 'runtime'), PAPER_FACTORY_LEGACY_ROOT: path.join(fixture, 'legacy') };
  if (profile !== 'missing') for (const name of ['asset', 'runtime', 'legacy']) fs.mkdirSync(path.join(fixture, name));
  if (profile === 'present') write(path.join(fixture, 'runtime/hepta-paper.sqlite'), 'read-only presence marker');
  if (profile === 'relative') for (const key of Object.keys(environment)) environment[key] = path.relative(ROOT, environment[key]);
  if (profile === 'utf8-paths') {
    for (const [key, name] of [['HEPTA_PAPER_ASSET_ROOT', '资产'], ['HEPTA_PAPER_RUNTIME_ROOT', '运行'],
      ['PAPER_FACTORY_LEGACY_ROOT', '旧目录']]) {
      environment[key] = path.join(fixture, name); fs.mkdirSync(environment[key]);
    }
  }
  if (profile === 'overlap') environment.HEPTA_PAPER_RUNTIME_ROOT = path.join(fixture, 'asset/nested');
  if (profile === 'workspace-overlap') environment.HEPTA_PAPER_ASSET_ROOT = ROOT;
  if (profile === 'symlink-missing') {
    fs.symlinkSync('asset', path.join(fixture, 'link'));
    environment.HEPTA_PAPER_ASSET_ROOT = path.join(fixture, 'link/missing/../suffix');
  }
  if (profile === 'symlink-cycle') {
    fs.symlinkSync('cycle', path.join(fixture, 'cycle'));
    environment.HEPTA_PAPER_ASSET_ROOT = path.join(fixture, 'cycle');
  }
  if (profile === 'symlink-hop-limit') {
    for (let index = 0; index < 42; index += 1) fs.symlinkSync(`hop${index + 1}`, path.join(fixture, `hop${index}`));
    environment.HEPTA_PAPER_ASSET_ROOT = path.join(fixture, 'hop0');
  }
  if (profile === 'file-parent') {
    write(path.join(fixture, 'regular-file'), 'not a directory');
    environment.HEPTA_PAPER_ASSET_ROOT = path.join(fixture, 'regular-file/child');
  }
  return { cwd: ROOT, environment, node: [path.join(ROOT, 'paper-core/bin/hepta-paper.mjs'), 'operator', 'workspace'] };
}
function describeCase(contract) {
  const normalProfile = contract.routeId === 'retirement/reference' ? 'verified' : contract.routeId === 'operator/store' ? 'ready' : contract.routeId === 'operator/workspace' ? 'present' : 'pending';
  const missingProfile = contract.routeId === 'retirement/reference' ? 'missing-first-edge' : contract.routeId === 'operator/store' ? 'main-missing' : contract.routeId === 'operator/workspace' ? 'missing' : 'manifest-missing';
  return [
    ...contract.profiles.flatMap(profile => contract.modes.flatMap((argv, index) => profile === 'closed-wal'
      ? ['node', 'native'].map(firstReader => ({ id: `${profile}/mode-${index}/${firstReader}-first`, profile, argv, kind: 'normal', firstReader }))
      : [{ id: `${profile}/mode-${index}`, profile, argv, kind: 'normal' }])),
    ...contract.grammar.flatMap(row => [false, true].map(missing => ({ id: `refuse/${row.id}/${missing ? 'missing-input' : 'present-input'}`,
      profile: missing ? missingProfile : normalProfile,
      argv: row.argv, omitSeparator: row.omitSeparator === true, kind: 'grammar', expectedError: row.error }))),
    { id: 'default-without-forwarding-separator', profile: normalProfile,
      argv: [], omitSeparator: true, kind: 'normal' },
    ...(contract.routeId === 'operator/store' ? contract.modes.flatMap((argv, index) => ['node', 'native'].flatMap(firstReader =>
      ['SIGTERM', 'SIGKILL'].map(signal => ({ id: `closed-wal/mode-${index}/${firstReader}-first/${signal}/fresh-retry`,
        profile: 'closed-wal', argv, kind: 'death', signal, firstReader })))) : []),
    ...['SIGTERM', 'SIGKILL'].map(signal => ({ id: `unknown-result/${signal}/fresh-retry`,
      profile: normalProfile, argv: [], kind: 'death', signal })),
  ];
}
// A pure projection from the exact same executable case owner; publishers do
// not duplicate formulas or make these counts an acceptance credential.
export function routeAcceptanceCaseCountsV1() {
  return freeze(Object.fromEntries(allContracts.map(row => [row.routeId, describeCase(row).length])));
}

function diagnostic(output, fixture) {
  if (output.signal) return { outcome: 'unknown-result', signal: output.signal, exitCode: null, stdout: null };
  if (output.stdout.trim()) return { outcome: 'report', exitCode: output.status,
    stdout: normalize(JSON.parse(output.stdout), fixture), diagnostic: output.stderr.trim() ? normalize(output.stderr.trim(), fixture) : null };
  let error;
  try { error = JSON.parse(output.stderr).error; } catch { /* Native diagnostics are plain text. */ }
  error ??= assetHandoffDiagnosticV1(output.stderr);
  error ??= /(?:unknown_cli_option|boolean_cli_option_does_not_take_value|duplicate_cli_option|unexpected_cli_positional):[^\s"']+|unexpected_cli_argument_separator|command_arguments_require_separator|command_does_not_accept_arguments|empty_cli_option/.exec(output.stderr)?.[0];
  if (!error && /retirement_reference_[a-z_]+/.test(output.stderr)) error = /retirement_reference_[a-z_]+/.exec(output.stderr)[0];
  if (!error && /Read-only paper store missing:/.test(output.stderr)) error = 'store-database-missing';
  if (!error && /file is not a database/.test(output.stderr)) error = 'sqlite-database-invalid';
  if (!error && /no such table: ([^\s]+)/.test(output.stderr)) error = `sqlite-schema-missing:${/no such table: ([^\s]+)/.exec(output.stderr)[1]}`;
  if (!error && /Value is too large to be represented as a JavaScript number:/.test(output.stderr)) error = 'sqlite-js-number-range';
  if (!error && /ENOENT|No such file or directory/.test(output.stderr)) error = 'input-unreadable';
  if (!error && /SyntaxError|key must be a string|expected value|expected ident|EOF while parsing/.test(output.stderr)) error = 'input-json-invalid';
  if (!error) throw new Error(`route_acceptance_unclassified_diagnostic:${normalize(output.stderr, fixture)}`);
  return { outcome: 'refusal', exitCode: output.status, error: normalize(error, fixture), stdout: null };
}
async function killed(program, args, options, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') reject(error); }
      reject(new Error('route_acceptance_owned_process_did_not_terminate'));
    }, 30_000);
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('spawn', () => {
      try {
        // We know the real executable was spawned; its execution point is
        // deliberately unknown. Own the complete Node wrapper process group.
        process.kill(-child.pid, 'SIGSTOP'); process.kill(-child.pid, signal);
        if (signal !== 'SIGKILL') process.kill(-child.pid, 'SIGCONT');
      } catch (error) { if (error.code !== 'ESRCH') { clearTimeout(timeout); reject(error); } }
    });
    child.once('close', (status, observedSignal) => {
      clearTimeout(timeout); resolve({ status, signal: observedSignal, stdout, stderr });
    });
  });
}
function compatible(node, native, testCase) {
  if (testCase.kind === 'grammar') return node.outcome === 'refusal' && native.outcome === 'refusal'
    && node.error === testCase.expectedError && native.error === node.error
    && node.exitCode === 2 && native.exitCode === 2;
  return JSON.stringify(canonical(node)) === JSON.stringify(canonical(native));
}
function expectedBehavior(contract, testCase, result) {
  if (testCase.kind === 'grammar') return result.outcome === 'refusal' && result.error === testCase.expectedError;
  if (contract.routeId === 'operator/store') return expectedStoreStatusV1(testCase, result);
  if (contract.routeId === 'retirement/reference') return expectedReferenceStatusV1(testCase, result);
  if (contract.routeId === 'operator/workspace') {
    const decoupled = !['overlap', 'workspace-overlap', 'symlink-cycle', 'symlink-hop-limit', 'file-parent'].includes(testCase.profile);
    const expectedCode = testCase.argv.includes('--require-decoupled') && !decoupled ? 2 : 0;
    return result.outcome === 'report' && result.exitCode === expectedCode
      && result.stdout.version === 1 && result.stdout.kind === 'HeptaPaperWorkspaceLayout'
      && result.stdout.workspaceRoot === '$WORKSPACE' && result.stdout.workspacePresent === true
      && result.stdout.physicallyDecoupled === decoupled
      && result.stdout.legacyCatalogRuntimeScanAllowed === false
      && result.stdout.nativeStorePresent === (testCase.profile === 'present')
      && result.stdout.status === (decoupled ? 'hepta_workspace_physically_decoupled' : 'hepta_workspace_paths_overlap');
  }
  if (['manifest-missing', 'manifest-malformed'].includes(testCase.profile)) {
    return result.outcome === 'refusal' && result.exitCode === 1
      && result.error === (testCase.profile === 'manifest-missing' ? 'input-unreadable' : 'input-json-invalid');
  }
  const domain = ASSET_DOMAIN_PROFILES_V1.find(row => row.profile === testCase.profile);
  const state = domain?.expectedState ?? (testCase.profile === 'ready' ? 'ready' : ['pending', 'utf8-paths'].includes(testCase.profile) ? 'pending' : 'blocked');
  const pending = state === 'pending', blocked = state === 'blocked';
  const handoff = testCase.argv.includes('--handoff');
  if (blocked && handoff) return result.outcome === 'refusal' && result.exitCode === 1
    && result.error.startsWith('repository_asset_externalization_handoff_blocked:');
  const inspection = handoff ? result.stdout?.currentInspection : result.stdout;
  const expectedCode = blocked || (pending && testCase.argv.includes('--require-externalized')) ? 1 : 0;
  return result.outcome === 'report' && result.exitCode === expectedCode
    && inspection?.version === 1 && inspection?.kind === 'RepositoryAssetExternalizationInspection'
    && inspection.repositoryBoundaryReady === !blocked
    && inspection.fullyExternalized === (state === 'ready')
    && inspection.status === (blocked ? 'repository_asset_boundary_blocked' : pending
      ? 'repository_asset_boundary_ready_externalization_pending' : 'repository_assets_externalized')
    && (!handoff || result.stdout.kind === 'RepositoryAssetExternalizationHandoff');
}
export function buildNativeOwners({ extraBinaries = [] } = {}) {
  const standalone = ['hepta-runtime-image-reproducibility', 'hepta-state-backup', 'hepta-automation-reconcile',
    'hepta-operational-proof-status', 'hepta-owner-acceptance-status'];
  if (!Array.isArray(extraBinaries) || new Set(extraBinaries).size !== extraBinaries.length
    || extraBinaries.some(binary => !standalone.includes(binary))) throw new Error('route_acceptance_native_binary_selection_invalid');
  const binaries = [...new Set([...contracts.map(row => row.binary), ...extraBinaries])];
  if (process.version !== 'v22.23.1') throw new Error('route_acceptance_node_runtime_unqualified');
  const version = run('cargo', ['--version']);
  if (version.status !== 0 || !/^cargo 1\.98\.0\b/.test(version.stdout)) throw new Error('route_acceptance_cargo_runtime_unqualified');
  const target = process.env.CARGO_TARGET_DIR || path.join(os.tmpdir(), 'hepta-route-acceptance-target');
  if (target === ROOT || target.startsWith(`${ROOT}${path.sep}`)) throw new Error('route_acceptance_build_cache_must_be_outside_checkout');
  const args = ['build', '--manifest-path', path.join(ROOT, 'rust/Cargo.toml'), '--locked', '-p', 'hepta-paper-service',
    ...binaries.flatMap(binary => ['--bin', binary]), '--message-format=json'];
  const output = run('cargo', args, { env: { ...safeEnvironment(), CARGO_TARGET_DIR: target } });
  if (output.status !== 0) throw new Error(`route_acceptance_native_build_failed:${output.stderr}`);
  const owners = {}, artifacts = {};
  for (const line of output.stdout.split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    if (row.reason === 'compiler-artifact' && binaries.includes(row.target.name) && row.executable) {
      const binary = fs.realpathSync(row.executable);
      if (!fs.readFileSync(binary).subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error('route_acceptance_native_owner_not_elf');
      owners[row.target.name] = { path: binary, sha256: hash(fs.readFileSync(binary)) };
      artifacts[row.target.name] = { manifestPath: row.manifest_path, sourcePath: row.target.src_path,
        targetKind: row.target.kind, profile: row.profile };
    }
  }
  if (binaries.some(binary => !owners[binary])) throw new Error('route_acceptance_native_owner_missing');
  const runtime = { owners, node: { version: process.version, sha256: hash(fs.readFileSync(process.execPath)) },
    cargoVersion: version.stdout.trim(), buildArgs: args.map(value => normalize(value, 'unused-fixture')) };
  runtimeContexts.set(runtime, freeze({ root: ROOT, target: path.resolve(target), artifacts }));
  return runtime;
}

export function observeRouteAcceptanceV1(options = {}) {
  return observeRouteAcceptanceInternalV1(options, false);
}
async function observeRouteAcceptanceInternalV1({ routeIds = contracts.map(row => row.routeId), onCase } = {}, ownConsumerReplay = false, preparedReplay = null) {
  if (onCase !== undefined && typeof onCase !== 'function') throw new Error('route_acceptance_case_observer_invalid');
  if (!Array.isArray(routeIds) || routeIds.length === 0 || new Set(routeIds).size !== routeIds.length
    || routeIds.some(id => !allContracts.some(row => row.routeId === id))) throw new Error('route_acceptance_route_selection_invalid');
  const before = sourceSubject();
  const requirements = routeAcceptanceRequirementsV1();
  const runtime = ownConsumerReplay ? preparedReplay?.runtime : buildNativeOwners();
  if (!runtime) throw new Error('route_acceptance_own_replay_context_missing');
  const buildContext = runtimeContexts.get(runtime);
  const replayGuard = ownConsumerReplay ? captureOwnRouteReplayGuardV1(ROOT, safeEnvironment(), runtime, buildContext, currentPublicRGraphTargetsV1(before)) : null;
  if (ownConsumerReplay && (invalidatedContexts.has(preparedReplay.generation)
    || JSON.stringify(preparedReplay.guard) !== JSON.stringify(replayGuard))) {
    throw ownReplayInputsChangedV1(preparedReplay.guard, replayGuard, invalidatedContexts.has(preparedReplay.generation));
  }
  const rows = [];
  for (const contract of allContracts.filter(row => routeIds.includes(row.routeId))) {
    const cases = [];
    const referenceFixture = contract.routeId === 'retirement/reference'
      ? fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-route-acceptance-reference-')) : null;
    try {
    for (const testCase of describeCase(contract)) {
      const fixture = referenceFixture || fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-route-acceptance-'));
      try {
        // Keep observer coverage in this test process; fixture child programs
        // must not inherit Node's automatic V8 coverage propagation.
        const fixtureEnvironment = { ...safeEnvironment(), NODE_V8_COVERAGE: '' };
        const prepared = contract.routeId === 'retirement/reference'
          ? referenceStatusFixtureV1(fixture, testCase.profile, ROOT, runtime.owners[contract.binary])
          : contract.routeId === 'operator/store' ? storeStatusFixtureV1(fixture, testCase.profile, fixtureEnvironment)
          : contract.routeId === 'operator/workspace' ? workspaceFixture(fixture, testCase.profile) : assetFixture(fixture, testCase.profile);
        const env = { ...fixtureEnvironment, ...prepared.environment };
        const nodeArgs = [...prepared.node, ...(testCase.omitSeparator ? [] : ['--']), ...testCase.argv];
        const nativeExecutable = prepared.executable || runtime.owners[contract.binary].path;
        const nativeArgs = [...contract.nativePrefix, ...(testCase.omitSeparator ? [] : ['--']), ...testCase.argv];
        const coldWal = contract.routeId === 'operator/store' && testCase.profile === 'live-wal';
        const closedWal = contract.routeId === 'operator/store' && testCase.profile === 'closed-wal';
        const walBefore = coldWal ? observeStoreWalFilesV1(fixture)
          : closedWal ? observeStoreClosedWalFilesV1(fixture) : null;
        const identity = inventory(fixture, true), inputs = inventory(fixture, false, walBefore, 'input');
        const durableIdentity = walBefore ? inventory(fixture, true, walBefore, 'effects') : identity;
        const execute = async (program, args) => testCase.kind === 'death'
          ? killed(program, args, { cwd: prepared.cwd, env }, testCase.signal)
          : run(program, args, { cwd: prepared.cwd, env, timeout: 30_000 });
        let nodeRaw, nativeRaw, afterNode, afterNative, walNode, walNative, durableNode, durableNative;
        const first = testCase.firstReader || (coldWal && testCase.argv.length % 2 === 1 ? 'native' : 'node');
        const stages = [];
        const observe = (reader, phase, allowIncomplete = false) => {
          const state = coldWal ? observeStoreWalFilesV1(fixture)
            : closedWal ? observeStoreClosedWalFilesV1(fixture, { allowIncomplete }) : null;
          if (closedWal) stages.push({ reader, phase, state });
          return { identity: inventory(fixture, true), state,
            durable: state ? inventory(fixture, true, state, 'effects') : inventory(fixture, true) };
        };
        const runNode = async () => {
          nodeRaw = await execute(process.execPath, nodeArgs);
          const observed = observe('node', testCase.kind === 'death' ? 'interrupted' : 'complete', testCase.kind === 'death');
          afterNode = observed.identity; walNode = observed.state; durableNode = observed.durable;
        };
        const runNative = async () => {
          nativeRaw = await execute(nativeExecutable, nativeArgs);
          const observed = observe('native', testCase.kind === 'death' ? 'interrupted' : 'complete', testCase.kind === 'death');
          afterNative = observed.identity; walNative = observed.state; durableNative = observed.durable;
        };
        if (first === 'native') { await runNative(); await runNode(); }
        else { await runNode(); await runNative(); }
        const node = diagnostic(nodeRaw, fixture), native = diagnostic(nativeRaw, fixture);
        let retry = null, durableRetry = true;
        if (testCase.kind === 'death') {
          let nodeRetry, nativeRetry;
          const retryNode = () => {
            nodeRetry = diagnostic(run(process.execPath, nodeArgs, { cwd: prepared.cwd, env }), fixture);
            const afterRetry = observe('node', 'retry'); durableRetry = durableRetry && afterRetry.durable === durableIdentity;
          };
          const retryNative = () => {
            nativeRetry = diagnostic(run(nativeExecutable, nativeArgs, { cwd: prepared.cwd, env }), fixture);
            const afterRetry = observe('native', 'retry'); durableRetry = durableRetry && afterRetry.durable === durableIdentity;
          };
          if (first === 'native') { retryNative(); retryNode(); } else { retryNode(); retryNative(); }
          retry = { node: nodeRetry, native: nativeRetry, effectsUnchanged: inventory(fixture, true) === identity,
            effectsSatisfied: durableRetry };
        }
        const effectsUnchanged = identity === afterNode && identity === afterNative && (!retry || retry.effectsUnchanged);
        const readCoordination = coldWal ? validateStoreWalReadCoordinationV1(walBefore, walNode, walNative, first)
          : closedWal ? validateStoreClosedWalReadCoordinationV1(walBefore, stages, first) : null;
        const effectsSatisfied = walBefore ? durableIdentity === durableNode && durableIdentity === durableNative && durableRetry : effectsUnchanged;
        if (readCoordination) readCoordination[closedWal ? 'databaseAndOtherPathsUnchanged' : 'databaseWalAndOtherPathsUnchanged'] = effectsSatisfied;
        const passed = compatible(node, native, testCase) && effectsSatisfied
          && (testCase.kind === 'death' || (expectedBehavior(contract, testCase, node) && expectedBehavior(contract, testCase, native)))
          && (!retry || (node.signal === testCase.signal && native.signal === testCase.signal
            && expectedBehavior(contract, testCase, retry.node) && expectedBehavior(contract, testCase, retry.native)
            && JSON.stringify(canonical(retry.node)) === JSON.stringify(canonical(retry.native))));
        if (prepared.assertCurrent) prepared.assertCurrent();
        cases.push({ caseId: testCase.id, inputSha256: inputs,
          nodeArgv: normalize(nodeArgs, fixture), nativeArgv: nativeArgs,
          environment: normalize(prepared.environment, fixture), node, native, retry, effectsUnchanged, effectsSatisfied, readCoordination, passed });
        if (onCase) onCase(freeze(structuredClone(cases.at(-1))));
      } finally { closeStoreStatusFixtureV1(fixture); if (!referenceFixture) fs.rmSync(fixture, { recursive: true, force: true }); }
    }
    } finally {
      if (referenceFixture) { closeReferenceStatusFixtureV1(referenceFixture); fs.rmSync(referenceFixture, { recursive: true, force: true }); }
    }
    const requirement = requirements.find(row => row.routeId === contract.routeId);
    rows.push({ routeId: contract.routeId, argumentContractSha256: requirement.argumentContractSha256,
      behaviorContractSha256: requirement.behaviorContractSha256, cases });
  }
  const after = sourceSubject();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('route_acceptance_source_changed_during_execution');
  const payload = { version: 1, kind: before.committedClean ? 'NodeRustRouteAcceptanceRecordV1' : 'NodeRustRouteBehaviorObservationV1',
    scope: 'local-readonly-command-behavior-no-external-authority', subject: before,
    runtime: { node: runtime.node, cargoVersion: runtime.cargoVersion, buildArgs: runtime.buildArgs,
      nativeOwners: Object.fromEntries(Object.entries(runtime.owners).map(([name, row]) => [name, { sha256: row.sha256 }])) },
    authority, rows };
  if (ownConsumerReplay) assertOwnRouteReplayGuardV1(replayGuard, ROOT, safeEnvironment(), runtime, buildContext, currentPublicRGraphTargetsV1(after));
  const record = freeze({ ...payload, recordSha256: digest(payload) });
  if (ownConsumerReplay) observationContexts.set(record, { guard: replayGuard, runtime, buildContext, subject: before });
  return record;
}

function assertRecordSchema(record) {
  const instance = Buffer.from(JSON.stringify(record));
  if (instance.length > 16 * 1024 * 1024) throw new Error('route_acceptance_record_schema_invalid');
  const schemaSource = path.join(ROOT, 'docs/migration/node-rust-route-acceptance.v1.schema.json');
  const checkerSource = path.join(ROOT, 'docs/rust/tools/strict_json_schema.py');
  const schema = capturePinnedJsonBytes(schemaSource), checker = capturePinnedJsonBytes(checkerSource);
  if (schema.bytes.length > 256 * 1024) throw new Error('route_acceptance_record_schema_invalid');
  // File mode validates the complete captured document through the existing
  // schema owner. The bounded batch protocol retains its separate 4 MiB limit.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-route-schema-'));
  const descriptors = [];
  try {
    fs.chmodSync(directory, 0o700);
    const schemaPath = path.join(directory, 'schema.json'), instancePath = path.join(directory, 'instance.json');
    const captured = [];
    for (const [file, bytes] of [[schemaPath, schema.bytes], [instancePath, instance]]) {
      const descriptor = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      descriptors.push(descriptor); fs.fchmodSync(descriptor, 0o600);
      let written = 0;
      while (written < bytes.length) written += fs.writeSync(descriptor, bytes, written, bytes.length - written, written);
      const state = capturePinnedJsonBytes(file, descriptor);
      if (!state.bytes.equals(bytes)) throw new Error('route_acceptance_record_schema_invalid');
      captured.push([file, descriptor, state]);
    }
    const result = run('python3', [checkerSource, '--schema', schemaPath, '--instance', instancePath],
      { timeout: 30_000, maxBuffer: 1024 * 1024 });
    for (const [file, descriptor, state] of captured) {
      const after = capturePinnedJsonBytes(file, descriptor);
      if (after.sha256 !== state.sha256 || !after.bytes.equals(state.bytes) || JSON.stringify(after.identity) !== JSON.stringify(state.identity)) throw new Error('route_acceptance_record_schema_invalid');
    }
    for (const [file, state] of [[schemaSource, schema], [checkerSource, checker]]) {
      const after = capturePinnedJsonBytes(file);
      if (after.sha256 !== state.sha256 || !after.bytes.equals(state.bytes) || JSON.stringify(after.identity) !== JSON.stringify(state.identity)) throw new Error('route_acceptance_record_schema_invalid');
    }
    if (result.status !== 0 || result.error) throw new Error('route_acceptance_record_schema_invalid');
  } finally { for (const descriptor of descriptors) fs.closeSync(descriptor); fs.rmSync(directory, { recursive: true, force: true }); }
}

function recordPayload(record, ownedSubjectContext = null, currentSubjectSink = null) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('route_acceptance_record_invalid');
  const { recordSha256, ...payload } = record;
  if (recordSha256 !== digest(payload)) throw new Error('route_acceptance_record_digest_mismatch');
  if (Object.keys(payload).sort().join(',') !== 'authority,kind,rows,runtime,scope,subject,version'
    || record.version !== 1 || record.kind !== 'NodeRustRouteAcceptanceRecordV1'
    || record.scope !== 'local-readonly-command-behavior-no-external-authority'
    || JSON.stringify(canonical(record.authority)) !== JSON.stringify(canonical(authority))
    || !Array.isArray(record.rows) || record.rows.length < 1 || record.rows.length > allContracts.length) {
    throw new Error('route_acceptance_record_scope_invalid');
  }
  const requirements = routeAcceptanceRequirementsV1();
  const seen = new Set();
  for (const row of record.rows) {
    const contract = allContracts.find(value => value.routeId === row.routeId);
    const requirement = requirements.find(value => value.routeId === row.routeId);
    if (!contract || seen.has(row.routeId) || row.argumentContractSha256 !== requirement.argumentContractSha256
      || row.behaviorContractSha256 !== requirement.behaviorContractSha256
      || !Array.isArray(row.cases) || JSON.stringify(row.cases.map(value => value.caseId)) !== JSON.stringify(describeCase(contract).map(value => value.id))
      || row.cases.some(value => value.passed !== true || !(value.effectsUnchanged === true
        || row.routeId === 'operator/store' && value.caseId.startsWith('live-wal/') && value.effectsUnchanged === false
          && value.effectsSatisfied === true && value.readCoordination?.kind === 'SQLiteColdWalReadCoordinationV1'
        || row.routeId === 'operator/store' && value.caseId.startsWith('closed-wal/') && value.effectsUnchanged === false
          && value.effectsSatisfied === true && value.readCoordination?.kind === 'SQLiteClosedWalReadCoordinationV1'))) {
      throw new Error(`route_acceptance_complete_contract_missing:${row.routeId}`);
    }
    for (const entry of row.cases) {
      if (row.routeId === 'operator/store' && entry.caseId.startsWith('live-wal/')) {
        assertStoreWalReadCoordinationClaimV1(entry.readCoordination);
      } else if (row.routeId === 'operator/store' && entry.caseId.startsWith('closed-wal/')) {
        assertStoreClosedWalReadCoordinationClaimV1(entry.readCoordination);
      }
    }
    seen.add(row.routeId);
  }
  assertRecordSchema(record);
  const current = assertCurrentRecordSubject(record, ownedSubjectContext);
  // This private sink receives the actual source owner's validated subject.
  // A caller record never becomes an owner, runtime, or acceptance context.
  if (currentSubjectSink) currentSubjectSink.subject = current;
  return payload;
}
function assertCurrentRecordSubject(record, ownedSubjectContext = null) {
  // These contexts are module-private: an actual completed observer, completed
  // replay, or pending replay bound to its fresh starting guard. They contain
  // deeply frozen actual source subjects; incoming DTOs never create one.
  // The consumer still checks the complete current guard before replay/reuse,
  // after every await, and on refusal, with the same sticky revocation.
  const current = ownedSubjectContext ? ownedSubjectContext.subject : sourceSubject();
  if (!current.committedClean || JSON.stringify(record.subject) !== JSON.stringify(current)) throw new Error('route_acceptance_subject_not_current_clean_commit');
  return freeze(current);
}

export function stableReplayPayload(payload) {
  const stable = structuredClone(payload);
  const stableIdentity = identity => Object.fromEntries(Object.entries(identity).filter(([key]) => !['dev', 'ino'].includes(key)));
  const stableClosedState = state => ({ ...state, databaseIdentity: stableIdentity(state.databaseIdentity),
    databaseTimes: undefined, parent: { ...state.parent, identity: stableIdentity(state.parent.identity), times: undefined },
    files: state.files.map(file => file ? { ...file, identity: stableIdentity(file.identity), times: undefined } : null) });
  // Compare geometry, namespace, principal, permission and deterministic bytes.
  // Fresh fixtures have distinct inode/time identities and live-WAL salts.
  // Unknown interruption points can have different partial creation progress;
  // raw diagnostics are schema/cross-field checked, and actual retry states are
  // compared in full apart from those volatile identities and clocks.
  for (const row of stable.rows) for (const entry of row.cases) if (entry.readCoordination) {
    const proof = entry.readCoordination, physical = proof.physicalObservations;
    if (proof.kind === 'SQLiteClosedWalReadCoordinationV1') {
      proof.physicalObservations = { before: stableClosedState(physical.before),
        stages: physical.stages.filter(state => state.phase !== 'interrupted').map(stableClosedState) };
    } else {
      const state = value => ({ identity: stableIdentity(value.identity), walIdentity: stableIdentity(value.walIdentity) });
      proof.physicalObservations = { before: state(physical.before), afterNode: state(physical.afterNode),
        afterNative: state(physical.afterNative), byteChanges: physical.byteChanges.filter(byte =>
          ![[40, 48], [88, 96]].some(([start, end]) => byte.offset >= start && byte.offset < end)) };
    }
  }
  return stable;
}

function invalidateOwnPhysicalGeneration(generation) {
  invalidatedContexts.add(generation);
  if (physicalGeneration === generation) physicalGeneration = Object.freeze({});
  if (ownIndependentReplay?.generation === generation) ownIndependentReplay = null;
}
function assertOwnConsumerCurrent(context) {
  try {
    if (invalidatedContexts.has(context.generation)) throw new Error('route_acceptance_own_replay_current_inputs_changed');
    // The content-only R owner also retains its historical Git locator. It
    // need not be reachable from HEAD, so re-observe it through that same
    // owner using only the private replay's fully validated subject. The final
    // guard below still reads every actual R byte and complete raw identity.
    const graphTargets = readPublicRSourceGraphTargetV1(ROOT, context.subject.publicRSourceContentProfile, {
      fail: failSourceInput, git: sourceGit, readPinnedSource,
    });
    return assertOwnRouteReplayGuardV1(context.guard, ROOT, safeEnvironment(), context.runtime, context.buildContext, graphTargets);
  } catch (error) { invalidateOwnPhysicalGeneration(context.generation); throw error; }
}
function assertOwnReplayStartingCurrent(context) {
  try {
    if (invalidatedContexts.has(context.generation)) throw new Error('route_acceptance_own_replay_current_inputs_changed');
    const graphTargets = readPublicRSourceGraphTargetV1(ROOT, context.ownedSubjectContext.subject.publicRSourceContentProfile, {
      fail: failSourceInput, git: sourceGit, readPinnedSource,
    });
    assertOwnRouteReplayGuardV1(context.startingGuard, ROOT, safeEnvironment(), undefined, undefined, graphTargets);
  } catch (error) { invalidateOwnPhysicalGeneration(context.generation); throw error; }
}
const sameRoutes = (left, right) => JSON.stringify(left) === JSON.stringify(right);
async function ownConsumerReplayFor(routeIds, currentSubject) {
  let preparedReplay = null, startingGuard = null;
  if (ownIndependentReplay) {
    const current = assertOwnConsumerCurrent(ownIndependentReplay);
    if (sameRoutes(routeIds, ownIndependentReplay.record.rows.map(row => row.routeId))) return ownIndependentReplay;
    // This evicts a matrix selection, not the unchanged physical context shared
    // by earlier independently verified summaries.
    preparedReplay = ownIndependentReplay;
    // This is the actual fresh capture just compared above, with only the
    // native field removed for the existing preparation transition.
    startingGuard = { ...current, native: null };
    ownIndependentReplay = null;
  }
  if (ownReplayInFlight) {
    const pending = ownReplayInFlight;
    if (pending.preparing) await pending.preparationPromise;
    assertOwnReplayStartingCurrent(pending);
    const completed = await pending.promise;
    // Returning a local replay object grants no summary; each incoming caller
    // performs its fresh final guard even when payload comparison refuses.
    if (sameRoutes(routeIds, pending.routeIds)) return completed;
    // A different route selection gets its own full matrix. It never borrows
    // the preceding selection's payload or incoming acceptance verdict.
    return ownConsumerReplayFor(routeIds, currentSubject);
  }
  const freshStartingGuard = startingGuard || captureOwnRouteReplayGuardV1(ROOT, safeEnvironment(), undefined, undefined, currentPublicRGraphTargetsV1(currentSubject));
  if (!currentSubject?.committedClean || freshStartingGuard.gitStatus !== ''
    || freshStartingGuard.subject !== [currentSubject.commit, currentSubject.tree].join('\n')) {
    invalidateOwnPhysicalGeneration(physicalGeneration);
    throw new Error('route_acceptance_subject_not_current_clean_commit');
  }
  // This subject came from actual source qualification, before this fresh full
  // guard. It contains no runtime or verdict and cannot stand in for preparation.
  const pending = { routeIds: Object.freeze([...routeIds]), generation: physicalGeneration,
    startingGuard: freshStartingGuard, preparedReplay,
    ownedSubjectContext: Object.freeze({ subject: currentSubject }),
    preparing: false, preparationPromise: null, promise: null };
  // Start after same-turn callers have validated their own incoming records;
  // synchronous validation cannot delay an already spawned death-test timer.
  pending.promise = Promise.resolve().then(async () => {
    // Preparation compares a fresh capture after the watcher is ready.
    pending.preparing = true;
    pending.preparationPromise = prepareOwnConsumerRuntimeV1(pending);
    const prepared = await pending.preparationPromise;
    pending.startingGuard = { ...prepared.guard, native: null }; pending.preparing = false;
    // The matrix compares a fresh full capture and the same revocation token
    // before executing its first case.
    const replayed = await observeRouteAcceptanceInternalV1({ routeIds: pending.routeIds }, true, prepared);
    const observed = observationContexts.get(replayed);
    if (!observed) throw new Error('route_acceptance_own_replay_context_missing');
    const payload = freeze(recordPayload(replayed, observed));
    const completed = { ...observed, generation: pending.generation, subject: replayed.subject, record: replayed, payload };
    // The observer checked the matrix end; this local cache has no authority.
    // Reuse and every incoming verdict still require a fresh full guard.
    ownIndependentReplay = completed;
    return completed;
  }).catch(error => { invalidateOwnPhysicalGeneration(pending.generation); throw error; })
    .finally(() => { if (ownReplayInFlight === pending) ownReplayInFlight = null; });
  ownReplayInFlight = pending;
  return pending.promise;
}
export async function consumeRouteAcceptanceRecordV1(record) {
  record = freeze(structuredClone(record));
  // Each caller retains complete schema/contract/authority/current-subject
  // validation. A producer record never supplies a reusable runtime or verdict.
  let incomingPayload;
  const currentSubjectSink = { subject: null };
  try { incomingPayload = recordPayload(record,
    ownIndependentReplay || ownReplayInFlight?.ownedSubjectContext || null, currentSubjectSink); }
  catch (error) {
    if (ownIndependentReplay) assertOwnConsumerCurrent(ownIndependentReplay);
    if (ownReplayInFlight) {
      if (ownReplayInFlight.preparing) await ownReplayInFlight.preparationPromise;
      assertOwnReplayStartingCurrent(ownReplayInFlight);
    }
    throw error;
  }
  const completed = await ownConsumerReplayFor(record.rows.map(row => row.routeId), currentSubjectSink.subject);
  const { record: replayed, payload: replayPayload, ...context } = completed;
  // This caller's deeply frozen clone already passed the complete schema,
  // digest, contracts, WAL claims and authority checks before the await.
  // Re-observe the complete committed subject after that async boundary.
  try {
    // The private completed replay already bound this complete subject to its
    // full physical guard. Compare this caller's frozen subject with that owned
    // subject; the finally below freshly checks HEAD/tree, the exact index and
    // every physical input before either a verdict or a comparison refusal.
    // No incoming DTO, saved hash or prior verdict supplies that guard.
    if (JSON.stringify(record.subject) !== JSON.stringify(context.subject)) {
      throw new Error('route_acceptance_subject_not_current_clean_commit');
    }
    if (JSON.stringify(canonical(stableReplayPayload(replayPayload))) !== JSON.stringify(canonical(stableReplayPayload(incomingPayload)))) {
      throw new Error('route_acceptance_actual_replay_differs');
    }
  } finally {
    // Refused payloads also observe drift and revoke the physical generation;
    // restoration cannot revive a summary through a comparison error path.
    assertOwnConsumerCurrent(context);
  }
  const acceptedIds = replayed.rows.map(row => row.routeId);
  const summary = freeze({ kind: 'VerifiedNodeRustRouteAcceptanceV1', subject: replayed.subject,
    recordSha256: replayed.recordSha256, verifiedBy: 'ordinary-node-and-built-rust-cli-replay',
    acceptedRouteIds: acceptedIds, authority,
    rows: routeAcceptanceRequirementsV1().map(row => ({ ...row,
      accepted: acceptedIds.includes(row.routeId), remaining: acceptedIds.includes(row.routeId) ? [] : row.remaining })) });
  verified.add(summary); verifiedContexts.set(summary, context);
  return summary;
}

function capturePinnedJsonBytes(file, suppliedDescriptor) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file) {
    throw new Error('route_acceptance_record_path_must_be_absolute');
  }
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('route_acceptance_record_symlink_refused');
  }
  const descriptor = suppliedDescriptor ?? fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size === 0n || before.size > 16n * 1024n * 1024n) {
      throw new Error('route_acceptance_record_file_invalid');
    }
    const chunks = []; let length = 0;
    while (true) {
      const chunk = Buffer.alloc(64 * 1024);
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, length);
      if (count === 0) break;
      length += count;
      if (length > 16 * 1024 * 1024) throw new Error('route_acceptance_record_file_invalid');
      chunks.push(chunk.subarray(0, count));
    }
    const bytes = Buffer.concat(chunks);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    const fields = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
    if (BigInt(bytes.length) !== before.size || fields.some(key => before[key] !== after[key] || before[key] !== named[key])) {
      throw new Error('route_acceptance_record_changed_during_read');
    }
    return { bytes, sha256: hash(bytes), identity: Object.fromEntries(fields.map(key => [key, String(before[key])])) };
  } finally { if (suppliedDescriptor === undefined) fs.closeSync(descriptor); }
}

export function readRouteAcceptanceRecord(file) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(capturePinnedJsonBytes(file).bytes));
}

export function assertVerifiedRouteAcceptanceV1(value) {
  if (!verified.has(value)) throw new Error('route_acceptance_not_independently_replayed_for_current_subject');
  const context = verifiedContexts.get(value);
  try {
    if (JSON.stringify(value.subject) !== JSON.stringify(context.subject)) throw new Error('route_acceptance_source_changed');
    // This opaque summary's privately owned subject was completely validated
    // after its own matrix. Every use still freshly observes the entire guard,
    // including all source bytes, raw identities, Git integrity and index.
    assertOwnConsumerCurrent(context);
  } catch {
    verified.delete(value); invalidateOwnPhysicalGeneration(context.generation);
    throw new Error('route_acceptance_not_independently_replayed_for_current_subject');
  }
  return value;
}
