import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  abortStagedScopedFileSync,
  commitStagedScopedFileSync,
  ensureScopedDirectorySync,
  stageScopedRegularFileCopySync,
} from '../runtime/scoped-file-materialization-repository.mjs';
import { workspaceAttemptIntegrationError as integrationError } from './workspace-attempt-errors.mjs';
import {
  DEFAULT_WORKSPACE_ATTEMPT_EXCLUDED_NAMES,
  effectiveWorkspaceAttemptExcludedNames,
  isWorkspaceAttemptEntryExcluded,
  workspaceAttemptRelativePath,
  workspaceAttemptRootIdentitySync,
} from './workspace-attempt-root-snapshot.mjs';

export function cloneWorkspaceTreeSync({ sourceRoot, destinationBaseRoot, destinationRelative, excludedNames }) {
  const source = workspaceAttemptRootIdentitySync(sourceRoot, 'source').realPath;
  const destinationBase = workspaceAttemptRootIdentitySync(destinationBaseRoot, 'runtime').realPath;
  const destination = ensureScopedDirectorySync({ scopeRoot: destinationBase, relative: destinationRelative });
  const excluded = effectiveWorkspaceAttemptExcludedNames(
    excludedNames || DEFAULT_WORKSPACE_ATTEMPT_EXCLUDED_NAMES,
  );
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = path.join(directory, entry.name);
      const relative = workspaceAttemptRelativePath(source, candidate);
      if (isWorkspaceAttemptEntryExcluded(entry, relative, excluded)) continue;
      const stat = fs.lstatSync(candidate);
      const destinationPath = `${destinationRelative}/${relative}`;
      if (stat.isDirectory()) {
        ensureScopedDirectorySync({ scopeRoot: destinationBase, relative: destinationPath });
        walk(candidate);
      } else if (stat.isFile()) {
        let staged = null;
        try {
          staged = stageScopedRegularFileCopySync({
            sourceRoot: source,
            destinationRoot: destinationBase,
            relative,
            destinationRelative: destinationPath,
            stageId: `clone-${crypto.createHash('sha256').update(`${destinationPath}\0${relative}`).digest('hex')}`,
            expectedHash: null,
          });
          commitStagedScopedFileSync(staged, { destinationRoot: destinationBase, expectedHash: null });
        } finally {
          abortStagedScopedFileSync(staged);
        }
      } else if (!stat.isSymbolicLink()) {
        throw integrationError('workspace_attempt_special_file_forbidden', { detail: relative });
      }
    }
  };
  walk(source);
  return fs.realpathSync.native(destination);
}
