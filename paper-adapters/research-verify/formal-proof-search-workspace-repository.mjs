import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  readFormalProjectClosure,
  readFormalProjectClosureSync,
} from './formal-project-closure-reader.mjs';
import { createFormalProjectSnapshotRepository } from './formal-project-snapshot-repository.mjs';

const SAFE_LEAN_SOURCE = /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*\.lean$/;

function closureFileIdentity(file) {
  return Object.freeze({
    sourcePath: file.sourcePath,
    projectPath: file.projectPath,
    role: file.role,
    hash: file.hash,
    bytes: file.bytes,
    posixMode: file.posixMode,
  });
}

function writeImmutableFile(root, relative, content) {
  const destination = path.join(root, relative);
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(
    destination,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function minimalProjectFiles(toolchain) {
  return Object.freeze([
    Object.freeze({
      relative: 'lakefile.lean',
      content: ['import Lake', 'open Lake DSL', 'package heptaFormalSearch where', ''].join('\n'),
    }),
    Object.freeze({ relative: 'lean-toolchain', content: `${toolchain}\n` }),
    Object.freeze({
      relative: 'lake-manifest.json',
      content: `${JSON.stringify({
        version: '1.1.0',
        packagesDir: '.lake/packages',
        packages: [],
        name: 'heptaFormalSearch',
        lakeDir: '.lake',
      }, null, 2)}\n`,
    }),
  ]);
}

function existingRegularFileHash(candidate) {
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1) return null;
    return hashBytes(fs.readFileSync(candidate));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function createFormalProofSearchWorkspaceRepository({
  temporaryRoot = os.tmpdir(),
  toolchain,
} = {}) {
  const temporaryScope = fs.realpathSync(path.resolve(temporaryRoot));
  const roots = new Map();

  function register(project, cleanup, authoritativeClosure = null) {
    const root = fs.realpathSync(project.root);
    const relative = path.relative(temporaryScope, root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      cleanup();
      throw new Error('formal_proof_search_workspace_scope_invalid');
    }
    const baseline = readFormalProjectClosureSync({
      projectRoot: root,
      dependencyScopeRoot: project.scopeRoot || root,
    });
    if (baseline.status !== 'formal_project_closure_verified') {
      cleanup();
      throw new Error(`formal_proof_search_snapshot_closure_invalid:${baseline.blockers.join(',')}`);
    }
    if (authoritativeClosure) {
      const sourceFiles = authoritativeClosure.files.map((file) => Object.freeze({
        ...closureFileIdentity(file),
        posixMode: file.posixMode & 0o555,
      }));
      const snapshotFiles = baseline.files.map(closureFileIdentity);
      if (JSON.stringify(sourceFiles) !== JSON.stringify(snapshotFiles)) {
        cleanup();
        throw new Error('formal_proof_search_snapshot_authority_copy_mismatch');
      }
    }
    roots.set(root, {
      cleanup,
      baselineFiles: baseline.files.map(closureFileIdentity),
      authoritativeFormalProjectClosureHash:
        authoritativeClosure?.formalProjectClosureHash || baseline.formalProjectClosureHash,
      authoritativeFormalProjectManifestHash:
        authoritativeClosure?.manifestHash || baseline.manifestHash,
      stagedSources: new Map(),
      scopeRoot: project.scopeRoot || root,
      seal: typeof project.seal === 'function' ? project.seal : null,
      sealReceipt: null,
    });
    let cleaned = false;
    return Object.freeze({
      ...project,
      root,
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        roots.delete(root);
        cleanup();
      },
    });
  }

  async function materialize({
    workspace = null,
    dependencyScopeRoot = workspace,
    expectedFormalProjectClosureHash = null,
    imports = [],
  } = {}) {
    const required = ['lakefile.lean', 'lean-toolchain', 'lake-manifest.json'];
    if (workspace && required.every((relative) => fs.existsSync(path.join(workspace, relative)))) {
      const closure = await readFormalProjectClosure({
        projectRoot: workspace,
        dependencyScopeRoot,
      });
      if (closure.status === 'formal_project_closure_verified'
        && (!expectedFormalProjectClosureHash
          || closure.formalProjectClosureHash === expectedFormalProjectClosureHash)) {
        const snapshot = createFormalProjectSnapshotRepository({
          temporaryRoot: temporaryScope,
        }).materialize({
          projectRoot: workspace,
          dependencyScopeRoot,
          projectFiles: closure.files,
        });
        return register({
          ...snapshot,
          imports: Object.freeze([...imports]),
          formalProjectClosureHash: closure.formalProjectClosureHash,
        }, snapshot.cleanup, closure);
      }
      if (expectedFormalProjectClosureHash) {
        throw new Error('formal_proof_search_project_closure_authority_mismatch');
      }
    }
    if (expectedFormalProjectClosureHash) {
      throw new Error('formal_proof_search_project_closure_authority_mismatch');
    }

    const root = fs.mkdtempSync(path.join(temporaryScope, 'hepta-formal-search-source-'));
    fs.chmodSync(root, 0o700);
    try {
      for (const file of minimalProjectFiles(toolchain)) {
        writeImmutableFile(root, file.relative, file.content);
      }
      return register({
        version: 1,
        kind: 'FormalProofSearchWorkspace',
        root,
        scopeRoot: root,
        imports: Object.freeze([...imports]),
      }, () => fs.rmSync(root, { recursive: true, force: true }));
    } catch (error) {
      fs.rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  function stageLeanSource({ projectRoot, relative, source } = {}) {
    const root = fs.realpathSync(path.resolve(projectRoot || '.'));
    const registration = roots.get(root);
    if (!registration) throw new Error('formal_proof_search_workspace_not_authorized');
    if (!SAFE_LEAN_SOURCE.test(String(relative || ''))) {
      throw new Error('formal_proof_search_source_path_invalid');
    }
    const destination = path.join(root, relative);
    const sourceBuffer = Buffer.from(String(source || ''), 'utf8');
    const expectedHash = hashBytes(sourceBuffer);
    const existingHash = existingRegularFileHash(destination);
    if (existingHash === undefined) writeImmutableFile(root, relative, sourceBuffer);
    else if (existingHash !== expectedHash) {
      throw new Error('formal_proof_search_source_collision');
    }
    const sourcePath = path.relative(registration.scopeRoot, destination).replace(/\\/g, '/');
    const projectPath = path.relative(root, destination).replace(/\\/g, '/');
    const stagedIdentity = Object.freeze({
      sourcePath,
      projectPath,
      role: 'project',
      hash: expectedHash,
      bytes: sourceBuffer.length,
      posixMode: existingHash === undefined ? 0o600
        : fs.lstatSync(destination).mode & 0o777,
    });
    const baselineIdentity = registration.baselineFiles.find((file) => (
      file.sourcePath === sourcePath
    ));
    if (baselineIdentity && JSON.stringify(baselineIdentity) !== JSON.stringify(stagedIdentity)) {
      throw new Error('formal_proof_search_source_collision');
    }
    if (!baselineIdentity) registration.stagedSources.set(sourcePath, stagedIdentity);
    return Object.freeze({
      version: 1,
      kind: 'FormalProofSearchStagedLeanSource',
      relative,
      sourceHash: expectedHash,
    });
  }

  function assertExecutionSnapshotCurrent({ projectRoot } = {}) {
    const root = fs.realpathSync(path.resolve(projectRoot || '.'));
    const registration = roots.get(root);
    if (!registration) throw new Error('formal_proof_search_workspace_not_authorized');
    const current = readFormalProjectClosureSync({
      projectRoot: root,
      dependencyScopeRoot: registration.scopeRoot,
    });
    if (current.status !== 'formal_project_closure_verified') {
      throw new Error(`formal_execution_snapshot_closure_invalid:${current.blockers.join(',')}`);
    }
    const expectedByPath = new Map(registration.baselineFiles.map((file) => (
      [file.sourcePath, file]
    )));
    for (const [sourcePath, file] of registration.stagedSources) {
      const existing = expectedByPath.get(sourcePath);
      if (existing && JSON.stringify(existing) !== JSON.stringify(file)) {
        throw new Error('formal_execution_snapshot_staged_source_collision');
      }
      expectedByPath.set(sourcePath, file);
    }
    const expected = [...expectedByPath.values()]
      .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
    const actual = current.files.map(closureFileIdentity)
      .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error('formal_execution_snapshot_authority_drift');
    }
    const stagedSources = Object.freeze([...registration.stagedSources.values()]
      .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)));
    const payload = {
      version: 1,
      kind: 'FormalExecutionSnapshotReceipt',
      status: 'formal_execution_snapshot_verified',
      authoritativeFormalProjectClosureHash:
        registration.authoritativeFormalProjectClosureHash,
      authoritativeFormalProjectManifestHash:
        registration.authoritativeFormalProjectManifestHash,
      baselineFileCount: registration.baselineFiles.length,
      stagedSources,
      currentFileCount: current.fileCount,
      currentManifestHash: current.manifestHash,
      blockers: Object.freeze([]),
      formalProjectSnapshotSealReceipt: registration.sealReceipt,
    };
    return Object.freeze({
      ...payload,
      formalExecutionSnapshotReceiptHash:
        hashRecord('FormalExecutionSnapshotReceipt', payload),
    });
  }

  function sealExecutionSnapshot({ projectRoot } = {}) {
    const root = fs.realpathSync(path.resolve(projectRoot || '.'));
    const registration = roots.get(root);
    if (!registration) throw new Error('formal_proof_search_workspace_not_authorized');
    if (!registration.seal) throw new Error('formal_execution_snapshot_seal_unavailable');
    if (!registration.sealReceipt) registration.sealReceipt = registration.seal();
    const current = readFormalProjectClosureSync({
      projectRoot: root,
      dependencyScopeRoot: registration.scopeRoot,
    });
    if (current.status !== 'formal_project_closure_verified') {
      throw new Error('formal_execution_snapshot_seal_closure_invalid');
    }
    const currentByPath = new Map(current.files.map((file) => (
      [file.sourcePath, closureFileIdentity(file)]
    )));
    const update = (file) => {
      const sealed = currentByPath.get(file.sourcePath);
      if (!sealed || sealed.hash !== file.hash || sealed.bytes !== file.bytes
        || sealed.projectPath !== file.projectPath || sealed.role !== file.role
        || (sealed.posixMode & 0o222) !== 0) {
        throw new Error('formal_execution_snapshot_seal_identity_mismatch');
      }
      return sealed;
    };
    registration.baselineFiles = registration.baselineFiles.map(update);
    registration.stagedSources = new Map([...registration.stagedSources]
      .map(([sourcePath, file]) => [sourcePath, update(file)]));
    return registration.sealReceipt;
  }

  return Object.freeze({
    version: 1,
    kind: 'FormalProofSearchWorkspaceRepository',
    materialize,
    stageLeanSource,
    sealExecutionSnapshot,
    assertExecutionSnapshotCurrent,
  });
}

