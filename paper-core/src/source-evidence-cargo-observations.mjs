import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fail, readPinnedSource, trackedBlob } from './source-evidence-git-inputs.mjs';
import { parseStrictJson } from './source-evidence-strict-json.mjs';
import { hashBytes, SOURCE_EVIDENCE_ENTRYPOINT } from './source-evidence-producer.mjs';

export const SAFE_RUST_TEST_PATTERN = /^[A-Za-z0-9_:]+$/;
const artifactIdentity = value => [value.dev, value.ino, value.mode, value.uid, value.gid,
  value.nlink, value.size, value.mtimeNs, value.ctimeNs].map(String);
const cargoEnvironmentKeys = new Set(['CARGO', 'CARGO_MANIFEST_DIR', 'CARGO_MANIFEST_PATH',
  'CARGO_PKG_AUTHORS', 'CARGO_PKG_DESCRIPTION', 'CARGO_PKG_HOMEPAGE', 'CARGO_PKG_LICENSE',
  'CARGO_PKG_LICENSE_FILE', 'CARGO_PKG_NAME', 'CARGO_PKG_README', 'CARGO_PKG_REPOSITORY',
  'CARGO_PKG_RUST_VERSION', 'CARGO_PKG_VERSION', 'CARGO_PKG_VERSION_MAJOR', 'CARGO_PKG_VERSION_MINOR',
  'CARGO_PKG_VERSION_PATCH', 'CARGO_PKG_VERSION_PRE', 'LD_LIBRARY_PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);

function directoryPin(directory, root) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || fs.realpathSync(directory) !== directory
      || directory === root || directory.startsWith(`${root}${path.sep}`)) fail('verification_build_directory_invalid', directory);
  const named = fs.lstatSync(directory, { bigint: true });
  if (!named.isDirectory() || named.isSymbolicLink()) fail('verification_build_directory_invalid', directory);
  return { path: directory, identity: artifactIdentity(named) };
}

function buildScriptObservation(root, artifacts, executions, packageId, label) {
  const owned = executions.filter(row => row.package_id === packageId);
  if (!artifacts.length && !owned.length) return [];
  if (artifacts.length !== 1 || owned.length !== 1 || typeof packageId !== 'string'
      || artifacts[0].packageId !== packageId) fail('verification_build_cardinality', label);
  const row = owned[0], script = artifacts[0];
  if (!Array.isArray(row.env) || row.env.length > 127) fail('verification_build_environment_invalid', label);
  const environment = { OUT_DIR: row.out_dir };
  for (const entry of row.env) {
    if (!Array.isArray(entry) || entry.length !== 2) fail('verification_build_environment_invalid', label);
    const [key, value] = entry;
    if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
        || cargoEnvironmentKeys.has(key) || key.startsWith('CARGO_BIN_EXE_')
        || Object.hasOwn(environment, key) || typeof value !== 'string'
        || value.includes('\0') || Buffer.byteLength(value) > 65536) fail('verification_build_environment_invalid', label);
    environment[key] = value;
  }
  const outDirectory = directoryPin(row.out_dir, root);
  return [{ ...script, outDirectory, environment }];
}

