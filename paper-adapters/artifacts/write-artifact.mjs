import path from 'node:path';
import { createFilesystemArtifactRepository } from './filesystem-artifact-repository.mjs';

export function writeJsonFile(candidate, value, {
  scopeRoot = path.dirname(candidate),
  role = 'json_artifact',
  atomic = true,
} = {}) {
  return createFilesystemArtifactRepository({ scopeRoot }).writeJson(candidate, value, { role, atomic });
}

export function writeTextFile(candidate, value, {
  scopeRoot = path.dirname(candidate),
  role = 'text_artifact',
  atomic = true,
} = {}) {
  return createFilesystemArtifactRepository({ scopeRoot }).writeText(candidate, value, { role, atomic });
}
