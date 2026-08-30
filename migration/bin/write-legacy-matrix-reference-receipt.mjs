#!/usr/bin/env node

/**
 * Build the retained exact-head migration receipt from trusted orchestration
 * code.  The receipt contains identities and hashes, never credentials or raw
 * command output.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

function fail(message) { throw new Error(message); }

function required(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length || argv[index + 1].startsWith('-')) {
    fail(`${name}_required`);
  }
  return argv[index + 1];
}

function absolute(value, name) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) fail(`${name}_absolute_required`);
  return value;
}

function readJson(file, name, allowMissing = false) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    fail(`${name}_json_invalid:${error.message}`);
  }
}

function regularFile(value, name, allowMissing = false) {
  const file = absolute(value, name);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    fail(`${name}_not_found:${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${name}_regular_file_required`);
  return file;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, position);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
  } finally { fs.closeSync(descriptor); }
  return `sha256:${hash.digest('hex')}`;
}

function sha256Text(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

function optionalHash(file) {
  if (!file) return null;
  try { return sha256File(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function executableHash(command) {
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile()) continue;
      const target = fs.realpathSync.native(candidate);
      const targetStat = fs.statSync(target);
      if (!targetStat.isFile()) continue;
      return { path: candidate, target, sha256: optionalHash(target) };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) fail(`git_${args.join('_')}_failed:${String(result.stderr || '').trim()}`);
  return String(result.stdout || '').trim();
}

function firstLine(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.status !== 0) return `unavailable:${String(result.stderr || '').trim()}`;
  return String(result.stdout || '').trim().split('\n')[0];
}

function parseArgs(argv) {
  return Object.freeze({
    verification: absolute(required(argv, '--verification'), 'verification'),
    replay: absolute(required(argv, '--replay'), 'replay'),
    candidateRoot: absolute(required(argv, '--candidate-root'), 'candidate_root'),
    trustedRoot: absolute(required(argv, '--trusted-root'), 'trusted_root'),
    workflowFile: regularFile(required(argv, '--workflow-file'), 'workflow_file'),
    companionManifest: argv.includes('--companion-manifest')
      ? regularFile(required(argv, '--companion-manifest'), 'companion_manifest')
      : null,
    companionManifestSha256: argv.includes('--companion-manifest-sha256')
      ? required(argv, '--companion-manifest-sha256')
      : null,
    matrix: regularFile(required(argv, '--matrix'), 'matrix'),
    policy: regularFile(required(argv, '--policy'), 'policy'),
    candidateSha: required(argv, '--candidate-sha'),
    candidateTree: required(argv, '--candidate-tree'),
    workflowSha: required(argv, '--workflow-sha'),
    workflowTree: required(argv, '--workflow-tree'),
    output: absolute(required(argv, '--output'), 'output'),
    artifactName: required(argv, '--artifact-name'),
    artifactId: argv.includes('--artifact-id') ? required(argv, '--artifact-id') : '',
    artifactDigest: argv.includes('--artifact-digest') ? required(argv, '--artifact-digest') : '',
    artifactUrl: argv.includes('--artifact-url') ? required(argv, '--artifact-url') : '',
    dependencyReport: argv.includes('--dependency-report')
      ? regularFile(required(argv, '--dependency-report'), 'dependency_report', true)
      : null,
    releaseApiHash: argv.includes('--release-api-hash')
      ? String(required(argv, '--release-api-hash'))
      : null,
    cleanupReport: argv.includes('--cleanup-report')
      ? regularFile(required(argv, '--cleanup-report'), 'cleanup_report', true)
      : null,
  });
}

function identity(root, expectedSha, expectedTree, name) {
  if (!SHA40.test(expectedSha) || !SHA40.test(expectedTree)) fail(`${name}_identity_invalid`);
  const sha = git(root, 'rev-parse', 'HEAD');
  const tree = git(root, 'rev-parse', 'HEAD^{tree}');
  if (sha !== expectedSha || tree !== expectedTree) fail(`${name}_identity_mismatch:${sha}/${tree}`);
  return Object.freeze({ sha, tree });
}

function gitStatus(root) {
  const result = spawnSync('git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) fail(`git_status_failed:${String(result.stderr || '').trim()}`);
  const output = String(result.stdout || '');
  return Object.freeze({ clean: output.length === 0, sha256: sha256Text(output), entries: output ? output.trimEnd().split('\n').length : 0 });
}

function policyHashAndCheck(policyPath, candidateSha, candidateTree) {
  const policy = readJson(policyPath, 'policy');
  if (policy?.kind !== 'LegacyMatrixReferenceVerificationPolicy' || policy?.version !== 1) {
    fail('policy_kind_invalid');
  }
  const approvedSha = String(policy?.candidate?.sha || '');
  const approvedTree = String(policy?.candidate?.tree || '');
  if (!SHA40.test(approvedSha) || !SHA40.test(approvedTree)) fail('policy_candidate_identity_invalid');
  const approved = candidateSha === approvedSha && candidateTree === approvedTree;
  if (!approved) fail(`candidate_not_allowlisted:${candidateSha}/${candidateTree}`);
  const repository = process.env.GITHUB_REPOSITORY || null;
  const allowedRepositories = new Set([policy.repository, policy.workflow?.canonicalRepository]);
  if (repository && !allowedRepositories.has(repository)) {
    fail(`policy_repository_mismatch:${repository}`);
  }
  if (process.env.HEPTA_BASE_SHA && process.env.HEPTA_BASE_SHA !== policy.base?.sha) {
    fail('policy_base_sha_mismatch');
  }
  if (process.env.HEPTA_BASE_TREE && process.env.HEPTA_BASE_TREE !== policy.base?.tree) {
    fail('policy_base_tree_mismatch');
  }
  if (process.env.GITHUB_REF && policy.workflow?.requiredRef
    && process.env.GITHUB_REF !== policy.workflow.requiredRef) {
    fail('policy_workflow_ref_mismatch');
  }
  return Object.freeze({
    policy,
    policySha256: sha256File(policyPath),
    approvedSha,
    approvedTree,
    approved,
  });
}

function actionPins(workflowText) {
  return Object.freeze([...new Set(
    [...String(workflowText).matchAll(/uses:\s*([^\s#]+@[^\s#]+)/gu)].map((match) => match[1]),
  )].sort());
}

function readDependencyReport(file) {
  if (!file) return null;
  return readJson(file, 'dependency_report', true);
}

function replayIsComplete(replay) {
  if (replay?.status !== 'legacy_matrix_reference_replay_verified'
    || replay?.overallExitCode !== 0
    || replay?.candidateNetwork !== 'none'
    || !Array.isArray(replay?.candidateSecrets)
    || replay.candidateSecrets.length !== 0
    || replay?.archivePresentDuringCandidateExecution !== false
    || replay?.sourceMutation !== false
    || replay?.runtimeMutation !== false
    || replay?.runtimeBefore !== replay?.runtimeAfter
    || !SHA256.test(replay?.preparedRootTreeSha256 || '')
    || !Array.isArray(replay?.commands)
    || replay.commands.length !== 2) return false;
  const labels = ['migration:matrix-integrity', 'test:migration-differential'];
  return replay.commands.every((command, index) => (
    command?.label === labels[index]
    && Array.isArray(command.argv)
    && command.argv[0] === 'npm'
    && command.status === 'passed'
    && command.exitCode === 0
    && command.network === 'none'
    && command.archivePresent === false
    && Array.isArray(command.secrets)
    && command.secrets.length === 0
    && SHA256.test(command.stdout?.sha256 || '')
    && SHA256.test(command.stderr?.sha256 || '')
    && SHA256.test(command.resultHash || '')
  ));
}

function verificationIsComplete(verification, policy) {
  return verification?.status === 'legacy_matrix_reference_publication_verified'
    && verification.archiveSha256 === policy?.archive?.archiveSha256
    && Number(verification.archiveBytes) === Number(policy?.archive?.archiveBytes)
    && Number(verification.sourceFileCount) === Number(policy?.archive?.sourceFileCount)
    && Number(verification.sourceHashesMatched) === Number(policy?.archive?.sourceFileCount)
    && Number(verification.sourceHashesMissing) === 0
    && Number(verification.sourceHashesMismatched) === 0
    && SHA256.test(verification.matrixSha256 || '');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function hashPayload(value) {
  return `sha256:${crypto.createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')}`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const verification = readJson(options.verification, 'verification');
  const replay = readJson(options.replay, 'replay');
  const candidate = identity(options.candidateRoot, options.candidateSha, options.candidateTree, 'candidate');
  const workflow = identity(options.trustedRoot, options.workflowSha, options.workflowTree, 'workflow');
  const policyBinding = policyHashAndCheck(options.policy, candidate.sha, candidate.tree);
  const candidateStatus = gitStatus(options.candidateRoot);
  const workflowStatus = gitStatus(options.trustedRoot);
  const companionManifestSha256 = options.companionManifest
    ? sha256File(options.companionManifest)
    : options.companionManifestSha256;
  const matrixSha256 = sha256File(options.matrix);
  if (!SHA256.test(matrixSha256) || !SHA256.test(companionManifestSha256 || '')) {
    fail('input_hash_unreadable');
  }
  const workflowText = fs.readFileSync(options.workflowFile, 'utf8');
  const dependencyReport = readDependencyReport(options.dependencyReport);
  const cleanupReport = readJson(options.cleanupReport, 'cleanup_report', true);
  const packageLock = optionalHash(path.join(options.candidateRoot, 'package-lock.json'));
  const npmLock = optionalHash(path.join(options.candidateRoot, 'npm-shrinkwrap.json'));
  const verificationStatus = String(verification?.status || 'missing');
  const replayStatus = String(replay?.status || 'missing');
  const verificationComplete = verificationIsComplete(verification, policyBinding.policy);
  const replayComplete = replayIsComplete(replay);
  const hostedIdentityComplete = Boolean(
    process.env.GITHUB_REPOSITORY
      && process.env.GITHUB_RUN_ID
      && process.env.GITHUB_RUN_ATTEMPT
      && process.env.GITHUB_WORKFLOW_REF
      && process.env.GITHUB_EVENT_NAME
      && process.env.GITHUB_ACTOR,
  );
  const complete = policyBinding.approved
    && candidateStatus.clean
    && workflowStatus.clean
    && verificationComplete
    && replayStatus === 'legacy_matrix_reference_replay_verified'
    && replayComplete
    && Number(dependencyReport?.exitCode) === 0
    && cleanupReport?.archiveRemoved === true
    && cleanupReport?.manifestRemoved === true
    && cleanupReport?.preparedRootDestroyed === true
    && policyBinding.policy?.workflow?.trustMode === 'private-companion-admin-controlled'
    && hostedIdentityComplete
    && Boolean(options.artifactDigest);
  const payload = {
    schemaVersion: 2,
    kind: 'LegacyMatrixReferenceExactHeadReceipt',
    status: complete
      ? 'legacy_matrix_reference_exact_head_verified'
      : 'legacy_matrix_reference_exact_head_blocked',
    repository: policyBinding.policy?.repository || 'TrillionniumFoundation/hepta-paper',
    subject: {
      repository: policyBinding.policy?.repository || 'TrillionniumFoundation/hepta-paper',
      pullRequest: policyBinding.policy?.candidate?.pullRequest || null,
      baseSha: process.env.HEPTA_BASE_SHA || null,
      baseTree: process.env.HEPTA_BASE_TREE || null,
      candidateSha: candidate.sha,
      candidateTree: candidate.tree,
      candidateRef: candidate.sha,
      allowlistPolicySha256: policyBinding.policySha256,
      allowlistedCandidateSha: policyBinding.approvedSha,
      allowlistedCandidateTree: policyBinding.approvedTree,
      candidateAllowlisted: policyBinding.approved,
      policyMatch: policyBinding.approved,
    },
    workflow: {
      name: process.env.GITHUB_WORKFLOW || 'legacy-matrix-reference-verification',
      ref: process.env.GITHUB_REF || null,
      workflowRef: process.env.GITHUB_WORKFLOW_REF || null,
      sha: workflow.sha,
      tree: workflow.tree,
      fileSha256: sha256File(options.workflowFile),
      actionPins: actionPins(workflowText),
      repository: process.env.GITHUB_REPOSITORY || 'TrillionniumFoundation/hepta-paper',
      trustMode: policyBinding.policy?.workflow?.trustMode || 'unspecified',
    },
    run: {
      id: process.env.GITHUB_RUN_ID || null,
      attempt: process.env.GITHUB_RUN_ATTEMPT || null,
      jobId: process.env.GITHUB_JOB || null,
      event: process.env.GITHUB_EVENT_NAME || null,
      actor: process.env.GITHUB_ACTOR || null,
      triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR || null,
    },
    reference: {
      sha256: verification?.archiveSha256 || verification?.releaseAssetDigest || null,
      bytes: verification?.archiveBytes || null,
      inventory: verification?.archiveInventory || null,
      sourceFileCount: verification?.sourceFileCount || null,
      sourceHashesMatched: verification?.sourceHashesMatched || 0,
      sourceHashesMissing: verification?.sourceHashesMissing || null,
      sourceHashesMismatched: verification?.sourceHashesMismatched || null,
      matrixSha256,
      materialization: 'allowlisted_regular_only_readonly',
      archivePresentDuringCandidateExecution: replay?.archivePresentDuringCandidateExecution ?? null,
      companionManifestSha256,
      companionRepository: verification?.companionRepository || policyBinding.policy?.archive?.companionRepository || null,
      companionCommit: verification?.companionCommit || policyBinding.policy?.archive?.companionCommit || null,
      companionTag: verification?.companionTag || policyBinding.policy?.archive?.companionTag || null,
      releaseTag: verification?.releaseTag || policyBinding.policy?.archive?.releaseTag || null,
      releaseId: verification?.releaseId || policyBinding.policy?.archive?.releaseId || null,
      releaseAssetId: verification?.releaseAssetId || policyBinding.policy?.archive?.releaseAssetId || null,
      releaseAssetDigest: verification?.releaseAssetDigest || policyBinding.policy?.archive?.archiveSha256 || null,
      releaseAssetBytes: verification?.releaseAssetBytes || policyBinding.policy?.archive?.archiveBytes || null,
      releaseApiResponseSha256: options.releaseApiHash || null,
    },
    matrix: {
      sha256: matrixSha256,
      sourceFileCount: verification?.sourceFileCount || null,
    },
    isolation: {
      network: replay?.candidateNetwork || 'unknown',
      candidateSecrets: replay?.candidateSecrets || [],
      candidateMounts: ['candidate:ro', 'reference:ro', 'runtime:ro'],
      sourceMutation: replay?.sourceMutation ?? null,
      archivePresentDuringCandidateExecution: replay?.archivePresentDuringCandidateExecution ?? null,
      preparedReferenceRoot: replay?.preparedRoot || null,
      preparedRootTreeSha256: replay?.preparedRootTreeSha256 || null,
      privateLogsRetained: false,
      cleanup: cleanupReport,
    },
    dependencies: {
      packageLockSha256: packageLock,
      npmShrinkwrapSha256: npmLock,
      install: dependencyReport,
    },
    verification: {
      status: verificationStatus,
      resultHash: hashPayload(verification),
    },
    replay: {
      status: replayStatus,
      resultHash: hashPayload(replay),
      commands: replay?.commands || [],
      overallExitCode: replay?.overallExitCode ?? null,
    },
    candidateRepositoryState: candidateStatus,
    trustedWorkflowRepositoryState: workflowStatus,
    tools: {
      node: process.version,
      npm: firstLine('npm'),
      git: firstLine('git'),
      tar: firstLine('tar'),
      bwrap: firstLine('bwrap'),
      executables: Object.fromEntries(['node', 'npm', 'git', 'tar', 'bwrap', 'gh']
        .map((command) => [command, executableHash(command)])),
      platform: process.platform,
      arch: process.arch,
      runnerImage: process.env.RUNNER_OS ? `${process.env.RUNNER_OS}/${process.env.ImageOS || 'unspecified'}` : null,
    },
    evidenceArtifact: {
      name: options.artifactName,
      id: options.artifactId || null,
      digest: options.artifactDigest || null,
      url: options.artifactUrl || null,
    },
    authority: 'non_authorizing_archive_integrity_and_migration_replay_evidence_only',
    externalAuthorityGranted: false,
  };
  const receipt = { ...payload, receiptSha256: hashPayload(payload) };
  fs.writeFileSync(options.output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o444 });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

try { main(); }
catch (error) {
  process.stderr.write(`legacy migration receipt blocked: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
