import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES } from '../../paper-domain/automation/dataset-access-supervisor-policy.mjs';
import { SYSTEM_PINNED_FORMAL_SANDBOX_RUNTIME_CONFIGURATION } from '../../paper-adapters/research-verify/pinned-formal-sandbox-runtime-configuration.mjs';
import { buildCycloneDxLockfileSbomFromFiles } from './cyclonedx-lockfile-sbom.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const PINNED_REFERENCE = /@sha256:[a-f0-9]{64}$/u;
const REQUIRED_SBOM_PATH = 'paper-core/config/source-supply-chain-sbom.cdx.json';
const REQUIRED_DOCKERFILES = Object.freeze([
  'runtime-images/python-gpu/Dockerfile',
  'runtime-images/python-scientific/Dockerfile',
  'runtime-images/r-scientific/Dockerfile',
]);
const REQUIRED_DEPLOYMENT_TEMPLATES = Object.freeze([
  Object.freeze({
    path: 'paper-core/deploy/autonomous-research-supervisor.k8s.yaml',
    expectedImageCount: 3,
  }),
]);
const DEPLOYMENT_PROFILES = Object.freeze([
  'source-inspection',
  'systemd-host',
  'kubernetes',
]);
const SAST_ROOTS = Object.freeze([
  'workflow-kernel/',
  'paper-domain/',
  'paper-ports/',
  'paper-application/',
  'paper-adapters/',
  'paper-composition/',
  'paper-core/src/',
  'paper-core/bin/',
]);
const SOURCE_SECURITY_ASSURANCE_BOUNDARY = Object.freeze({
  sast: 'bounded_high_confidence_source_patterns_not_complete_program_analysis',
  secretScan: 'git_tracked_regular_text_files_high_confidence_patterns',
  sbom: 'local_package_lock_inventory_not_external_attestation',
  container: 'digest_identity_and_explicit_non_deployable_template_placeholder_policy_not_cve_database_scan',
});
const SECRET_RULES = Object.freeze([
  Object.freeze({ id: 'pem-private-key', pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u }),
  Object.freeze({ id: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/u }),
  Object.freeze({ id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/u }),
  Object.freeze({ id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u }),
  Object.freeze({ id: 'openai-project-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/u }),
  Object.freeze({ id: 'slack-token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/u }),
  Object.freeze({ id: 'stripe-live-secret', pattern: /\bsk_live_[0-9A-Za-z]{20,}\b/u }),
]);
const SAST_RULES = Object.freeze([
  Object.freeze({ id: 'dynamic-eval', pattern: /\beval\s*\(/u }),
  Object.freeze({ id: 'dynamic-function-constructor', pattern: /\bnew\s+Function\s*\(/u }),
  Object.freeze({ id: 'child-process-shell-true', pattern: /\bshell\s*:\s*true\b/u }),
  Object.freeze({ id: 'tls-verification-disabled', pattern: /\brejectUnauthorized\s*:\s*false\b/u }),
  Object.freeze({ id: 'weak-cryptographic-hash', pattern: /\bcreateHash\s*\(\s*['"](?:md5|sha1)['"]\s*\)/u }),
]);

function sha256Bytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function safeRelativePath(value) {
  const normalized = String(value || '').replace(/\\/gu, '/');
  return normalized
    && !path.posix.isAbsolute(normalized)
    && normalized !== '..'
    && !normalized.startsWith('../')
    && !normalized.includes('/../')
    ? normalized : null;
}

function validatePolicy(policy) {
  if (!exactKeys(policy, ['version', 'kind', 'assuranceBoundary', 'sbomPath', 'secretAllowlist'])
    || policy.version !== 1
    || policy.kind !== 'SourceSupplyChainSecurityPolicy'
    || JSON.stringify(policy.assuranceBoundary) !== JSON.stringify(SOURCE_SECURITY_ASSURANCE_BOUNDARY)
    || policy.sbomPath !== REQUIRED_SBOM_PATH
    || !Array.isArray(policy.secretAllowlist)) {
    throw new Error('source_supply_chain_security_policy_invalid');
  }
  const allowlist = policy.secretAllowlist.map((entry) => {
    if (!exactKeys(entry, ['path', 'ruleId', 'lineSha256', 'reason'])
      || !safeRelativePath(entry.path)
      || !SECRET_RULES.some((rule) => rule.id === entry.ruleId)
      || !SHA256.test(String(entry.lineSha256 || ''))
      || typeof entry.reason !== 'string'
      || !entry.reason.trim()) throw new Error('source_security_secret_allowlist_entry_invalid');
    return Object.freeze({ ...entry });
  });
  const identities = allowlist.map((entry) => (
    `${entry.path}\0${entry.ruleId}\0${entry.lineSha256}`
  ));
  if (new Set(identities).size !== identities.length) {
    throw new Error('source_security_secret_allowlist_duplicate');
  }
  return Object.freeze({ ...policy, secretAllowlist: Object.freeze(allowlist) });
}

export function readSourceSupplyChainSecurityPolicy({ workspaceRoot, policyPath }) {
  const relative = safeRelativePath(policyPath);
  if (!relative) throw new Error('source_supply_chain_security_policy_path_invalid');
  const candidate = path.join(workspaceRoot, relative);
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) {
    throw new Error('source_supply_chain_security_policy_file_invalid');
  }
  let policy;
  try { policy = JSON.parse(fs.readFileSync(candidate, 'utf8')); }
  catch { throw new Error('source_supply_chain_security_policy_json_invalid'); }
  return validatePolicy(policy);
}

export function gitTrackedPaths({ workspaceRoot, spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl('git', ['ls-files', '-z', '--cached', '--'], {
    cwd: workspaceRoot,
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw new Error('source_security_git_index_unavailable');
  const paths = Buffer.from(result.stdout || Buffer.alloc(0)).toString('utf8')
    .split('\0').filter(Boolean).map(safeRelativePath);
  if (paths.some((entry) => entry === null)) throw new Error('source_security_git_index_path_invalid');
  return Object.freeze([...new Set(paths)].sort());
}

export function readTrackedTextFiles({ workspaceRoot, trackedPaths }) {
  const files = [];
  const skipped = [];
  const missing = [];
  for (const relative of trackedPaths) {
    const safe = safeRelativePath(relative);
    if (!safe) throw new Error('source_security_tracked_path_invalid');
    const candidate = path.join(workspaceRoot, safe);
    let stat;
    try { stat = fs.lstatSync(candidate); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        missing.push(safe);
        continue;
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      skipped.push(Object.freeze({ path: safe, reason: 'tracked_non_regular_file' }));
      continue;
    }
    const bytes = fs.readFileSync(candidate);
    if (bytes.includes(0)) {
      skipped.push(Object.freeze({ path: safe, reason: 'tracked_binary_file' }));
      continue;
    }
    files.push(Object.freeze({ path: safe, text: bytes.toString('utf8') }));
  }
  return Object.freeze({
    files: Object.freeze(files),
    skipped: Object.freeze(skipped),
    missing: Object.freeze(missing),
  });
}

function scanLines(files, rules, includePath = () => true) {
  return files.filter((file) => includePath(file.path)).flatMap((file) => (
    file.text.split(/\r?\n/u).flatMap((line, index) => rules.flatMap((rule) => (
      rule.pattern.test(line) ? [Object.freeze({
        path: file.path,
        line: index + 1,
        ruleId: rule.id,
        lineSha256: sha256Bytes(line),
      })] : []
    )))
  ));
}

export function inspectTrackedSecretScan({ trackedText, allowlist = [] }) {
  const findings = scanLines(trackedText.files, SECRET_RULES);
  const observed = new Set(findings.map((finding) => (
    `${finding.path}\0${finding.ruleId}\0${finding.lineSha256}`
  )));
  const allowed = new Set(allowlist.map((entry) => (
    `${entry.path}\0${entry.ruleId}\0${entry.lineSha256}`
  )));
  const unallowedFindings = findings.filter((finding) => !allowed.has(
    `${finding.path}\0${finding.ruleId}\0${finding.lineSha256}`,
  ));
  const staleAllowlist = allowlist.filter((entry) => !observed.has(
    `${entry.path}\0${entry.ruleId}\0${entry.lineSha256}`,
  ));
  const blockers = [
    ...unallowedFindings.map((finding) => (
      `tracked_secret_finding:${finding.ruleId}:${finding.path}:${finding.line}`
    )),
    ...staleAllowlist.map((entry) => (
      `tracked_secret_allowlist_stale:${entry.ruleId}:${entry.path}`
    )),
  ].sort();
  return Object.freeze({
    status: blockers.length ? 'tracked_secret_scan_blocked' : 'tracked_secret_scan_ready',
    scope: SOURCE_SECURITY_ASSURANCE_BOUNDARY.secretScan,
    scannedTextFileCount: trackedText.files.length,
    skippedTrackedFileCount: trackedText.skipped.length,
    missingTrackedFileCount: trackedText.missing.length,
    findingCount: findings.length,
    allowedFindingCount: findings.length - unallowedFindings.length,
    findings: Object.freeze(findings),
    staleAllowlist: Object.freeze(staleAllowlist),
    blockers: Object.freeze(blockers),
  });
}

function isSastSource(relative) {
  return SAST_ROOTS.some((root) => relative.startsWith(root))
    && /\.(?:c|js|mjs|sh)$/u.test(relative)
    && !relative.includes('/tests/');
}

export function inspectBoundedSast({ trackedText }) {
  const findings = scanLines(trackedText.files, SAST_RULES, isSastSource);
  const blockers = findings.map((finding) => (
    `bounded_sast_finding:${finding.ruleId}:${finding.path}:${finding.line}`
  ));
  return Object.freeze({
    status: blockers.length ? 'bounded_sast_blocked' : 'bounded_sast_ready',
    scope: SOURCE_SECURITY_ASSURANCE_BOUNDARY.sast,
    ruleIds: Object.freeze(SAST_RULES.map((rule) => rule.id)),
    findings: Object.freeze(findings),
    blockers: Object.freeze(blockers),
  });
}

export function inspectWorkflowActionPins({ trackedText }) {
  const actions = [];
  const blockers = [];
  for (const file of trackedText.files.filter((entry) => (
    /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(entry.path)
  ))) {
    file.text.split(/\r?\n/u).forEach((line, index) => {
      const match = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/u.exec(line);
      if (!match) return;
      const reference = match[1].replace(/^(['"])(.*)\1$/u, '$2');
      const local = reference.startsWith('./');
      const pinned = local
        || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[a-f0-9]{40}$/u.test(reference);
      actions.push(Object.freeze({ path: file.path, line: index + 1, local, pinned, reference }));
      if (!pinned) blockers.push(`workflow_action_not_commit_pinned:${file.path}:${index + 1}`);
    });
  }
  return Object.freeze({
    status: blockers.length ? 'workflow_action_pin_policy_blocked' : 'workflow_action_pin_policy_ready',
    remoteActionCount: actions.filter((action) => !action.local).length,
    localActionCount: actions.filter((action) => action.local).length,
    actions: Object.freeze(actions),
    blockers: Object.freeze(blockers),
  });
}

function inspectDockerfile(workspaceRoot, relative) {
  const text = fs.readFileSync(path.join(workspaceRoot, relative), 'utf8');
  const syntax = /^#\s*syntax=([^\s]+)$/mu.exec(text)?.[1] || null;
  const bases = [...text.matchAll(/^FROM\s+([^\s]+)(?:\s+AS\s+\S+)?\s*$/gimu)]
    .map((match) => match[1]);
  const blockers = [];
  if (!syntax || !PINNED_REFERENCE.test(syntax)) blockers.push(`dockerfile_frontend_not_digest_pinned:${relative}`);
  if (!bases.length) blockers.push(`dockerfile_base_missing:${relative}`);
  for (const base of bases) {
    if (base !== 'scratch' && !PINNED_REFERENCE.test(base)) {
      blockers.push(`dockerfile_base_not_digest_pinned:${relative}`);
    }
  }
  return Object.freeze({ path: relative, syntax, bases: Object.freeze(bases), blockers: Object.freeze(blockers) });
}

export function inspectContainerIdentityPolicy({ workspaceRoot }) {
  const blockers = [];
  const runtimeImages = Object.entries(SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES).map(([profile, runtime]) => {
    const digest = String(runtime.imageDigest || '').toLowerCase();
    const image = String(runtime.image || '');
    const embeddedDigest = image.includes('@') ? image.slice(image.lastIndexOf('@') + 1) : null;
    const pinned = Boolean(image
      && !image.endsWith(':latest')
      && SHA256.test(digest)
      && (!embeddedDigest || embeddedDigest === digest));
    if (!pinned) blockers.push(`production_runtime_image_not_digest_pinned:${profile}`);
    return Object.freeze({ profile, image, imageDigest: digest, pullReference: `${image.split('@')[0]}@${digest}`, pinned });
  });
  const formal = SYSTEM_PINNED_FORMAL_SANDBOX_RUNTIME_CONFIGURATION;
  const formalPinned = PINNED_REFERENCE.test(formal.image)
    && formal.image.endsWith(`@${formal.imageDigest}`);
  if (!formalPinned) blockers.push('formal_sandbox_image_not_digest_pinned');
  const dockerfiles = REQUIRED_DOCKERFILES.map((relative) => inspectDockerfile(workspaceRoot, relative));
  blockers.push(...dockerfiles.flatMap((row) => row.blockers));
  const deploymentImages = [];
  for (const requirement of REQUIRED_DEPLOYMENT_TEMPLATES) {
    const relative = requirement.path;
    const text = fs.readFileSync(path.join(workspaceRoot, relative), 'utf8');
    const imageCountBefore = deploymentImages.length;
    text.split(/\r?\n/u).forEach((line, index) => {
      const match = /^\s*image:\s*([^\s#]+)\s*$/u.exec(line);
      if (!match) return;
      const reference = match[1];
      const placeholder = reference === 'REPLACE_WITH_PINNED_HEPTA_IMAGE_DIGEST';
      const pinned = PINNED_REFERENCE.test(reference);
      const sourcePolicyCompliant = pinned || placeholder;
      const disposition = pinned
        ? 'digest_pinned_deployable_image'
        : placeholder
          ? 'explicit_non_deployable_placeholder'
          : 'mutable_or_unresolved_image_reference';
      deploymentImages.push(Object.freeze({
        path: relative,
        line: index + 1,
        reference,
        placeholder,
        pinned,
        deployable: pinned,
        sourcePolicyCompliant,
        disposition,
      }));
      if (!sourcePolicyCompliant) {
        blockers.push(`deployment_container_image_not_digest_pinned_or_explicit_placeholder:${relative}:${index + 1}`);
      }
    });
    const observedImageCount = deploymentImages.length - imageCountBefore;
    if (observedImageCount !== requirement.expectedImageCount) {
      blockers.push(`deployment_container_image_count_mismatch:${relative}:${observedImageCount}:${requirement.expectedImageCount}`);
    }
  }
  const deploymentTemplateInstantiationReady = deploymentImages.length > 0
    && deploymentImages.every((entry) => entry.pinned);
  const deploymentTemplateStatus = deploymentTemplateInstantiationReady
    ? 'deployment_template_digest_pinned'
    : deploymentImages.some((entry) => entry.placeholder)
      ? 'deployment_template_explicitly_non_deployable'
      : 'deployment_template_identity_blocked';
  const workflow = fs.readFileSync(path.join(workspaceRoot, '.github/workflows/ci.yml'), 'utf8');
  const ciFormalImage = /^\s*FORMAL_SANDBOX_IMAGE:\s*([^\s#]+)\s*$/mu.exec(workflow)?.[1] || null;
  if (ciFormalImage !== formal.image) blockers.push('ci_formal_sandbox_image_identity_mismatch');
  return Object.freeze({
    status: blockers.length ? 'container_source_identity_policy_blocked' : 'container_source_identity_policy_ready',
    assuranceBoundary: SOURCE_SECURITY_ASSURANCE_BOUNDARY.container,
    cveDatabaseScanPerformed: false,
    registryManifestFetched: false,
    runtimeImages: Object.freeze(runtimeImages),
    formalSandbox: Object.freeze({ image: formal.image, imageDigest: formal.imageDigest, pinned: formalPinned }),
    dockerfiles: Object.freeze(dockerfiles),
    deploymentTemplateRequirements: REQUIRED_DEPLOYMENT_TEMPLATES,
    deploymentImages: Object.freeze(deploymentImages),
    deploymentTemplateStatus,
    deploymentTemplateInstantiationReady,
    blockers: Object.freeze(blockers.sort()),
  });
}

function inspectCommittedSbom({ workspaceRoot, sbomPath }) {
  const expected = buildCycloneDxLockfileSbomFromFiles({ workspaceRoot });
  const candidate = path.join(workspaceRoot, sbomPath);
  let actual = null;
  try {
    const stat = fs.lstatSync(candidate);
    if (stat.isFile() && !stat.isSymbolicLink()) actual = fs.readFileSync(candidate);
  } catch { /* A missing generated SBOM is reported below. */ }
  const matches = Boolean(actual && actual.equals(expected.bytes));
  const blockers = matches ? [] : ['cyclonedx_lockfile_sbom_regeneration_required'];
  return Object.freeze({
    status: matches ? 'cyclonedx_lockfile_sbom_verified' : 'cyclonedx_lockfile_sbom_blocked',
    format: 'CycloneDX-1.5',
    evidenceClass: SOURCE_SECURITY_ASSURANCE_BOUNDARY.sbom,
    sbomPath,
    componentCount: expected.sbom.components.length,
    packageJsonHash: expected.packageJsonHash,
    packageLockHash: expected.packageLockHash,
    expectedSbomHash: expected.sbomHash,
    actualSbomHash: actual ? sha256Bytes(actual) : null,
    blockers: Object.freeze(blockers),
  });
}

export function writeLocalLockfileSbom({ workspaceRoot, sbomPath = REQUIRED_SBOM_PATH }) {
  if (sbomPath !== REQUIRED_SBOM_PATH) throw new Error('source_security_sbom_path_invalid');
  const generated = buildCycloneDxLockfileSbomFromFiles({ workspaceRoot });
  const candidate = path.join(workspaceRoot, sbomPath);
  const parent = path.dirname(candidate);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('source_security_sbom_parent_invalid');
  try {
    const existing = fs.lstatSync(candidate);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('source_security_sbom_target_invalid');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(parent, `.source-supply-chain-sbom-${process.pid}`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
    fs.writeFileSync(descriptor, generated.bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, candidate);
    const parentDescriptor = fs.openSync(parent, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
    try { fs.fsyncSync(parentDescriptor); } finally { fs.closeSync(parentDescriptor); }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  return Object.freeze({ path: sbomPath, sbomHash: generated.sbomHash, componentCount: generated.sbom.components.length });
}

export function inspectSourceSupplyChainSecurity({
  workspaceRoot,
  policyPath = 'paper-core/config/source-supply-chain-security-policy.v1.json',
  trackedPaths = null,
  requireDeployableTemplates = false,
  deploymentProfile = null,
} = {}) {
  const selectedDeploymentProfile = deploymentProfile === null
    ? (requireDeployableTemplates ? 'kubernetes' : 'source-inspection')
    : deploymentProfile;
  if (!DEPLOYMENT_PROFILES.includes(selectedDeploymentProfile)
    || (requireDeployableTemplates && selectedDeploymentProfile !== 'kubernetes')) {
    throw new Error('source_supply_chain_security_deployment_profile_invalid');
  }
  const policy = readSourceSupplyChainSecurityPolicy({ workspaceRoot, policyPath });
  const selectedTrackedPaths = trackedPaths || gitTrackedPaths({ workspaceRoot });
  const trackedText = readTrackedTextFiles({ workspaceRoot, trackedPaths: selectedTrackedPaths });
  const sbom = inspectCommittedSbom({ workspaceRoot, sbomPath: policy.sbomPath });
  const secrets = inspectTrackedSecretScan({ trackedText, allowlist: policy.secretAllowlist });
  const sast = inspectBoundedSast({ trackedText });
  const workflows = inspectWorkflowActionPins({ trackedText });
  const containers = inspectContainerIdentityPolicy({ workspaceRoot });
  const deployableTemplatesRequired = selectedDeploymentProfile === 'kubernetes';
  const deploymentTemplateBlockers = deployableTemplatesRequired
    && !containers.deploymentTemplateInstantiationReady
    ? ['deployment_container_templates_not_instantiated']
    : [];
  const blockers = [
    ...sbom.blockers,
    ...secrets.blockers,
    ...sast.blockers,
    ...workflows.blockers,
    ...containers.blockers,
    ...deploymentTemplateBlockers,
  ];
  return Object.freeze({
    version: 1,
    kind: 'SourceSupplyChainSecurityReport',
    status: blockers.length ? 'source_supply_chain_security_blocked' : 'source_supply_chain_security_ready',
    deploymentProfile: selectedDeploymentProfile,
    deployableTemplatesRequired,
    kubernetesProfileSelected: selectedDeploymentProfile === 'kubernetes',
    assuranceBoundary: SOURCE_SECURITY_ASSURANCE_BOUNDARY,
    trackedPathCount: selectedTrackedPaths.length,
    sbom,
    secrets,
    sast,
    workflows,
    containers,
    blockers: Object.freeze(blockers.sort()),
  });
}

export {
  REQUIRED_SBOM_PATH,
  SOURCE_SECURITY_ASSURANCE_BOUNDARY,
};
