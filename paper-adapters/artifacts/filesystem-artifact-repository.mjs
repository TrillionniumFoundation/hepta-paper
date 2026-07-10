import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { assertArtifactRepository, assertArtifactTarget } from '../../paper-ports/artifact-repository-port.mjs';

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function createFilesystemArtifactRepository({ scopeRoot, repositoryId = 'filesystem-artifacts' } = {}) {
  const declaredRoot = path.resolve(scopeRoot || '.');
  const write = async ({ target, payload, role = 'artifact', contentType = 'text/plain', atomic = true }) => {
    const { candidate } = assertArtifactTarget({ scopeRoot: declaredRoot, target });
    const bytes = Buffer.from(String(payload), 'utf8');
    await fsp.mkdir(path.dirname(candidate), { recursive: true });
    if (atomic) {
      const temporary = `${candidate}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      try {
        await fsp.writeFile(temporary, bytes);
        await fsp.rename(temporary, candidate);
      } finally {
        await fsp.rm(temporary, { force: true });
      }
    } else {
      await fsp.writeFile(candidate, bytes);
    }
    return Object.freeze({
      version: 1,
      kind: 'ArtifactWriteReceipt',
      repositoryId,
      role,
      contentType,
      path: path.relative(declaredRoot, candidate).replace(/\\/g, '/'),
      bytes: bytes.length,
      hash: sha256(bytes),
      atomic: Boolean(atomic),
      scopeRoot: declaredRoot,
      externalActionPerformed: false,
    });
  };
  return assertArtifactRepository({
    version: 1,
    kind: 'FilesystemArtifactRepository',
    repositoryId,
    scopeRoot: declaredRoot,
    writeText(target, value, options = {}) {
      return write({ target, payload: value, contentType: 'text/plain', ...options });
    },
    writeJson(target, value, options = {}) {
      return write({
        target,
        payload: JSON.stringify(value, null, 2) + '\n',
        contentType: 'application/json',
        ...options,
      });
    },
  });
}
