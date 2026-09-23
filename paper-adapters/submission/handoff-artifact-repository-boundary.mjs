import path from 'node:path';

export function captureSubmissionHandoffArtifactRepositoryBoundary(
  artifactRepository,
) {
  return Object.freeze({
    scopeRoot: path.resolve(artifactRepository.scopeRoot),
    casRoot: path.resolve(artifactRepository.casRoot),
  });
}