export function assertExactCargoOwnerExecution(selector, stdout, label) {
  if (typeof selector !== 'string' || !SAFE_RUST_TEST_PATTERN.test(selector)) fail('verification_selector_invalid', label);
  const text = stdout.replace(/\x1b\[[0-9;]*m/gu, '');
  const ownerLines = text.split(/\r?\n/u).filter((line) => line.startsWith('test ') && !line.startsWith('test result:'));
  // Qualified libtest emits this one progress notice before a long owner ends.
  // It is still covered by the complete physical stdout hash; another owner,
  // duplicate notice or notice after completion must not conceal extra tests.
  const notice = `test ${selector} has been running for over 60 seconds`;
  const notices = ownerLines.filter((line) => line === notice);
  const rows = ownerLines.filter((line) => line !== notice);
  const summaryLines = text.split(/\r?\n/u).filter((line) => line.startsWith('test result:'));
  const summaries = [...text.matchAll(
    /^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;[^\r\n]*$/gmu,
  )];
  const counts = summaries.map((row) => row.slice(1, 6).map(Number));
  const expected = `test ${selector} ... ok`;
  if (notices.length > 1 || (notices.length === 1 && ownerLines[0] !== notice)
      || rows.length !== 1 || rows[0] !== expected || summaryLines.length !== 1 || counts.length !== 1
      || counts[0].some((value) => !Number.isSafeInteger(value))
      || counts[0][0] !== 1 || counts[0].slice(1, 4).some((value) => value !== 0)) {
    fail('verification_test_execution_incomplete', `${label}:exact_owner`);
  }
  return { rows, counts: Object.fromEntries(['passed', 'failed', 'ignored', 'measured', 'filteredOut'].map((key, index) => [key, counts[0][index]])) };
}

export function artifactPin(executable, root) {
  if (!path.isAbsolute(executable) || fs.realpathSync(executable) !== executable
      || executable === root || executable.startsWith(`${root}${path.sep}`)) {
    fail('verification_artifact_path_invalid', executable);
  }
  const descriptor = fs.openSync(executable, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const identity = artifactIdentity;
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < 4n || before.size > 1024n * 1024n * 1024n
        || (before.mode & 0o111n) === 0n) fail('verification_artifact_file_invalid', executable);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let offset = 0;
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      if (offset === 0 && !buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
        fail('verification_artifact_not_elf', executable);
      }
      offset += count;
      if (offset > Number(before.size)) fail('verification_artifact_changed', executable);
      hash.update(buffer.subarray(0, count));
    }
    const named = fs.lstatSync(executable, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink()) fail('verification_artifact_path_invalid', executable);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (offset !== Number(before.size) || JSON.stringify(identity(before)) !== JSON.stringify(identity(after))
        || identity(before).some((value, index) => value !== identity(named)[index])) {
      fail('verification_artifact_changed', executable);
    }
    return { path: executable, sha256: `sha256:${hash.digest('hex')}`, identity: identity(before) };
  } finally { fs.closeSync(descriptor); }
}

