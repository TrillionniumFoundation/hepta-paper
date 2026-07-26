import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  formalDomainQualificationFileIdentity,
  formalDomainQualificationPrivateDirectory,
  formalDomainQualificationPrivateRegularFile,
  fsyncFormalDomainQualificationDirectory,
  readPinnedFormalDomainQualificationPrivateFile,
} from './formal-domain-qualification-recovery-filesystem-repository.mjs';

const ENTRY_NAME = /^([0-9]{8})-([0-9a-f]{64})\.json$/;
const TEMPORARY_ENTRY_NAME = /^\.([0-9]{8})-[0-9a-f-]{36}\.tmp$/;

function invalid(code) {
  return new Error(code);
}

function readEntry(entryPath, { maximumBytes, invalidCode, driftCode }) {
  const read = readPinnedFormalDomainQualificationPrivateFile({
    candidate: entryPath,
    maximumBytes,
    invalidCode,
    driftCode,
  });
  let value;
  try {
    value = JSON.parse(read.source);
  } catch (error) {
    if (error instanceof SyntaxError) throw invalid(invalidCode);
    throw error;
  }
  if (read.source !== `${JSON.stringify(value)}\n`) {
    throw invalid(invalidCode);
  }
  return Object.freeze({ value, bytes: read.bytes });
}

function removePrivateTemporaryEntries(
  containerPath,
  names,
  entryNames,
  invalidCode,
) {
  for (const name of names) {
    const candidate = path.join(containerPath, name);
    const stat = fs.lstatSync(candidate, { bigint: true });
    if (!formalDomainQualificationPrivateRegularFile(stat, {
      allowedLinkCounts: [1, 2],
    })) {
      throw invalid(invalidCode);
    }
    if (Number(stat.nlink) === 2) {
      const sequence = name.match(TEMPORARY_ENTRY_NAME)[1];
      const published = entryNames.filter((entryName) => (
        entryName.startsWith(`${sequence}-`)
      )).map((entryName) => (
        fs.lstatSync(path.join(containerPath, entryName), { bigint: true })
      )).filter((entryStat) => (
        formalDomainQualificationPrivateRegularFile(entryStat, {
          allowedLinkCounts: [2],
        })
        && JSON.stringify(formalDomainQualificationFileIdentity(entryStat))
          === JSON.stringify(formalDomainQualificationFileIdentity(stat))
      ));
      if (published.length !== 1) throw invalid(invalidCode);
    }
    fs.unlinkSync(candidate);
  }
  if (names.length) fsyncFormalDomainQualificationDirectory(containerPath);
}

export function readFormalDomainQualificationRecoverySequence({
  containerPath,
  identity,
  maximumBytes,
  invalidCode,
  driftCode,
  verifyEntry,
  entryHash,
  assertSequence = null,
} = {}) {
  let stat;
  try { stat = fs.lstatSync(containerPath); }
  catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze([]);
    throw error;
  }
  if (!formalDomainQualificationPrivateDirectory(containerPath, stat)) {
    throw invalid(invalidCode);
  }
  const names = fs.readdirSync(containerPath);
  const entryNames = names.filter((name) => ENTRY_NAME.test(name)).sort();
  const temporaryNames = names.filter((name) => TEMPORARY_ENTRY_NAME.test(name));
  if (entryNames.length + temporaryNames.length !== names.length) {
    throw invalid(invalidCode);
  }
  removePrivateTemporaryEntries(
    containerPath,
    temporaryNames,
    entryNames,
    invalidCode,
  );
  let totalBytes = 0;
  let previousEntryHash = null;
  const entries = [];
  for (let index = 0; index < entryNames.length; index += 1) {
    const match = entryNames[index].match(ENTRY_NAME);
    if (Number(match[1]) !== index + 1) throw invalid(invalidCode);
    const read = readEntry(path.join(containerPath, entryNames[index]), {
      maximumBytes,
      invalidCode,
      driftCode,
    });
    totalBytes += read.bytes;
    if (totalBytes > maximumBytes) throw invalid(invalidCode);
    const entry = verifyEntry(read.value, {
      identity,
      previousEntryHash,
      sequence: index + 1,
    });
    const observedHash = entryHash(entry);
    if (observedHash.slice('sha256:'.length) !== match[2]) {
      throw invalid(invalidCode);
    }
    entries.push(entry);
    previousEntryHash = observedHash;
  }
  if (assertSequence) assertSequence(entries);
  return Object.freeze(entries);
}

export function appendFormalDomainQualificationRecoveryEntry({
  containerPath,
  entry,
  entryHash,
  invalidCode,
} = {}) {
  fs.mkdirSync(containerPath, { recursive: true, mode: 0o700 });
  if (!formalDomainQualificationPrivateDirectory(containerPath)) {
    throw invalid(invalidCode);
  }
  fsyncFormalDomainQualificationDirectory(path.dirname(containerPath));
  const sequence = String(entry.sequence).padStart(8, '0');
  const hash = entryHash(entry).slice('sha256:'.length);
  const target = path.join(containerPath, `${sequence}-${hash}.json`);
  const temporary = path.join(
    containerPath,
    `.${sequence}-${crypto.randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(entry)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  let published = false;
  try {
    fs.linkSync(temporary, target);
    published = true;
    fsyncFormalDomainQualificationDirectory(containerPath);
    fs.unlinkSync(temporary);
    fsyncFormalDomainQualificationDirectory(containerPath);
  } catch (error) {
    if (!published) {
      try {
        fs.unlinkSync(temporary);
        fsyncFormalDomainQualificationDirectory(containerPath);
      } catch { /* recovery removes a private incomplete staging file */ }
    }
    throw error;
  }
}
