import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fail } from './source-evidence-git-inputs.mjs';
import { parseStrictJson } from './source-evidence-strict-json.mjs';
import { hashBytes, SOURCE_EVIDENCE_ENTRYPOINT } from './source-evidence-producer.mjs';

export const SAFE_RUST_TEST_PATTERN = /^[A-Za-z0-9_:]+$/;

export function assertExactCargoOwnerExecution(selector, stdout, label) {
  if (typeof selector !== 'string' || !SAFE_RUST_TEST_PATTERN.test(selector)) fail('verification_selector_invalid', label);
  const text = stdout.replace(/\x1b\[[0-9;]*m/gu, '');
  const rows = text.split(/\r?\n/u).filter((line) => line.startsWith('test ') && !line.startsWith('test result:'));
  const summaryLines = text.split(/\r?\n/u).filter((line) => line.startsWith('test result:'));
  const summaries = [...text.matchAll(
    /^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;[^\r\n]*$/gmu,
  )];
  const counts = summaries.map((row) => row.slice(1, 6).map(Number));
  const expected = `test ${selector} ... ok`;
  if (rows.length !== 1 || rows[0] !== expected || summaryLines.length !== 1 || counts.length !== 1
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
  const identity = (value) => [value.dev, value.ino, value.mode, value.uid, value.gid,
    value.nlink, value.size, value.mtimeNs, value.ctimeNs].map(String);
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
  const tests = new Set();
  for (const line of stdout.replace(/\x1b\[[0-9;]*m/gu, '').split(/\r?\n/u)) {
    if (line.startsWith('{')) {
      let row;
      try { row = JSON.parse(line); } catch { fail('verification_artifact_json_invalid', label); }
      if (row.reason !== 'compiler-artifact' || row.profile?.test !== true || !row.executable) continue;
      const expectedManifest = path.join(root, 'rust/crates', binding.packageName, 'Cargo.toml');
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
        artifacts.push({ executable: row.executable, manifestPath: row.manifest_path,
          targetName: row.target.name, targetKind: row.target.kind, sourcePath: row.target.src_path });
      }
    } else if (line.endsWith(': test')) {
      const selector = line.slice(0, -': test'.length);
      if (!SAFE_RUST_TEST_PATTERN.test(selector) || tests.has(selector)) fail('verification_discovery_invalid', label);
      tests.add(selector);
    }
  }
  if (artifacts.length !== 1) fail('verification_artifact_cardinality', `${label}:${artifacts.length}`);
  return { artifact: { ...artifacts[0], ...artifactPin(artifacts[0].executable, root) }, tests: [...tests] };
}

export function cargoEnvironmentObservation(root, binding, artifact, stdout, cargoPid, runtime, label, expectedEnvironment) {
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
  const cwd = path.dirname(path.join(root, 'rust/crates', binding.packageName, 'Cargo.toml'));
  const cargoEnvironmentKeys = new Set(['CARGO', 'CARGO_MANIFEST_DIR', 'CARGO_MANIFEST_PATH',
    'CARGO_PKG_AUTHORS', 'CARGO_PKG_DESCRIPTION', 'CARGO_PKG_HOMEPAGE', 'CARGO_PKG_LICENSE',
    'CARGO_PKG_LICENSE_FILE', 'CARGO_PKG_NAME', 'CARGO_PKG_README', 'CARGO_PKG_REPOSITORY',
    'CARGO_PKG_RUST_VERSION', 'CARGO_PKG_VERSION', 'CARGO_PKG_VERSION_MAJOR', 'CARGO_PKG_VERSION_MINOR',
    'CARGO_PKG_VERSION_PATCH', 'CARGO_PKG_VERSION_PRE', 'LD_LIBRARY_PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);
  if (JSON.stringify(actualFields) !== JSON.stringify(fields.sort()) || row.version !== 1
      || !Number.isSafeInteger(row.processId) || row.processId < 1 || row.parentProcessId !== cargoPid
      || row.script !== path.join(root, SOURCE_EVIDENCE_ENTRYPOINT)
      || row.node !== runtime.node.path || row.cwd !== cwd || row.executable !== artifact.path
      || JSON.stringify(row.args) !== '["--list"]'
      || !env || Array.isArray(env) || typeof env !== 'object' || Object.keys(env).length > 128
      || Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== 'string' || value.includes('\0'))
      || !expectedEnvironment
      || Object.entries(expectedEnvironment).some(([key, value]) => !cargoEnvironmentKeys.has(key) && env[key] !== value)
      || Object.keys(env).some((key) => !Object.hasOwn(expectedEnvironment, key) && !cargoEnvironmentKeys.has(key))
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

