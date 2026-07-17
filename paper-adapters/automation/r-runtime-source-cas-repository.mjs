import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';

const ARCHIVE = /^[A-Za-z][A-Za-z0-9.]{0,127}_[A-Za-z0-9][A-Za-z0-9.+-]{0,127}\.tar\.gz$/;

function assertArchiveFile(value) {
  const file = String(value || '');
  if (!ARCHIVE.test(file)) throw new Error('r_runtime_source_cas_archive_file_invalid');
  return file;
}

function writeExclusive(candidate, bytes) {
  fs.writeFileSync(candidate, bytes, { mode: 0o444, flag: 'wx' });
  fs.chmodSync(candidate, 0o444);
}

export function createRRuntimeSourceCasRepository({ contextPath } = {}) {
  const context = fs.realpathSync(path.resolve(contextPath));
  const destination = path.join(context, 'source-cas');
  const active = new Set();
  const published = new Set();
  const validate = (staging, { allowPublished = false } = {}) => {
    if (!staging || typeof staging !== 'object'
      || (!active.has(staging) && !(allowPublished && published.has(staging)))) {
      throw new Error('r_runtime_source_cas_staging_token_invalid');
    }
    return staging.path;
  };
  return Object.freeze({
    version: 1,
    kind: 'RRuntimeSourceCasRepository',
    destinationExists() { return fs.existsSync(destination); },
    begin() {
      if (fs.existsSync(destination)) throw new Error('r_runtime_source_cas_existing_invalid');
      const stagingPath = path.join(context, `.source-cas.staging-${process.pid}-${crypto.randomUUID()}`);
      fs.mkdirSync(path.join(stagingPath, 'src', 'contrib'), { recursive: true, mode: 0o755 });
      const token = Object.freeze({ path: stagingPath });
      active.add(token);
      return token;
    },
    archivePath(staging, file) {
      return path.join(validate(staging), 'src', 'contrib', assertArchiveFile(file));
    },
    copySeedArchive(staging, file, source) {
      const seed = fs.realpathSync(path.resolve(source));
      if (!fs.lstatSync(seed).isFile()) throw new Error('r_runtime_source_cas_seed_file_invalid');
      fs.copyFileSync(seed, this.archivePath(staging, file), fs.constants.COPYFILE_EXCL);
      fs.chmodSync(this.archivePath(staging, file), 0o444);
    },
    writeArchive(staging, file, bytes) {
      if (!Buffer.isBuffer(bytes) || bytes.length < 100) {
        throw new Error('r_runtime_source_cas_archive_bytes_invalid');
      }
      writeExclusive(this.archivePath(staging, file), bytes);
    },
    removeArchive(staging, file) {
      fs.rmSync(this.archivePath(staging, file), { force: true });
    },
    writeIndexes(staging, packages) {
      const root = validate(staging);
      const sums = packages.map((entry) => (
        `${entry.sha256.slice('sha256:'.length)}  src/contrib/${entry.file}`
      )).join('\n');
      writeExclusive(path.join(root, 'SHA256SUMS'), Buffer.from(`${sums}\n`));
      const header = 'Package\tVersion\tFile\tURL\tSHA256';
      const rows = packages.map((entry) => [
        entry.package, entry.version, entry.file, entry.url, entry.sha256,
      ].join('\t'));
      writeExclusive(path.join(root, 'PACKAGES.tsv'), Buffer.from(`${[header, ...rows].join('\n')}\n`));
    },
    writeManifest(staging, manifest) {
      writeDurableJsonSync(path.join(validate(staging), 'manifest.json'), manifest, { mode: 0o444 });
    },
    publish(staging) {
      const stagingPath = validate(staging);
      fs.renameSync(stagingPath, destination);
      active.delete(staging);
      published.add(staging);
    },
    discard(staging) {
      if (!active.has(staging)) return;
      fs.rmSync(validate(staging), { recursive: true, force: true });
      active.delete(staging);
    },
    rollbackPublished(staging) {
      validate(staging, { allowPublished: true });
      fs.rmSync(destination, { recursive: true, force: true });
      published.delete(staging);
    },
    settlePublished(staging) {
      validate(staging, { allowPublished: true });
      published.delete(staging);
    },
  });
}
