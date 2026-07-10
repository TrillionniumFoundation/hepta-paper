import path from 'node:path';
import { createFilesystemArtifactRepository } from './filesystem-artifact-repository.mjs';
import { currentArtifactWriteContext } from './artifact-write-context.mjs';

function repository(scopeRoot) {
  const context = currentArtifactWriteContext();
  return context?.artifactRepositoryFactory
    ? context.artifactRepositoryFactory(scopeRoot)
    : createFilesystemArtifactRepository({ scopeRoot });
}

export function writeJsonFile(candidate, value, {
  scopeRoot = path.dirname(candidate),
  role = 'json_artifact',
  atomic = true,
} = {}) {
  return repository(scopeRoot).writeJson(candidate, value, { role, atomic });
}

export function writeTextFile(candidate, value, {
  scopeRoot = path.dirname(candidate),
  role = 'text_artifact',
  atomic = true,
} = {}) {
  return repository(scopeRoot).writeText(candidate, value, { role, atomic });
}
