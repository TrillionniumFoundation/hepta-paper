#!/usr/bin/env node

/**
 * Validate the checked-in administrator policy before any private material is
 * downloaded.  This script deliberately performs no package installation and
 * does not import candidate application code.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

function fail(message) { throw new Error(message); }

function arg(argv, name, optional = false) {
  const index = argv.indexOf(name);
  if (index < 0) {
    if (optional) return null;
    fail(`${name}_required`);
  }
  if (index + 1 >= argv.length || argv[index + 1].startsWith('-')) fail(`${name}_value_required`);
  return argv[index + 1];
}

function absolute(value, name) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) fail(`${name}_absolute_required`);
  return value;
}

function file(value, name) {
  const resolved = absolute(value, name);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${name}_regular_file_required`);
  return resolved;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function main() {
  const argv = process.argv.slice(2);
  const policyPath = file(arg(argv, '--policy'), 'policy');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  if (policy?.version !== 1 || policy?.kind !== 'LegacyMatrixReferenceVerificationPolicy') fail('policy_kind_invalid');
  if (policy.repository !== 'TrillionniumFoundation/hepta-paper') fail('policy_repository_invalid');
  const candidateSha = arg(argv, '--candidate-sha');
  const candidateTree = arg(argv, '--candidate-tree');
  if (!SHA40.test(candidateSha) || !SHA40.test(candidateTree)) fail('candidate_identity_invalid');
  if (candidateSha !== policy.candidate?.sha || candidateTree !== policy.candidate?.tree) {
    fail(`candidate_not_allowlisted:${candidateSha}/${candidateTree}`);
  }
  if (!SHA40.test(policy.base?.sha || '') || !SHA40.test(policy.base?.tree || '')) fail('policy_base_identity_invalid');
  if (policy.archive?.companionRepository !== 'TrillionniumFoundation/hepta-paper-legacy-reference'
    || policy.archive?.releaseId !== 379268751
    || policy.archive?.releaseAssetId !== 536563599
    || policy.archive?.releaseTag !== 'legacy-reference-v0.6.0-e431c4c7') {
    fail('policy_companion_binding_invalid');
  }
  if (policy.workflow?.requiredRef !== 'refs/heads/main'
    || policy.workflow?.trustMode !== 'private-companion-admin-controlled') {
    fail('policy_workflow_trust_invalid');
  }
  for (const pin of Object.values(policy.actions || {})) {
    if (!SHA40.test(String(pin))) fail('policy_action_pin_invalid');
  }
  if (!SHA256.test(policy.archive?.archiveSha256 || '') || !SHA256.test(policy.archive?.matrixSha256 || '')) {
    fail('policy_archive_identity_invalid');
  }
  if (policy.archive?.sourceFileCount !== 263) fail('policy_source_count_invalid');
  const report = {
    version: 1,
    kind: 'LegacyMatrixReferencePolicyVerification',
    status: 'legacy_matrix_reference_policy_verified',
    policySha256: sha256(fs.readFileSync(policyPath)),
    repository: policy.repository,
    candidate: { sha: candidateSha, tree: candidateTree, approved: true },
    base: policy.base,
    archive: policy.archive,
    workflow: policy.workflow,
    actionPins: policy.actions,
    authority: policy.authority,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try { main(); }
catch (error) {
  process.stderr.write(`legacy migration policy blocked: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