export function verifyFormalExecutionSnapshotReceipt(receipt, {
  formalProjectClosureHash,
  formalProjectManifestHash,
  requireNoStagedSources = false,
} = {}) {
  const { formalExecutionSnapshotReceiptHash, ...payload } = receipt || {};
  const staged = Array.isArray(receipt?.stagedSources) ? receipt.stagedSources : [];
  const seal = receipt?.formalProjectSnapshotSealReceipt;
  const { formalProjectSnapshotSealReceiptHash, ...sealPayload } = seal || {};
  return receipt?.version === 1
    && receipt?.kind === 'FormalExecutionSnapshotReceipt'
    && receipt?.status === 'formal_execution_snapshot_verified'
    && formalExecutionSnapshotReceiptHash
      === hashRecord('FormalExecutionSnapshotReceipt', payload)
    && receipt.authoritativeFormalProjectClosureHash === formalProjectClosureHash
    && receipt.authoritativeFormalProjectManifestHash === formalProjectManifestHash
    && Number.isSafeInteger(receipt.baselineFileCount)
    && receipt.baselineFileCount > 0
    && receipt.currentFileCount === receipt.baselineFileCount + staged.length
    && seal?.status === 'formal_project_snapshot_sealed'
    && formalProjectSnapshotSealReceiptHash
      === hashRecord('FormalProjectSnapshotSealReceipt', sealPayload)
    && seal.writableFileCount === 0
    && seal.writableDirectoryCount === 0
    && seal.fileCount === receipt.currentFileCount
    && Number.isSafeInteger(seal.directoryCount) && seal.directoryCount > 0
    && /^sha256:[0-9a-f]{64}$/.test(String(seal.fileManifestHash || ''))
    && /^sha256:[0-9a-f]{64}$/.test(String(seal.directoryManifestHash || ''))
    && seal.deterministicSourceMtimeMs === Date.UTC(2000, 0, 1)
    && seal.deterministicCompiledMtimeMs === Date.UTC(2000, 0, 2)
    && Array.isArray(receipt.blockers) && receipt.blockers.length === 0
    && (!requireNoStagedSources || staged.length === 0)
    && staged.every((file) => typeof file?.sourcePath === 'string'
      && typeof file?.projectPath === 'string'
      && file.role === 'project'
      && /^sha256:[0-9a-f]{64}$/.test(String(file.hash || ''))
      && Number.isSafeInteger(file.bytes) && file.bytes >= 0
      && Number.isInteger(file.posixMode));
}
