import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const MAXIMUM_OUTPUT_BYTES = 8 * 1024 * 1024;
const STRICT_TEMPORARY_PARENT = '/tmp';
const STRICT_TEMPORARY_PARENT_MODE = 0o1777;
const WORKSPACE_DOCUMENTS = Object.freeze(['package.json', 'package-lock.json']);
export const STRICT_NPM_AUDIT_NODE_EXECUTABLE = '/usr/bin/node';
export const STRICT_NPM_AUDIT_NPM_EXECUTABLE =
  '/usr/lib/node_modules/npm/bin/npm-cli.js';
const FORBIDDEN_ENVIRONMENT_NAMES = Object.freeze([
  'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'SSL_CERT_FILE',
  'SSL_CERT_DIR', 'OPENSSL_CONF', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'npm_config_proxy',
  'npm_config_https_proxy', 'npm_config_noproxy', 'npm_config_registry',
  'npm_config_strict_ssl', 'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY',
  'NPM_CONFIG_NOPROXY', 'NPM_CONFIG_REGISTRY', 'NPM_CONFIG_STRICT_SSL',
]);
const APPROVED_INHERITED_ENVIRONMENT_VALUES = Object.freeze({
  NODE_OPTIONS: Object.freeze(new Set(['--dns-result-order=ipv4first'])),
});

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function nodeIdentity(stat) {
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: Number(stat.mode) & 0o7777,
  });
}

function sameNode(stat, identity) {
  return String(stat.dev) === identity.device && String(stat.ino) === identity.inode;
}

function assertTrustedTemporaryParent() {
  const stat = fs.lstatSync(STRICT_TEMPORARY_PARENT, { bigint: true });
  if (fs.realpathSync(STRICT_TEMPORARY_PARENT) !== STRICT_TEMPORARY_PARENT
    || stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== 0n || stat.gid !== 0n
    || (Number(stat.mode) & 0o7777) !== STRICT_TEMPORARY_PARENT_MODE) {
    throw codedError('strict_npm_audit_temporary_parent_invalid');
  }
  return nodeIdentity(stat);
}

function assertPrivateTemporaryDirectory(candidate, identity, { uid, gid }) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  if (fs.realpathSync(candidate) !== candidate || stat.isSymbolicLink() || !stat.isDirectory()
    || !sameNode(stat, identity) || Number(stat.uid) !== uid || Number(stat.gid) !== gid
    || (Number(stat.mode) & 0o7777) !== 0o700) {
    throw codedError('strict_npm_audit_temporary_directory_changed');
  }
}

function createPrivateAuditDirectories({ uid = process.getuid(), gid = process.getgid() } = {}) {
  const parentIdentity = assertTrustedTemporaryParent();
  let root = null;
  let rootIdentity = null;
  let home = null;
  let homeIdentity = null;
  let cache = null;
  let cacheIdentity = null;
  try {
    root = fs.mkdtempSync(`${STRICT_TEMPORARY_PARENT}/hepta-strict-npm-audit.`);
    fs.chmodSync(root, 0o700);
    rootIdentity = nodeIdentity(fs.lstatSync(root, { bigint: true }));
    assertPrivateTemporaryDirectory(root, rootIdentity, { uid, gid });
    home = fs.mkdtempSync(path.join(root, 'home.'));
    fs.chmodSync(home, 0o700);
    homeIdentity = nodeIdentity(fs.lstatSync(home, { bigint: true }));
    assertPrivateTemporaryDirectory(home, homeIdentity, { uid, gid });
    cache = fs.mkdtempSync(path.join(root, 'cache.'));
    fs.chmodSync(cache, 0o700);
    cacheIdentity = nodeIdentity(fs.lstatSync(cache, { bigint: true }));
    assertPrivateTemporaryDirectory(cache, cacheIdentity, { uid, gid });
    const parentAfter = fs.lstatSync(STRICT_TEMPORARY_PARENT, { bigint: true });
    if (!sameNode(parentAfter, parentIdentity)) {
      throw codedError('strict_npm_audit_temporary_parent_changed');
    }
  } catch (error) {
    if (root !== null && rootIdentity !== null) {
      try {
        assertPrivateTemporaryDirectory(root, rootIdentity, { uid, gid });
        fs.rmSync(root, { recursive: true, force: false });
      } catch (cleanupError) {
        error.cleanupError = cleanupError;
      }
    }
    throw error;
  }
  return Object.freeze({
    home,
    cache,
    cleanup() {
      assertPrivateTemporaryDirectory(root, rootIdentity, { uid, gid });
      assertPrivateTemporaryDirectory(home, homeIdentity, { uid, gid });
      assertPrivateTemporaryDirectory(cache, cacheIdentity, { uid, gid });
      fs.rmSync(root, { recursive: true, force: false });
      const parentAfter = fs.lstatSync(STRICT_TEMPORARY_PARENT, { bigint: true });
      if (!sameNode(parentAfter, parentIdentity)) {
        throw codedError('strict_npm_audit_temporary_parent_changed');
      }
      return true;
    },
  });
}

