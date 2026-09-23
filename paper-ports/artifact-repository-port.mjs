import path from 'node:path';

export function assertArtifactRepository(repository) {
  for (const method of ['writeBytes', 'writeText', 'writeJson', 'readManifest', 'garbageCollect']) {
    if (typeof repository?.[method] !== 'function') {
      throw new Error(`ArtifactRepository.${method} is required`);
    }
  }
  return repository;
}

export function assertArtifactTarget({ scopeRoot, target }) {
  if (!scopeRoot || !target) throw new Error('Artifact write scopeRoot and target are required');
  const root = path.resolve(scopeRoot);
  const candidate = path.resolve(target);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new Error(`Artifact target escapes declared scope: ${candidate}`);
  }
  return { root, candidate };
}
