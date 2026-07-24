import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { inspectScopedPathSync, readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);

// A clean, official Mathlib v4.30 workspace (including the resolved Lake
// packages and compiled dependency closure) contains about 120k files. Keep a
// finite ceiling, but size the default so that the production verifier can
// close over that dependency graph instead of failing before hashing it.
export const DEFAULT_MAXIMUM_FORMAL_PROJECT_FILES = 150000;

function normalizedRelative(root, candidate) {
  const relative = path.relative(root, candidate).replace(/\\/g, '/');
  return relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative) ? relative : null;
}

function formalClosureFileRole(sourcePath, projectPath) {
  if (/(?:^|\/)\.lake\/build\//.test(sourcePath)) return 'lake_build_artifact';
  if (/(?:^|\/)\.lake\/(?!packages\/|build\/)/.test(sourcePath)) {
    return 'lake_runtime_metadata';
  }
  if (/(?:^|\/)\.lake\/packages\//.test(sourcePath)) {
    return 'lake_package_dependency';
  }
  return projectPath ? 'project' : 'external_lake_dependency';
}

function dependencyManifestDirectories(dependencyRoot, scopeRoot, blockers) {
  const manifestPath = path.join(dependencyRoot, 'lake-manifest.json');
  if (!fs.existsSync(manifestPath)) return [];
  const read = readScopedFileSync({ scopeRoot, candidate: manifestPath, maximumBytes: 16 * 1024 * 1024 });
  if (read.status !== 'scoped_file_read_verified') {
    blockers.push(`formal_dependency_manifest_unreadable:${normalizedRelative(scopeRoot, manifestPath) || 'outside'}`);
    return [];
  }
  let manifest;
  try { manifest = JSON.parse(read.content.toString('utf8')); }
  catch {
    blockers.push(`formal_dependency_manifest_json_invalid:${normalizedRelative(scopeRoot, manifestPath)}`);
    return [];
  }
  const directories = [];
  for (const entry of Array.isArray(manifest?.packages) ? manifest.packages : []) {
    let declared = String(entry?.dir || '');
    if (!declared && entry?.type === 'git') {
      const packagesDir = String(manifest?.packagesDir || '');
      const packageName = String(entry?.name || '');
      const subDirectory = entry?.subDir == null ? '' : String(entry.subDir);
      if (packagesDir && packageName) {
        declared = path.join(packagesDir, packageName, subDirectory);
      }
    }
    if (!declared) {
      blockers.push(`formal_dependency_manifest_package_dir_missing:${String(entry?.name || 'missing')}`);
      continue;
    }
    if (path.isAbsolute(declared)) {
      blockers.push(`formal_dependency_absolute_path_forbidden:${String(entry?.name || 'missing')}`);
      continue;
    }
    const resolved = path.resolve(dependencyRoot, declared);
    if (!isPathWithin(scopeRoot, resolved)) {
      blockers.push(`formal_dependency_path_outside_source_scope:${String(entry?.name || 'missing')}`);
      continue;
    }
    const identity = inspectScopedPathSync({ scopeRoot, candidate: resolved, expect: 'directory', forbidHardlinks: false });
    if (identity.status !== 'scoped_file_identity_verified') {
      blockers.push(`formal_dependency_path_unsafe:${String(entry?.name || 'missing')}`);
      continue;
    }
    directories.push(resolved);
  }
  return directories;
}

function dependencyRoots(projectRoot, scopeRoot, blockers) {
  // Lake's workspace manifest is the resolved, flattened dependency graph.
  // Recursing into a package's own source manifest would resolve its
  // `packagesDir` relative to the wrong workspace and can silently omit the
  // actual root-level package closure. Dependencies already below the project
  // root are covered by the project walk; only explicitly external path
  // dependencies need additional roots.
  const roots = [projectRoot];
  for (const dependency of dependencyManifestDirectories(
    projectRoot, scopeRoot, blockers,
  )) {
    if (!isPathWithin(projectRoot, dependency)) roots.push(dependency);
    if (roots.length > 256) {
      blockers.push('formal_dependency_package_count_exceeded');
      break;
    }
  }
  return [...new Map(roots.map((candidate) => (
    [fs.realpathSync.native(candidate), candidate]
  ))).values()];
}

export function readFormalProjectClosureSync({
  projectRoot,
  dependencyScopeRoot = projectRoot,
  maximumFiles = DEFAULT_MAXIMUM_FORMAL_PROJECT_FILES,
  maximumBytes = 8 * 1024 * 1024 * 1024,
} = {}) {
  const root = path.resolve(projectRoot || '.');
  const scopeRoot = path.resolve(dependencyScopeRoot || root);
  const blockers = [];
  const projectIdentity = inspectScopedPathSync({ scopeRoot, candidate: root, expect: 'directory', forbidHardlinks: false });
  if (projectIdentity.status !== 'scoped_file_identity_verified') {
    return Object.freeze({ status: 'formal_project_closure_blocked', files: Object.freeze([]), blockers: Object.freeze(['formal_project_root_outside_dependency_scope']) });
  }
  const roots = dependencyRoots(root, scopeRoot, blockers);
  const fileCandidates = new Map();

  const visit = (directory, {
    insideLakeDirectory = false,
    insideLakePackages = false,
    insideLakeBuild = false,
  } = {}) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = normalizedRelative(scopeRoot, absolute);
      if (!relative) {
        blockers.push('formal_project_closure_path_escape');
        continue;
      }
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        blockers.push(`formal_project_symlink_forbidden:${relative}`);
        continue;
      }
      if (stat.isDirectory()) {
        if (entry.name === '.lake') {
          visit(absolute, {
            insideLakeDirectory: true,
            insideLakePackages,
            insideLakeBuild,
          });
          continue;
        }
        visit(absolute, {
          insideLakeDirectory,
          insideLakePackages: insideLakePackages || (
            insideLakeDirectory && entry.name === 'packages'
          ),
          insideLakeBuild: insideLakeBuild || (
            insideLakeDirectory && entry.name === 'build'
          ),
        });
      } else if (stat.isFile()) {
        if (insideLakeDirectory
          && /(?:\.lock|\.tmp|\.pending)(?:\.[A-Za-z0-9_-]+)?$/.test(entry.name)) {
          continue;
        }
        fileCandidates.set(relative, absolute);
      } else blockers.push(`formal_project_special_file_forbidden:${relative}`);
      if (fileCandidates.size > maximumFiles) throw new Error('formal_project_file_count_exceeded');
    }
  };

  try {
    for (const dependencyRoot of roots) visit(dependencyRoot);
  } catch (error) {
    blockers.push(error?.message || 'formal_project_closure_walk_failed');
  }
  const files = [];
  let totalBytes = 0;
  for (const [sourcePath, absolute] of [...fileCandidates.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const beforeIdentity = inspectScopedPathSync({
      scopeRoot,
      candidate: absolute,
      expect: 'file',
      forbidHardlinks: true,
    });
    const read = readScopedFileSync({ scopeRoot, candidate: absolute });
    const afterIdentity = inspectScopedPathSync({
      scopeRoot,
      candidate: absolute,
      expect: 'file',
      forbidHardlinks: true,
    });
    if (read.status !== 'scoped_file_read_verified'
      || beforeIdentity.status !== 'scoped_file_identity_verified'
      || afterIdentity.status !== 'scoped_file_identity_verified'
      || beforeIdentity.scopedFileIdentityHash !== afterIdentity.scopedFileIdentityHash) {
      blockers.push(`formal_project_file_read_blocked:${sourcePath}`);
      continue;
    }
    const posixMode = Number(BigInt(afterIdentity.identity.mode) & 0o777n);
    totalBytes += read.bytes;
    if (totalBytes > maximumBytes) {
      blockers.push('formal_project_total_bytes_exceeded');
      break;
    }
    const projectPath = isPathWithin(root, absolute) ? normalizedRelative(root, absolute) : null;
    files.push(Object.freeze({
      path: projectPath || `@external/${sourcePath}`,
      sourcePath,
      projectPath,
      role: formalClosureFileRole(sourcePath, projectPath),
      hash: read.hash,
      bytes: read.bytes,
      posixMode,
      scopedFileReadReceiptHash: read.scopedFileReadReceiptHash,
    }));
  }
  const sortedBlockers = [...new Set(blockers)];
  const manifestRecords = files.map(({ path: filePath, sourcePath, projectPath, role, hash, bytes, posixMode }) => ({ path: filePath, sourcePath, projectPath, role, hash, bytes, posixMode }));
  const payload = {
    version: 1,
    kind: 'FormalProjectClosure',
    status: sortedBlockers.length ? 'formal_project_closure_blocked' : 'formal_project_closure_verified',
    projectScopePath: normalizedRelative(scopeRoot, root) || '.',
    fileCount: files.length,
    totalBytes,
    externalDependencyFileCount: files.filter((file) => !file.projectPath).length,
    lakePackageFileCount: files.filter((file) => file.role === 'lake_package_dependency').length,
    lakeBuildArtifactFileCount:
      files.filter((file) => file.role === 'lake_build_artifact').length,
    manifestHash: hashRecord('FormalProjectClosureManifest', manifestRecords),
    blockers: sortedBlockers,
  };
  return Object.freeze({ ...payload, files: Object.freeze(files), formalProjectClosureHash: hashRecord('FormalProjectClosure', payload) });
}

export async function readFormalProjectClosure(options = {}) {
  return readFormalProjectClosureSync(options);
}
