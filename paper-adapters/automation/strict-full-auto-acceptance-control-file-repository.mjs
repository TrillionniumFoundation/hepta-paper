import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  canonicalAcceptanceJson,
  strictFullAutoAcceptanceHash,
} from '../../paper-domain/automation/strict-full-auto-acceptance-contract.mjs';

// Durable control-file mutations are isolated behind this repository boundary.
export function fsyncDirectory(candidate) {
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function secureControlRoot(candidate) {
  const selected = path.resolve(candidate);
  const stat = fs.lstatSync(selected);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(selected) !== selected
    || stat.uid !== currentUid || (stat.mode & 0o077) !== 0) {
    throw new Error('strict_full_auto_acceptance_control_root_invalid');
  }
  return selected;
}

export function assertPlanControlRoot(plan) {
  const selected = secureControlRoot(plan.controlRoot);
  const stat = fs.lstatSync(selected, { bigint: true });
  const binding = plan.rootBindings.find((item) => item.rootId === 'control-root');
  if (!binding || binding.anchorKind !== 'target' || binding.anchorPath !== selected
    || binding.anchorRealPath !== selected
    || binding.anchorDevice !== String(stat.dev)
    || binding.anchorInode !== String(stat.ino)
    || binding.anchorMode !== (Number(stat.mode) & 0o7777)
    || binding.anchorUid !== String(stat.uid)
    || binding.anchorGid !== String(stat.gid)) {
    throw new Error('strict_full_auto_acceptance_control_root_identity_changed');
  }
  return selected;
}

export function secureDirectory(candidate) {
  const selected = path.resolve(candidate);
  const stat = fs.lstatSync(selected);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(selected) !== selected
    || (stat.mode & 0o022) !== 0) {
    throw new Error('strict_full_auto_acceptance_control_directory_invalid');
  }
  return selected;
}

export function ensureScopedDirectory(parent, name) {
  const selectedParent = secureDirectory(parent);
  const selected = path.join(selectedParent, name);
  if (!fs.existsSync(selected)) fs.mkdirSync(selected, { mode: 0o700 });
  return secureDirectory(selected);
}

function secureRegularFile(candidate, label) {
  const selected = path.resolve(candidate);
  let stat = fs.lstatSync(selected);
  if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink > 1) {
    const parent = secureDirectory(path.dirname(selected));
    for (const entry of fs.readdirSync(parent)) {
      const possibleTemporary = path.join(parent, entry);
      if (possibleTemporary === selected || !entry.startsWith('.') || !entry.endsWith('.tmp')) {
        continue;
      }
      let candidateStat;
      try { candidateStat = fs.lstatSync(possibleTemporary); } catch { continue; }
      if (candidateStat.isFile() && !candidateStat.isSymbolicLink()
        && candidateStat.dev === stat.dev && candidateStat.ino === stat.ino) {
        fs.unlinkSync(possibleTemporary);
      }
    }
    fsyncDirectory(parent);
    stat = fs.lstatSync(selected);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || fs.realpathSync(selected) !== selected || (stat.mode & 0o022) !== 0) {
    throw new Error(`strict_full_auto_acceptance_${label}_file_invalid`);
  }
  return selected;
}

function jsonBytes(value) {
  return `${canonicalAcceptanceJson(value)}\n`;
}

export function atomicJsonWrite(destination, value) {
  const parent = secureDirectory(path.dirname(destination));
  if (fs.existsSync(destination)) secureRegularFile(destination, 'atomic_target');
  const temporary = path.join(
    parent,
    `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, jsonBytes(value), 'utf8');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, destination);
  secureRegularFile(destination, 'atomic_target');
  fsyncDirectory(parent);
}

export function exclusiveJsonCreate(destination, value) {
  const parent = secureDirectory(path.dirname(destination));
  const descriptor = fs.openSync(
    destination,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, jsonBytes(value), 'utf8');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fsyncDirectory(parent);
}

export function exclusiveJsonPublish(destination, value) {
  const parent = secureDirectory(path.dirname(destination));
  const temporary = path.join(
    parent,
    `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    exclusiveJsonCreate(temporary, value);
    fs.linkSync(temporary, destination);
    fsyncDirectory(parent);
  } finally {
    try {
      fs.unlinkSync(temporary);
      fsyncDirectory(parent);
    } catch { /* published or absent */ }
  }
}

export function parseJsonFile(candidate, label) {
  try { return JSON.parse(fs.readFileSync(secureRegularFile(candidate, label), 'utf8')); }
  catch (error) {
    throw new Error(`strict_full_auto_acceptance_${label}_invalid`, { cause: error });
  }
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function hashDocument(body, hashField) {
  return Object.freeze({ ...body, [hashField]: strictFullAutoAcceptanceHash(body) });
}

export function verifyHashedDocument(value, {
  keys,
  hashField,
  label,
} = {}) {
  if (!exactKeys(value, [...keys, hashField])) {
    throw new Error(`strict_full_auto_acceptance_${label}_invalid`);
  }
  const { [hashField]: claimedHash, ...body } = value;
  if (claimedHash !== strictFullAutoAcceptanceHash(body)) {
    throw new Error(`strict_full_auto_acceptance_${label}_invalid`);
  }
  return value;
}