export function cargoTargetObservation(root, binding, stdout, label) {
  const artifacts = [];
  const binaryArtifacts = [];
  const buildArtifacts = [];
  const buildExecutions = [];
  const tests = new Set();
  const expectedManifest = path.join(root, 'rust/crates', binding.packageName, 'Cargo.toml');
  for (const line of stdout.replace(/\x1b\[[0-9;]*m/gu, '').split(/\r?\n/u)) {
    if (line.startsWith('{')) {
      let row;
      try { row = JSON.parse(line); } catch { fail('verification_artifact_json_invalid', label); }
      if (row.reason === 'build-script-executed') {
        buildExecutions.push(row);
        continue;
      }
      if (row.reason === 'compiler-artifact' && row.manifest_path === expectedManifest
          && JSON.stringify(row.target?.kind) === '["custom-build"]') {
        if (buildArtifacts.length || row.profile?.test !== false || !Array.isArray(row.filenames)
            || row.filenames.length !== 1 || row.target.src_path !== path.join(path.dirname(expectedManifest), 'build.rs')) {
          fail('verification_build_source_invalid', label);
        }
        const sourcePath = path.relative(root, row.target.src_path), manifestPath = path.relative(root, expectedManifest);
        const sourcePin = trackedBlob(root, sourcePath), manifestPin = trackedBlob(root, manifestPath);
        readPinnedSource(root, sourcePath, sourcePin); readPinnedSource(root, manifestPath, manifestPin);
        buildArtifacts.push({ ...artifactPin(row.filenames[0], root), packageId: row.package_id,
          sourcePath, sourcePin, manifestPath, manifestPin });
        continue;
      }
      if (row.reason !== 'compiler-artifact' || !row.executable) continue;
      if (binding.targetKind === 'integration' && row.manifest_path === expectedManifest
          && row.profile?.test === false && JSON.stringify(row.target?.kind) === '["bin"]') {
        if (binaryArtifacts.length >= 128) fail('verification_binary_count_limit', label);
        const name = row.target.name;
        if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(name)) fail('verification_binary_source_invalid', label);
        const packageRoot = path.dirname(expectedManifest);
        const sources = [path.join(packageRoot, 'src/main.rs'), path.join(packageRoot, 'src/bin', `${name}.rs`),
          path.join(packageRoot, 'src/bin', name ?? '', 'main.rs')];
        if (!sources.includes(row.target.src_path)) fail('verification_binary_source_invalid', label);
        const sourcePath = path.relative(root, row.target.src_path);
        const manifestPath = path.relative(root, expectedManifest);
        const sourcePin = trackedBlob(root, sourcePath), manifestPin = trackedBlob(root, manifestPath);
        readPinnedSource(root, sourcePath, sourcePin);
        readPinnedSource(root, manifestPath, manifestPin);
        const pin = artifactPin(row.executable, root);
        const environmentKey = `CARGO_BIN_EXE_${name}`;
        if (binaryArtifacts.some(p => p.environmentKey === environmentKey || p.path === pin.path
            || p.identity.slice(0, 2).join(':') === pin.identity.slice(0, 2).join(':'))) {
          fail('verification_binary_cardinality', label);
        }
        binaryArtifacts.push({ ...pin, environmentKey, targetName: name,
          sourcePath, sourcePin, manifestPath, manifestPin });
        continue;
      }
      if (row.profile?.test !== true) continue;
      const expectedKind = binding.targetKind === 'library' ? 'lib' : 'test';
      if (row.manifest_path === expectedManifest && row.target?.kind?.length === 1
          && row.target.kind[0] === expectedKind
          && (binding.targetKind === 'library' || row.target?.name === binding.testTarget)) {
        const packageRoot = path.dirname(expectedManifest);
        const expectedSources = binding.targetKind === 'library'
          ? [path.join(packageRoot, 'src/lib.rs')]
          : [path.join(packageRoot, 'tests', `${binding.testTarget}.rs`),
            path.join(packageRoot, 'tests', binding.testTarget, 'main.rs')];
        if (!expectedSources.includes(row.target.src_path)) fail('verification_artifact_source_invalid', label);
        artifacts.push({ executable: row.executable, manifestPath: row.manifest_path, packageId: row.package_id,
          targetName: row.target.name, targetKind: row.target.kind, sourcePath: row.target.src_path });
      }
    } else if (line.endsWith(': test')) {
      const selector = line.slice(0, -': test'.length);
      if (!SAFE_RUST_TEST_PATTERN.test(selector) || tests.has(selector)) fail('verification_discovery_invalid', label);
      tests.add(selector);
    }
  }
  if (artifacts.length !== 1) fail('verification_artifact_cardinality', `${label}:${artifacts.length}`);
  return { artifact: { ...artifacts[0], ...artifactPin(artifacts[0].executable, root) },
    binaryArtifacts, buildScripts: buildScriptObservation(root, buildArtifacts, buildExecutions, artifacts[0].packageId, label), tests: [...tests] };
}

// The raw ELF pin is captured at discovery and rehashed before a receipt.
// Every owner checks the complete physical identity, including ctime; this
// shares stable binary inputs without rehashing every package binary per test.
export function assertCargoBinaryArtifactsCurrent(root, binaries, rehash = false) {
  for (const pin of binaries) {
    readPinnedSource(root, pin.sourcePath, pin.sourcePin);
    readPinnedSource(root, pin.manifestPath, pin.manifestPin);
    const named = fs.lstatSync(pin.path, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink()
        || JSON.stringify(artifactIdentity(named)) !== JSON.stringify(pin.identity)) {
      fail('verification_binary_changed', pin.environmentKey);
    }
    if (rehash && JSON.stringify(artifactPin(pin.path, root))
        !== JSON.stringify({ path: pin.path, sha256: pin.sha256, identity: pin.identity })) {
      fail('verification_binary_changed', pin.environmentKey);
    }
  }
}

