import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertEmpiricalCachePort } from '../../paper-ports/empirical-cache-port.mjs';

function sha256File(candidate) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')}`;
}

export function createFilesystemEmpiricalCacheRepository({ root } = {}) {
  if (!root) throw new Error('empirical cache root is required');
  const cacheRoot = path.resolve(root);
  return assertEmpiricalCachePort({
    version: 1,
    kind: 'FilesystemEmpiricalCacheRepository',
    get(cacheKey, { outputDirectory } = {}) {
      const cacheDirectory = path.join(cacheRoot, String(cacheKey).replace(/^sha256:/, ''));
      const manifestPath = path.join(cacheDirectory, 'manifest.json');
      if (!outputDirectory || !fs.existsSync(manifestPath)) return null;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
        if (!artifacts.length || artifacts.some((artifact) => {
          const candidate = path.join(cacheDirectory, 'artifacts', artifact.path);
          return !fs.existsSync(candidate) || sha256File(candidate) !== artifact.sha256;
        })) return null;
        fs.mkdirSync(outputDirectory, { recursive: true });
        for (const artifact of artifacts) {
          const source = path.join(cacheDirectory, 'artifacts', artifact.path);
          const destination = path.join(outputDirectory, artifact.path);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.copyFileSync(source, destination);
        }
        return Object.freeze({ ...manifest, artifacts });
      } catch { return null; }
    },
    put(cacheKey, { outputDirectory, artifacts = [], runnerReceiptHash = null } = {}) {
      if (!outputDirectory || !artifacts.length) return Object.freeze({ stored: false, reason: 'cache_artifacts_required' });
      const cacheDirectory = path.join(cacheRoot, String(cacheKey).replace(/^sha256:/, ''));
      fs.mkdirSync(path.dirname(cacheDirectory), { recursive: true });
      const temporary = `${cacheDirectory}.tmp-${process.pid}-${crypto.randomUUID()}`;
      fs.mkdirSync(path.join(temporary, 'artifacts'), { recursive: true });
      for (const artifact of artifacts) {
        const source = path.join(outputDirectory, artifact.path);
        const destination = path.join(temporary, 'artifacts', artifact.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
      }
      fs.writeFileSync(path.join(temporary, 'manifest.json'), `${JSON.stringify({ version: 1, artifacts, runnerReceiptHash }, null, 2)}\n`);
      if (fs.existsSync(cacheDirectory)) fs.rmSync(cacheDirectory, { recursive: true, force: true });
      try {
        fs.renameSync(temporary, cacheDirectory);
        return Object.freeze({ stored: true, cacheKey });
      } catch {
        fs.rmSync(temporary, { recursive: true, force: true });
        return Object.freeze({ stored: false, reason: 'cache_publish_race' });
      }
    },
  });
}
