import path from 'node:path';

import {
  acquireRRuntimeSourceCas,
  verifyRRuntimeSourceCas,
} from '../../paper-adapters/automation/r-runtime-source-cas.mjs';
import { createRRuntimeSourceCasRepository } from '../../paper-adapters/automation/r-runtime-source-cas-repository.mjs';
import { createPositSnapshotRSourceArchiveTransport } from '../../paper-adapters/automation/r-runtime-source-archive-transport.mjs';

function context(repositoryRoot) {
  return path.join(path.resolve(repositoryRoot), 'runtime-images', 'r-scientific');
}

export function inspectRRuntimeSourceCas({ repositoryRoot = process.cwd() } = {}) {
  return verifyRRuntimeSourceCas({ contextPath: context(repositoryRoot) });
}

export function composeRRuntimeSourceCasAcquisition({
  repositoryRoot = process.cwd(),
  seedSourceDirectory = null,
  concurrency = 6,
  archiveTransport = createPositSnapshotRSourceArchiveTransport(),
} = {}) {
  const contextPath = context(repositoryRoot);
  return acquireRRuntimeSourceCas({
    contextPath,
    seedSourceDirectory,
    concurrency,
    archiveTransport,
    repository: createRRuntimeSourceCasRepository({ contextPath }),
  });
}