export function assertCargoBuildScriptsCurrent(root, scripts, rehash = false) {
  for (const pin of scripts) {
    assertCargoBinaryArtifactsCurrent(root, [pin], rehash);
    if (JSON.stringify(directoryPin(pin.outDirectory.path, root)) !== JSON.stringify(pin.outDirectory)) {
      fail('verification_build_directory_changed', pin.outDirectory.path);
    }
  }
}

export function cargoEnvironmentObservation(root, binding, artifact, stdout, cargoPid, runtime, label, expectedEnvironment, binaries = [], scripts = []) {
  const captures = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.startsWith('{')) continue;
    const row = parseStrictJson(line, label);
    if (row.kind === 'CargoOwnerEnvironmentCaptureV1') captures.push(row);
  }
  if (captures.length !== 1) fail('verification_capture_cardinality', label);
  const row = captures[0];
  const fields = ['kind', 'version', 'processId', 'parentProcessId', 'script', 'node', 'cwd', 'executable', 'args', 'environment'];
  const actualFields = Object.keys(row).sort();
  const env = row.environment;
  const binaryEnvironment = new Map(binaries.map(pin => [pin.environmentKey, pin.path]));
  if (scripts.length > 1) fail('verification_capture_binding_invalid', label);
  const buildEnvironment = new Map(scripts.flatMap(pin => Object.entries(pin.environment)));
  const cwd = path.dirname(path.join(root, 'rust/crates', binding.packageName, 'Cargo.toml'));
  if (JSON.stringify(actualFields) !== JSON.stringify(fields.sort()) || row.version !== 1
      || !Number.isSafeInteger(row.processId) || row.processId < 1 || row.parentProcessId !== cargoPid
      || row.script !== path.join(root, SOURCE_EVIDENCE_ENTRYPOINT)
      || row.node !== runtime.node.path || row.cwd !== cwd || row.executable !== artifact.path
      || JSON.stringify(row.args) !== '["--list"]'
      || !env || Array.isArray(env) || typeof env !== 'object' || Object.keys(env).length > 128
      || Object.entries(env).some(([key, value]) => (!binaryEnvironment.has(key) && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) || typeof value !== 'string' || value.includes('\0'))
      || !expectedEnvironment
      || Object.entries(expectedEnvironment).some(([key, value]) => !cargoEnvironmentKeys.has(key) && env[key] !== value)
      || Object.keys(env).some((key) => !Object.hasOwn(expectedEnvironment, key) && !cargoEnvironmentKeys.has(key) && !binaryEnvironment.has(key) && !buildEnvironment.has(key))
      || binaryEnvironment.size !== binaries.length || binaries.length > 128
      || [...binaryEnvironment].some(([key, value]) => env[key] !== value)
      || [...buildEnvironment].some(([key, value]) => env[key] !== value)
      || Buffer.byteLength(JSON.stringify(env)) > 1024 * 1024
      || env.CARGO !== runtime.cargo.path || env.CARGO_MANIFEST_DIR !== cwd || env.CARGO_PKG_NAME !== binding.packageName
      || (env.CARGO_MANIFEST_PATH !== undefined && env.CARGO_MANIFEST_PATH !== path.join(cwd, 'Cargo.toml'))) {
    fail('verification_capture_binding_invalid', label);
  }
  return { cwd, environment: env, processId: row.processId, parentProcessId: row.parentProcessId,
    environmentSha256: hashBytes(Buffer.from(JSON.stringify(env))) };
}

export function exactCargoTestInventory(stdout, label) {
  const tests = [];
  const text = stdout.replace(/\x1b\[[0-9;]*m/gu, '');
  for (const line of text.split(/\r?\n/u)) {
    if (!line.endsWith(': test')) continue;
    const name = line.slice(0, -': test'.length);
    if (!SAFE_RUST_TEST_PATTERN.test(name) || tests.includes(name)) fail('verification_discovery_invalid', label);
    tests.push(name);
  }
  const summary = [...text.matchAll(/^(\d+) tests?, (\d+) benchmarks?$/gmu)];
  if (summary.length !== 1 || Number(summary[0][1]) !== tests.length || Number(summary[0][2]) !== 0) {
    fail('verification_discovery_invalid', label);
  }
  return tests;
}
