import fs from 'node:fs';
import path from 'node:path';
import {
  buildSourcePackageManifest as buildSourcePackageValueManifest,
  isSafeSourcePackageRelativePath,
  resolveSourcePackageContract as resolveSourcePackageValueContract,
} from '../../paper-domain/quality/source-package-contract.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';

function mainTexRelative(sourceRoot, rawMainTex) {
  const root = path.resolve(sourceRoot || '.');
  const raw = String(rawMainTex || 'main.tex');
  const parentRelative = path.resolve(path.dirname(root), raw);
  const absolute = path.isAbsolute(raw)
    ? path.resolve(raw)
    : (parentRelative.startsWith(`${root}${path.sep}`) ? parentRelative : path.resolve(root, raw));
  return path.relative(root, absolute).replace(/\\/g, '/');
}

export function resolveSourcePackageContract({ sourceRoot, paperTask, contract = null } = {}) {
  const contractPath = sourceRoot ? path.join(sourceRoot, 'SOURCE_PACKAGE_CONTRACT.json') : null;
  let declared = contract || paperTask?.registry?.sourcePackageContract || null;
  let contractFileHash = null;
  if (!declared && contractPath && fs.existsSync(contractPath)) {
    const read = readScopedFileSync({ scopeRoot: sourceRoot, candidate: contractPath, maximumBytes: 1024 * 1024 });
    if (read.status === 'scoped_file_read_verified') {
      try {
        declared = JSON.parse(read.content.toString('utf8'));
        contractFileHash = read.hash;
      } catch {
        declared = null;
      }
    }
  }
  return resolveSourcePackageValueContract({
    paperTask,
    contract: declared,
    contractFileHash,
    mainTexRelative: mainTexRelative(sourceRoot, paperTask?.mainTex),
  });
}

export function buildSourcePackageManifest({ sourceRoot, sourcePackageContract } = {}) {
  const fileRecords = [];
  for (const item of sourcePackageContract?.files || []) {
    if (!isSafeSourcePackageRelativePath(item.path)) continue;
    const read = readScopedFileSync({
      scopeRoot: sourceRoot,
      candidate: path.join(sourceRoot, item.path),
      maximumBytes: 256 * 1024 * 1024,
    });
    fileRecords.push({
      path: item.path,
      status: read.status === 'scoped_file_read_verified'
        ? 'source_package_file_verified'
        : 'source_package_file_blocked',
      hash: read.hash,
      bytes: read.bytes,
      identityHash: read.afterIdentityHash,
      blockers: read.blockers || [],
    });
  }
  return buildSourcePackageValueManifest({ sourcePackageContract, fileRecords });
}
