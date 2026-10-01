#!/usr/bin/env node
// One source-subject recipe shared by all qualification lanes. This writes Git
// objects only: never refs, index, working files, evidence or deployment authority.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OID = /^[0-9a-f]{40}$/;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function prospectiveGit({ root, base, target }) {
  if (!OID.test(base || '') || !OID.test(target || '')) {
    throw new Error('prospective_subject_requires_full_commit_ids');
  }
  // Do not let inherited alternate Git directories, indices, replace refs or
  // author/signing configuration silently select another source subject.
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C',
  });
  const cwd = path.resolve(root);
  const git = (args, input, extra = {}) => {
    const result = spawnSync('git', [
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
    ], { cwd, env: { ...environment, ...extra }, encoding: 'utf8', input,
      timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0 || result.signal) {
      throw new Error(`prospective_subject_git_failed:${args[0]}`);
    }
    return result.stdout.trim();
  };
  for (const oid of [base, target]) {
    if (git(['cat-file', '-t', oid]) !== 'commit') {
      throw new Error('prospective_subject_not_a_commit');
    }
  }
  return git;
}

function canonicalMerge(git, base, target) {
  const tree = git(['merge-tree', '--write-tree', base, target]);
  if (!OID.test(tree)) throw new Error('prospective_subject_merge_conflict');
  const timestamp = git(['show', '-s', '--format=%ct', target]);
  if (!/^\d+$/.test(timestamp)) throw new Error('prospective_subject_timestamp_invalid');
  const owner = 'hepta-source-evidence <source-evidence@invalid.example>';
  const raw = `tree ${tree}\nparent ${base}\nparent ${target}\n`
    + `author ${owner} ${timestamp} +0000\ncommitter ${owner} ${timestamp} +0000\n\n`
    + `Hepta canonical prospective merge v1\n\nbase ${base}\ntarget ${target}\n`;
  return { tree, timestamp, commit: git(['hash-object', '-t', 'commit', '--stdin'], raw) };
}

export function prepareProspectiveMerge({ root = '.', base, target }) {
  const git = prospectiveGit({ root, base, target });
  if (git(['rev-parse', '--verify', 'HEAD']) !== target) {
    throw new Error('prospective_subject_checkout_mismatch');
  }
  // Push events without a distinct integration base have one subject. Do not
  // fabricate a second parent or present identical source as an independent merge.
  if (base === target) return { commit: target, tree: git(['rev-parse', `${target}^{tree}`]), base, target };
  const { tree, timestamp, commit: expected } = canonicalMerge(git, base, target);
  const commit = git(['commit-tree', tree, '-p', base, '-p', target],
    `Hepta canonical prospective merge v1\n\nbase ${base}\ntarget ${target}\n`, {
      GIT_AUTHOR_NAME: 'hepta-source-evidence',
      GIT_AUTHOR_EMAIL: 'source-evidence@invalid.example',
      GIT_AUTHOR_DATE: `@${timestamp} +0000`,
      GIT_COMMITTER_NAME: 'hepta-source-evidence',
      GIT_COMMITTER_EMAIL: 'source-evidence@invalid.example',
      GIT_COMMITTER_DATE: `@${timestamp} +0000`,
    });
  if (commit !== expected || git(['show', '-s', '--format=%P', commit]) !== `${base} ${target}`
      || git(['rev-parse', `${commit}^{tree}`]) !== tree
      || git(['rev-parse', '--verify', 'HEAD']) !== target) {
    throw new Error('prospective_subject_identity_changed');
  }
  return { commit, tree, base, target };
}

// Observe an already checked-out merge using exactly the creation recipe above.
// Matching parents or trees alone cannot qualify a substituted merge commit.
export function verifyProspectiveMerge({ root = '.', base, target, commit }) {
  if (!OID.test(commit || '') || base === target) {
    throw new Error('prospective_subject_merge_identity_invalid');
  }
  const git = prospectiveGit({ root, base, target });
  if (git(['cat-file', '-t', commit]) !== 'commit'
      || git(['rev-parse', '--verify', 'HEAD']) !== commit) {
    throw new Error('prospective_subject_checkout_mismatch');
  }
  const expected = canonicalMerge(git, base, target);
  if (commit !== expected.commit
      || git(['show', '-s', '--format=%P', commit]) !== `${base} ${target}`
      || git(['rev-parse', `${commit}^{tree}`]) !== expected.tree) {
    throw new Error('prospective_subject_identity_changed');
  }
  return { commit, tree: expected.tree, base, target };
}

function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2);
    if (!['--root', '--base', '--target'].includes(args[i]) || !args[i + 1]
        || Object.hasOwn(options, key)) throw new Error('prospective_subject_arguments_invalid');
    options[key] = args[i + 1];
  }
  process.stdout.write(`${prepareProspectiveMerge(options).commit}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try { main(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