function regularDocumentIdentity(root, name) {
  const candidate = path.join(root, name);
  let descriptor;
  try {
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | NO_FOLLOW);
    const before = fs.fstatSync(descriptor, { bigint: true });
    const atPath = fs.lstatSync(candidate, { bigint: true });
    if (!before.isFile() || atPath.isSymbolicLink() || !atPath.isFile()
      || before.dev !== atPath.dev || before.ino !== atPath.ino || before.nlink !== 1n) {
      throw codedError(`strict_npm_audit_workspace_document_invalid:${name}`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || BigInt(bytes.length) !== before.size) {
      throw codedError(`strict_npm_audit_workspace_document_changed:${name}`);
    }
    return Object.freeze({
      ...nodeIdentity(before),
      links: String(before.nlink),
      size: String(before.size),
      mtimeNs: String(before.mtimeNs),
      ctimeNs: String(before.ctimeNs),
      contentHash: hashBytes(bytes),
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function captureWorkspaceDocuments(root) {
  return Object.freeze(Object.fromEntries(
    WORKSPACE_DOCUMENTS.map((name) => [name, regularDocumentIdentity(root, name)]),
  ));
}

function assertWorkspaceDocumentsUnchanged(root, expected) {
  for (const name of WORKSPACE_DOCUMENTS) {
    if (JSON.stringify(regularDocumentIdentity(root, name)) !== JSON.stringify(expected[name])) {
      throw codedError(`strict_npm_audit_workspace_document_changed:${name}`);
    }
  }
}

function executableIdentity(file, { expectedUid = 0, expectedGid = 0 } = {}) {
  const selected = path.resolve(file);
  if (!path.isAbsolute(file) || selected !== file || fs.realpathSync(file) !== file) {
    throw codedError('strict_npm_audit_executable_path_invalid');
  }
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
    const before = fs.fstatSync(descriptor, { bigint: true });
    const atPath = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || atPath.isSymbolicLink() || !atPath.isFile()
      || before.dev !== atPath.dev || before.ino !== atPath.ino || before.nlink !== 1n
      || Number(before.uid) !== expectedUid || Number(before.gid) !== expectedGid
      || (Number(before.mode) & 0o022) !== 0) {
      throw codedError('strict_npm_audit_executable_identity_invalid');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || BigInt(bytes.length) !== before.size) {
      throw codedError('strict_npm_audit_executable_changed_during_read');
    }
    return Object.freeze({
      path: file,
      uid: expectedUid,
      gid: expectedGid,
      mode: Number(before.mode) & 0o7777,
      contentHash: hashBytes(bytes),
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function buildStrictNpmAuditInvocation({
  workspaceRoot,
  npmExecPath,
  nodeExecPath = process.execPath,
  homePath = '/nonexistent',
  cachePath = '/nonexistent/cache',
  expectedExecutableUid = 0,
  expectedExecutableGid = 0,
  executableInspector = executableIdentity,
} = {}) {
  const root = fs.realpathSync(workspaceRoot);
  if (path.resolve(workspaceRoot) !== workspaceRoot || root !== workspaceRoot) {
    throw codedError('strict_npm_audit_workspace_root_invalid');
  }
  if (nodeExecPath !== STRICT_NPM_AUDIT_NODE_EXECUTABLE
    || npmExecPath !== STRICT_NPM_AUDIT_NPM_EXECUTABLE) {
    throw codedError('strict_npm_audit_executable_not_approved');
  }
  const node = executableInspector(nodeExecPath, {
    expectedUid: expectedExecutableUid,
    expectedGid: expectedExecutableGid,
  });
  const npm = executableInspector(npmExecPath, {
    expectedUid: expectedExecutableUid,
    expectedGid: expectedExecutableGid,
  });
  const argv = Object.freeze([
    '--dns-result-order=ipv4first',
    '--no-network-family-autoselection',
    npm.path,
    'audit',
    '--registry=https://registry.npmjs.org/',
    '--strict-ssl=true',
    '--audit-level=high',
    '--package-lock-only',
    '--ignore-scripts',
  ]);
  const environment = Object.freeze({
    PATH: '/usr/bin:/bin',
    HOME: homePath,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    npm_config_cache: cachePath,
  });
  return Object.freeze({
    version: 1,
    kind: 'StrictNpmAuditInvocation',
    command: node.path,
    argv,
    cwd: root,
    environment,
    nodeIdentityHash: hashRecord('StrictNpmAuditNodeIdentity', node),
    npmIdentityHash: hashRecord('StrictNpmAuditNpmIdentity', npm),
  });
}

export function runStrictNpmAudit({
  workspaceRoot = process.cwd(),
  environment = process.env,
  npmExecPath = environment.npm_execpath,
  nodeExecPath = process.execPath,
  expectedExecutableUid = 0,
  expectedExecutableGid = 0,
  executableInspector = executableIdentity,
  spawn = spawnSync,
} = {}) {
  if (typeof npmExecPath !== 'string' || !npmExecPath) {
    throw codedError('strict_npm_audit_npm_execpath_required');
  }
  for (const name of FORBIDDEN_ENVIRONMENT_NAMES) {
    const value = String(environment[name] ?? '');
    const approvedValues = APPROVED_INHERITED_ENVIRONMENT_VALUES[name];
    if (Object.hasOwn(environment, name) && value !== ''
      && !approvedValues?.has(value)) {
      throw codedError(`strict_npm_audit_inherited_environment_forbidden:${name}`);
    }
  }
  const root = fs.realpathSync(path.resolve(workspaceRoot));
  const documentSnapshot = captureWorkspaceDocuments(root);
  const temporary = createPrivateAuditDirectories();
  try {
    const invocation = buildStrictNpmAuditInvocation({
      workspaceRoot: root,
      npmExecPath,
      nodeExecPath,
      homePath: temporary.home,
      cachePath: temporary.cache,
      expectedExecutableUid,
      expectedExecutableGid,
      executableInspector,
    });
    const result = spawn(invocation.command, invocation.argv, {
      cwd: invocation.cwd,
      env: invocation.environment,
      encoding: 'utf8',
      shell: false,
      maxBuffer: MAXIMUM_OUTPUT_BYTES,
    });
    assertWorkspaceDocumentsUnchanged(root, documentSnapshot);
    if (result.error || result.signal || result.status !== 0) {
      throw codedError('strict_npm_audit_failed', {
        exitStatus: result.status,
        signal: result.signal || null,
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || ''),
      });
    }
    return Object.freeze({
      status: 'strict_npm_audit_verified',
      invocation,
      exitStatus: 0,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
    });
  } finally {
    try {
      assertWorkspaceDocumentsUnchanged(root, documentSnapshot);
    } finally {
      temporary.cleanup();
    }
  }
}
