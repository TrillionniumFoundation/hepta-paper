import path from 'node:path';
import { currentArtifactWriteContext } from './artifact-write-context.mjs';

function repository(scopeRoot) {
  const context = currentArtifactWriteContext();
  if (!context?.artifactRepositoryFactory) {
    throw new Error('Artifact write requires an ExecutionContext-backed persistent ledger');
  }
  return context.artifactRepositoryFactory(scopeRoot);
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
