import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { restrictedChildEnvironment } from '../automation/bounded-child-process.mjs';
import {
  PRODUCTION_LEAN_TOOLCHAIN,
  PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES,
} from '../../paper-domain/research/formal-verifier-policy.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { readFormalProjectClosureSync } from './formal-project-closure-reader.mjs';
import { createLeanToolchainIdentityProvider } from './lean-toolchain-identity.mjs';
import { resolvePinnedLakeExecutable } from './pinned-lake-executable-resolver.mjs';
import {
  configuredPinnedFormalSandboxRuntime,
} from './pinned-formal-sandbox-runtime-configuration.mjs';
import {
  inspectProductionMathlibRelease,
  validateProductionMathlibManifest,
  verifyProductionMathlibReleaseIdentity,
} from './production-mathlib-release-provenance.mjs';
import {
  verifyProductionMathlibBuildAuthority,
} from './production-mathlib-build-authority.mjs';
import {
  inspectConfiguredProductionMathlibBuildAuthority,
  PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIGURATION_HASH_ENV,
} from './production-mathlib-build-authority-configuration.mjs';
import {
  executeDynamicFormalSandboxProbe,
} from './dynamic-formal-sandbox-probe-verifier.mjs';
import {
  createDynamicFormalSandboxProbeQualificationRepository,
} from './dynamic-formal-sandbox-probe-qualification-repository.mjs';
import {
  buildDynamicFormalExecutionAuthority,
  verifyDynamicFormalExecutionAuthority,
} from './dynamic-formal-execution-authority.mjs';

export {
  buildDynamicFormalExecutionAuthority,
  verifyDynamicFormalExecutionAuthority,
};

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_RELATIVE_LEAN = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,255}\.lean$/;

function blocked(blockers, details = {}) {
  const payload = {
    version: 1,
    kind: 'DynamicFormalProjectClosureReadiness',
    status: 'dynamic_formal_project_closure_blocked',
    ready: false,
    imports: Object.freeze(['Mathlib']),
    toolchain: PRODUCTION_LEAN_TOOLCHAIN,
    projectRoot: details.projectRoot || null,
    projectScopeRoot: details.projectScopeRoot || null,
    probeRelativePath: details.probeRelativePath || null,
    formalProjectClosureHash: details.formalProjectClosureHash || null,
    formalProjectManifestHash: details.formalProjectManifestHash || null,
    toolchainRootMerkleHash: details.toolchainRootMerkleHash || null,
    toolchainContentIdentityHash: details.toolchainContentIdentityHash || null,
    mathlibPackageSourcePath: details.mathlibPackageSourcePath || null,
    productionMathlibReleaseIdentity:
      details.productionMathlibReleaseIdentity || null,
    productionMathlibReleaseIdentityHash:
      details.productionMathlibReleaseIdentityHash || null,
    productionMathlibBuildAuthority:
      details.productionMathlibBuildAuthority || null,
    productionMathlibBuildAuthorityHash:
      details.productionMathlibBuildAuthorityHash || null,
    formalSandboxRuntimeConfigurationHash:
      details.formalSandboxRuntimeConfigurationHash || null,
    formalSandboxRuntimeImage: details.formalSandboxRuntimeImage || null,
    formalSandboxRuntimeImageDigest: details.formalSandboxRuntimeImageDigest || null,
    formalSandboxProbeReceiptHash: details.formalSandboxProbeReceiptHash || null,
    formalSandboxProbeRuntimeIdentityHash:
      details.formalSandboxProbeRuntimeIdentityHash || null,
    formalSandboxProbeExecutionProcessIdentityHash:
      details.formalSandboxProbeExecutionProcessIdentityHash || null,
    formalSandboxProbeSnapshotSealReceipt:
      details.formalSandboxProbeSnapshotSealReceipt || null,
    formalSandboxProbeSnapshotSealReceiptHash:
      details.formalSandboxProbeSnapshotSealReceiptHash || null,
    executableProbeVerified: false,
    postProbeReinspectionVerified: false,
    blockers: Object.freeze([...new Set(blockers)]),
  };
  return Object.freeze({
    ...payload,
    dynamicFormalProjectClosureReadinessHash: hashRecord(
      'DynamicFormalProjectClosureReadiness', payload,
    ),
  });
}

function readManifest(projectRoot) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, 'lake-manifest.json'), 'utf8'));
}

function authoritativeClosureFiles(closure) {
  return (closure?.files || []).map((file) => ({
    path: file.path,
    sourcePath: file.sourcePath,
    projectPath: file.projectPath,
    role: file.role,
    hash: file.hash,
    bytes: file.bytes,
    posixMode: file.posixMode,
    scopedFileReadReceiptHash: file.scopedFileReadReceiptHash,
  }));
}

const PASSIVE_PROBE_IDENTITY_FIELDS = Object.freeze([
  'formalProjectClosureHash',
  'formalProjectManifestHash',
  'formalSandboxRuntimeConfigurationHash',
  'formalSandboxRuntimeImage',
  'formalSandboxRuntimeImageDigest',
  'mathlibPackageSourcePath',
  'probeRelativePath',
  'productionMathlibBuildAuthorityHash',
  'productionMathlibReleaseIdentityHash',
  'projectRoot',
  'projectScopeRoot',
  'toolchain',
  'toolchainContentIdentityHash',
  'toolchainRootMerkleHash',
]);

function passiveProbeIdentityMismatches(cached, details) {
  return [
    ...PASSIVE_PROBE_IDENTITY_FIELDS.filter((field) => (
      cached?.[field] !== details?.[field]
    )),
    ...(JSON.stringify(cached?.productionMathlibReleaseIdentity)
      === JSON.stringify(details?.productionMathlibReleaseIdentity)
      ? [] : ['productionMathlibReleaseIdentity']),
    ...(JSON.stringify(cached?.productionMathlibBuildAuthority)
      === JSON.stringify(details?.productionMathlibBuildAuthority)
      ? [] : ['productionMathlibBuildAuthority']),
  ];
}

function cachedProbeQualificationReady(cached) {
  return cached?.status === 'dynamic_formal_project_closure_ready'
    && cached.ready === true
    && cached.executableProbeVerified === true
    && cached.postProbeReinspectionVerified === true
    && cached.blockers?.length === 0
    && SHA256.test(String(cached.formalSandboxProbeReceiptHash || ''))
    && SHA256.test(String(
      cached.formalSandboxProbeRuntimeIdentityHash || '',
    ))
    && SHA256.test(String(
      cached.formalSandboxProbeExecutionProcessIdentityHash || '',
    ))
    && SHA256.test(String(
      cached.formalSandboxProbeSnapshotSealReceiptHash || '',
    ));
}

export function inspectConfiguredDynamicFormalProjectClosure({
  environment = process.env,
  runtimeRoot = null,
  activeProbe = undefined,
  publishActiveProbeReceipt = false,
  probeQualificationRepository = null,
  probeQualificationClock = { now: () => new Date() },
  spawnSyncImpl = spawnSync,
  resolvePinnedRuntime = resolvePinnedLakeExecutable,
  readClosure = readFormalProjectClosureSync,
  inspectToolchain = null,
  sandboxProbeRunnerFactory = undefined,
  verifySandboxProbeReceipt = undefined,
  projectSnapshotRepository = undefined,
  inspectMathlibRelease = inspectProductionMathlibRelease,
  inspectMathlibBuildAuthority = inspectConfiguredProductionMathlibBuildAuthority,
  mathlibBuildAuthorityClock = () => new Date().toISOString(),
  trustedMathlibBuildClosureHashes = undefined,
} = {}) {
  const selectedRuntimeRoot = runtimeRoot
    ? path.resolve(runtimeRoot)
    : String(environment.HEPTA_PAPER_RUNTIME_ROOT || '').trim()
      ? path.resolve(environment.HEPTA_PAPER_RUNTIME_ROOT)
      : null;
  const activeProbeRequested = activeProbe === undefined
    ? selectedRuntimeRoot === null
    : activeProbe === true;
  const qualificationRepository = probeQualificationRepository
    || (selectedRuntimeRoot
      ? createDynamicFormalSandboxProbeQualificationRepository({
        runtimeRoot: selectedRuntimeRoot,
        clock: probeQualificationClock,
      }) : null);
  let projectRoot = path.resolve(String(
    environment.HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT || '',
  ));
  let projectScopeRoot = path.resolve(String(
    environment.HEPTA_DYNAMIC_FORMAL_PROJECT_SCOPE_ROOT
      || environment.HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT || '',
  ));
  const expectedClosureHash = String(
    environment.HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH || '',
  ).trim().toLowerCase();
  const probeRelativePath = String(
    environment.HEPTA_DYNAMIC_FORMAL_PROJECT_PROBE || '',
  ).trim();
  const details = { projectRoot, projectScopeRoot, probeRelativePath };
  const blockers = [];
  if (!String(environment.HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT || '').trim()) {
    blockers.push('dynamic_formal_project_root_required');
  }
  if (!SHA256.test(expectedClosureHash)) {
    blockers.push('dynamic_formal_project_closure_hash_required');
  }
  if (!SAFE_RELATIVE_LEAN.test(probeRelativePath)
    || path.isAbsolute(probeRelativePath)
    || probeRelativePath.split('/').includes('..')) {
    blockers.push('dynamic_formal_mathlib_probe_path_invalid');
  }
  if (blockers.length) return blocked(blockers, details);

  try {
    projectRoot = fs.realpathSync.native(projectRoot);
    projectScopeRoot = fs.realpathSync.native(projectScopeRoot);
    details.projectRoot = projectRoot;
    details.projectScopeRoot = projectScopeRoot;
    const toolchainSource = fs.readFileSync(path.join(projectRoot, 'lean-toolchain'), 'utf8').trim();
    if (toolchainSource !== PRODUCTION_LEAN_TOOLCHAIN) {
      blockers.push('dynamic_formal_project_toolchain_mismatch');
    }
    const manifest = readManifest(projectRoot);
    const productionManifest = validateProductionMathlibManifest({
      manifest,
      toolchain: PRODUCTION_LEAN_TOOLCHAIN,
    });
    if (!productionManifest.valid) {
      return blocked([...blockers, ...productionManifest.blockers], details);
    }
    const mathlibRoot = fs.realpathSync.native(path.resolve(
      projectRoot,
      ...productionManifest.packageSourcePath.split('/'),
    ));
    if (!isPathWithin(projectScopeRoot, mathlibRoot)) {
      blockers.push('dynamic_formal_mathlib_path_outside_scope');
    }
    const closure = readClosure({ projectRoot, dependencyScopeRoot: projectScopeRoot });
    details.formalProjectClosureHash = closure?.formalProjectClosureHash || null;
    details.formalProjectManifestHash = closure?.manifestHash || null;
    details.mathlibPackageSourcePath = path.relative(projectScopeRoot, mathlibRoot)
      .replaceAll('\\', '/');
    const mathlibPrefix = `${details.mathlibPackageSourcePath}/`;
    if (closure?.status !== 'formal_project_closure_verified') {
      blockers.push(...(closure?.blockers || ['dynamic_formal_project_closure_invalid']));
    }
    if (closure?.formalProjectClosureHash !== expectedClosureHash) {
      blockers.push('dynamic_formal_project_closure_hash_mismatch');
    }
    if (!closure?.files?.some((file) => (
      file.sourcePath === details.mathlibPackageSourcePath
        || file.sourcePath.startsWith(mathlibPrefix)
    ))) {
      blockers.push('dynamic_formal_mathlib_closure_files_required');
    }
    const probeAbsolute = path.resolve(projectRoot, probeRelativePath);
    if (!isPathWithin(projectRoot, probeAbsolute)) {
      blockers.push('dynamic_formal_mathlib_probe_outside_project');
    }
    const probe = closure?.files?.find((file) => file.projectPath === probeRelativePath);
    const probeBytes = probe ? fs.readFileSync(probeAbsolute) : null;
    if (!probe || hashBytes(probeBytes) !== probe.hash
      || !/^\s*import\s+Mathlib(?:\s|$)/m.test(probeBytes.toString('utf8'))) {
      blockers.push('dynamic_formal_mathlib_probe_not_closure_bound');
    }

    const productionMathlibReleaseIdentity = inspectMathlibRelease({
      manifest,
      projectRoot,
      projectScopeRoot,
      toolchain: PRODUCTION_LEAN_TOOLCHAIN,
      spawnSyncImpl,
    });
    details.productionMathlibReleaseIdentity = productionMathlibReleaseIdentity;
    details.productionMathlibReleaseIdentityHash =
      productionMathlibReleaseIdentity?.productionMathlibReleaseIdentityHash || null;
    if (!verifyProductionMathlibReleaseIdentity(productionMathlibReleaseIdentity)) {
      blockers.push(...(productionMathlibReleaseIdentity?.blockers
        || ['dynamic_formal_mathlib_release_provenance_required']));
    }
    const preProbeBuildAuthorityObservedAt = mathlibBuildAuthorityClock();
    let productionMathlibBuildAuthority = null;
    try {
      productionMathlibBuildAuthority = inspectMathlibBuildAuthority({
        environment,
        formalProjectClosureHash: closure?.formalProjectClosureHash || null,
        productionMathlibReleaseIdentityHash:
          details.productionMathlibReleaseIdentityHash,
        trustedClosureHashes: trustedMathlibBuildClosureHashes,
        observedAt: preProbeBuildAuthorityObservedAt,
      });
    } catch (error) {
      blockers.push(
        `dynamic_formal_mathlib_build_authority_configuration_invalid:${String(
          error?.message || error,
        )}`,
      );
    }
    details.productionMathlibBuildAuthority = productionMathlibBuildAuthority;
    details.productionMathlibBuildAuthorityHash =
      productionMathlibBuildAuthority?.productionMathlibBuildAuthorityHash || null;
    if (productionMathlibBuildAuthority
      && !verifyProductionMathlibBuildAuthority(productionMathlibBuildAuthority, {
      trustedClosureHashes: trustedMathlibBuildClosureHashes,
      observedAt: preProbeBuildAuthorityObservedAt,
      expectedConfigurationHash: String(environment?.[
        PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIGURATION_HASH_ENV
      ] || '').trim().toLowerCase() || null,
    })) {
      blockers.push(...productionMathlibBuildAuthority.blockers);
    }

    const pinned = resolvePinnedRuntime({
      toolchain: PRODUCTION_LEAN_TOOLCHAIN,
      environment,
      spawnSyncImpl,
    });
    if (pinned?.status !== 'formal_pinned_lake_resolved') {
      blockers.push(...(pinned?.blockers || ['dynamic_formal_pinned_lake_unavailable']));
    }
    const formalSandboxRuntimeConfiguration = configuredPinnedFormalSandboxRuntime({
      environment,
      allowSystemDefault: true,
    });
    details.formalSandboxRuntimeConfigurationHash =
      formalSandboxRuntimeConfiguration.configurationHash;
    details.formalSandboxRuntimeImage = formalSandboxRuntimeConfiguration.image;
    details.formalSandboxRuntimeImageDigest =
      formalSandboxRuntimeConfiguration.imageDigest;
    const expectedToolchainMerkle =
      PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES[PRODUCTION_LEAN_TOOLCHAIN];
    const toolchainIdentity = pinned?.status === 'formal_pinned_lake_resolved'
      ? (inspectToolchain
          ? inspectToolchain(pinned)
          : createLeanToolchainIdentityProvider({
            toolchain: PRODUCTION_LEAN_TOOLCHAIN,
            toolchainRoot: pinned.toolchainRoot,
            leanExecutable: pinned.leanExecutable,
            lakeExecutable: pinned.lakeExecutable,
            expectedToolchainRootMerkleHash: expectedToolchainMerkle,
          }).inspect())
      : null;
    details.toolchain = PRODUCTION_LEAN_TOOLCHAIN;
    details.toolchainRootMerkleHash = toolchainIdentity?.toolchainRootMerkleHash || null;
    details.toolchainContentIdentityHash =
      toolchainIdentity?.leanToolchainContentIdentityHash || null;
    if (toolchainIdentity?.status !== 'lean_toolchain_identity_verified'
      || toolchainIdentity.toolchainRootMerkleHash !== expectedToolchainMerkle
      || !SHA256.test(String(toolchainIdentity.leanToolchainContentIdentityHash || ''))) {
      blockers.push(...(toolchainIdentity?.blockers
        || ['dynamic_formal_toolchain_content_identity_required']));
    }
    let cachedProbeReadiness = null;
    if (!blockers.length && !activeProbeRequested) {
      const qualification = qualificationRepository?.inspect() || null;
      if (qualification?.ready !== true) {
        blockers.push(...(qualification?.blockers || [
          'dynamic_formal_sandbox_probe_qualification_receipt_required',
        ]));
      } else {
        cachedProbeReadiness = qualification.receipt
          ?.dynamicFormalProjectClosureReadiness || null;
        const identityMismatches = passiveProbeIdentityMismatches(
          cachedProbeReadiness,
          details,
        );
        if (!cachedProbeQualificationReady(cachedProbeReadiness)
          || identityMismatches.length) {
          blockers.push(
            'dynamic_formal_sandbox_probe_qualification_identity_mismatch',
            ...identityMismatches.map((field) => (
              `dynamic_formal_sandbox_probe_qualification_identity_mismatch:${field}`
            )),
          );
        } else {
          details.formalSandboxProbeSnapshotSealReceipt =
            cachedProbeReadiness.formalSandboxProbeSnapshotSealReceipt;
          details.formalSandboxProbeSnapshotSealReceiptHash =
            cachedProbeReadiness.formalSandboxProbeSnapshotSealReceiptHash;
          details.formalSandboxProbeReceiptHash =
            cachedProbeReadiness.formalSandboxProbeReceiptHash;
          details.formalSandboxProbeRuntimeIdentityHash =
            cachedProbeReadiness.formalSandboxProbeRuntimeIdentityHash;
          details.formalSandboxProbeExecutionProcessIdentityHash =
            cachedProbeReadiness
              .formalSandboxProbeExecutionProcessIdentityHash;
        }
      }
    }
    let probeResult = null;
    if (!blockers.length && activeProbeRequested) {
      probeResult = spawnSyncImpl(pinned.lakeExecutable, ['env', 'lean', probeRelativePath], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true,
        env: restrictedChildEnvironment({
          source: environment,
          overrides: { ELAN_TOOLCHAIN: PRODUCTION_LEAN_TOOLCHAIN },
        }),
      });
      if (probeResult?.status !== 0 || probeResult?.error) {
        blockers.push('dynamic_formal_mathlib_executable_probe_failed');
      }
    }
    let sandboxProbeReceipt = null;
    if (!blockers.length && activeProbeRequested) {
      const probe = executeDynamicFormalSandboxProbe({
        manifest,
        closure,
        projectRoot,
        projectScopeRoot,
        probeRelativePath,
        environment,
        pinnedRuntime: pinned,
        formalSandboxRuntimeConfiguration,
        readClosure,
        spawnSyncImpl,
        sandboxProbeRunnerFactory,
        projectSnapshotRepository,
        verifySandboxProbeReceipt,
      });
      sandboxProbeReceipt = probe.sandboxProbeReceipt;
      blockers.push(...probe.blockers);
      details.formalSandboxProbeSnapshotSealReceipt =
        probe.snapshotSealReceipt;
      details.formalSandboxProbeSnapshotSealReceiptHash =
        probe.snapshotSealReceipt?.formalProjectSnapshotSealReceiptHash || null;
      details.formalSandboxProbeReceiptHash = sandboxProbeReceipt?.receiptHash || null;
      details.formalSandboxProbeRuntimeIdentityHash =
        sandboxProbeReceipt?.runtimeIdentityHash || null;
      details.formalSandboxProbeExecutionProcessIdentityHash =
        sandboxProbeReceipt?.executionProcessIdentityHash || null;
    }
    let postProbeClosure = null;
    let postProbeToolchainIdentity = null;
    if (!blockers.length && activeProbeRequested) {
      const postProbeToolchainSource = fs.readFileSync(
        path.join(projectRoot, 'lean-toolchain'), 'utf8',
      ).trim();
      if (postProbeToolchainSource !== PRODUCTION_LEAN_TOOLCHAIN) {
        blockers.push('dynamic_formal_project_toolchain_changed_during_probe');
      }
      const postProbeManifest = readManifest(projectRoot);
      const postProbeProductionManifest = validateProductionMathlibManifest({
        manifest: postProbeManifest,
        toolchain: PRODUCTION_LEAN_TOOLCHAIN,
      });
      const postProbeMathlibRoot = postProbeProductionManifest.valid
        ? fs.realpathSync.native(path.resolve(
          projectRoot,
          ...postProbeProductionManifest.packageSourcePath.split('/'),
        )) : null;
      if (!postProbeProductionManifest.valid
        || postProbeMathlibRoot !== mathlibRoot
        || JSON.stringify(postProbeProductionManifest.packageEntry)
          !== JSON.stringify(productionManifest.packageEntry)) {
        blockers.push('dynamic_formal_mathlib_manifest_changed_during_probe');
      }
      postProbeClosure = readClosure({
        projectRoot,
        dependencyScopeRoot: projectScopeRoot,
      });
      if (postProbeClosure?.status !== 'formal_project_closure_verified'
        || postProbeClosure.formalProjectClosureHash !== expectedClosureHash
        || postProbeClosure.formalProjectClosureHash !== closure.formalProjectClosureHash
        || postProbeClosure.manifestHash !== closure.manifestHash
        || JSON.stringify(authoritativeClosureFiles(postProbeClosure))
          !== JSON.stringify(authoritativeClosureFiles(closure))) {
        blockers.push('dynamic_formal_project_closure_changed_during_probe');
      }
      const postProbe = postProbeClosure?.files?.find((file) => (
        file.projectPath === probeRelativePath
      ));
      const postProbeBytes = postProbe ? fs.readFileSync(probeAbsolute) : null;
      if (!postProbe || hashBytes(postProbeBytes) !== probe.hash
        || !probeBytes.equals(postProbeBytes)
        || !/^\s*import\s+Mathlib(?:\s|$)/m.test(postProbeBytes.toString('utf8'))) {
        blockers.push('dynamic_formal_mathlib_probe_changed_during_execution');
      }
      postProbeToolchainIdentity = inspectToolchain
        ? inspectToolchain(pinned)
        : createLeanToolchainIdentityProvider({
          toolchain: PRODUCTION_LEAN_TOOLCHAIN,
          toolchainRoot: pinned.toolchainRoot,
          leanExecutable: pinned.leanExecutable,
          lakeExecutable: pinned.lakeExecutable,
          expectedToolchainRootMerkleHash: expectedToolchainMerkle,
        }).inspect({ forceContentRehash: true });
      if (postProbeToolchainIdentity?.status !== 'lean_toolchain_identity_verified'
        || postProbeToolchainIdentity.toolchainRootMerkleHash !== expectedToolchainMerkle
        || postProbeToolchainIdentity.toolchainRootMerkleHash
          !== toolchainIdentity.toolchainRootMerkleHash
        || postProbeToolchainIdentity.leanToolchainContentIdentityHash
          !== toolchainIdentity.leanToolchainContentIdentityHash) {
        blockers.push('dynamic_formal_toolchain_identity_changed_during_probe');
      }
      const postProbeMathlibReleaseIdentity = inspectMathlibRelease({
        manifest: postProbeManifest,
        projectRoot,
        projectScopeRoot,
        toolchain: PRODUCTION_LEAN_TOOLCHAIN,
        spawnSyncImpl,
      });
      if (!verifyProductionMathlibReleaseIdentity(
        postProbeMathlibReleaseIdentity,
      ) || JSON.stringify(postProbeMathlibReleaseIdentity)
        !== JSON.stringify(productionMathlibReleaseIdentity)) {
        blockers.push('dynamic_formal_mathlib_release_changed_during_probe');
      }
      const postProbeBuildAuthorityObservedAt = mathlibBuildAuthorityClock();
      let postProbeMathlibBuildAuthority = null;
      try {
        postProbeMathlibBuildAuthority = inspectMathlibBuildAuthority({
          environment,
          formalProjectClosureHash: postProbeClosure?.formalProjectClosureHash || null,
          productionMathlibReleaseIdentityHash:
            postProbeMathlibReleaseIdentity?.productionMathlibReleaseIdentityHash || null,
          trustedClosureHashes: trustedMathlibBuildClosureHashes,
          observedAt: postProbeBuildAuthorityObservedAt,
        });
      } catch (error) {
        blockers.push(
          `dynamic_formal_mathlib_build_authority_configuration_invalid:${String(
            error?.message || error,
          )}`,
        );
      }
      if (!postProbeMathlibBuildAuthority
        || !verifyProductionMathlibBuildAuthority(postProbeMathlibBuildAuthority, {
          trustedClosureHashes: trustedMathlibBuildClosureHashes,
          observedAt: postProbeBuildAuthorityObservedAt,
          expectedConfigurationHash: String(environment?.[
            PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIGURATION_HASH_ENV
          ] || '').trim().toLowerCase() || null,
        }) || JSON.stringify(postProbeMathlibBuildAuthority)
          !== JSON.stringify(productionMathlibBuildAuthority)) {
        blockers.push('dynamic_formal_mathlib_build_authority_changed_during_probe');
      }
    }
    if (blockers.length) return blocked(blockers, details);

    const payload = {
      version: 1,
      kind: 'DynamicFormalProjectClosureReadiness',
      status: 'dynamic_formal_project_closure_ready',
      ready: true,
      imports: Object.freeze(['Mathlib']),
      toolchain: PRODUCTION_LEAN_TOOLCHAIN,
      projectRoot,
      projectScopeRoot,
      probeRelativePath,
      formalProjectClosureHash: closure.formalProjectClosureHash,
      formalProjectManifestHash: closure.manifestHash,
      toolchainRootMerkleHash: toolchainIdentity.toolchainRootMerkleHash,
      toolchainContentIdentityHash: toolchainIdentity.leanToolchainContentIdentityHash,
      mathlibPackageSourcePath: details.mathlibPackageSourcePath,
      productionMathlibReleaseIdentity:
        details.productionMathlibReleaseIdentity,
      productionMathlibReleaseIdentityHash:
        details.productionMathlibReleaseIdentityHash,
      productionMathlibBuildAuthority:
        details.productionMathlibBuildAuthority,
      productionMathlibBuildAuthorityHash:
        details.productionMathlibBuildAuthorityHash,
      formalSandboxRuntimeConfigurationHash:
        details.formalSandboxRuntimeConfigurationHash,
      formalSandboxRuntimeImage: details.formalSandboxRuntimeImage,
      formalSandboxRuntimeImageDigest: details.formalSandboxRuntimeImageDigest,
      formalSandboxProbeReceiptHash: details.formalSandboxProbeReceiptHash,
      formalSandboxProbeRuntimeIdentityHash:
        details.formalSandboxProbeRuntimeIdentityHash,
      formalSandboxProbeExecutionProcessIdentityHash:
        details.formalSandboxProbeExecutionProcessIdentityHash,
      formalSandboxProbeSnapshotSealReceipt:
        details.formalSandboxProbeSnapshotSealReceipt,
      formalSandboxProbeSnapshotSealReceiptHash:
        details.formalSandboxProbeSnapshotSealReceiptHash,
      executableProbeVerified: true,
      postProbeReinspectionVerified: true,
      blockers: Object.freeze([]),
    };
    const readiness = Object.freeze({
      ...payload,
      dynamicFormalProjectClosureReadinessHash: hashRecord(
        'DynamicFormalProjectClosureReadiness', payload,
      ),
    });
    if (!activeProbeRequested
      && readiness.dynamicFormalProjectClosureReadinessHash
        !== cachedProbeReadiness?.dynamicFormalProjectClosureReadinessHash) {
      return blocked([
        'dynamic_formal_sandbox_probe_qualification_readiness_mismatch',
      ], details);
    }
    if (activeProbeRequested && publishActiveProbeReceipt === true) {
      if (!qualificationRepository) {
        return blocked([
          'dynamic_formal_sandbox_probe_qualification_repository_required',
        ], details);
      }
      qualificationRepository.publish(readiness);
    }
    return readiness;
  } catch (error) {
    return blocked([
      ...blockers,
      `dynamic_formal_project_inspection_failed:${String(error?.message || error)}`,
    ], details);
  }
}

export function inspectConfiguredDynamicFormalExecutionAuthority(options = {}) {
  const inspection = inspectConfiguredDynamicFormalProjectClosure(options);
  let authority = null;
  try { authority = buildDynamicFormalExecutionAuthority(inspection); }
  catch { /* blocked inspection is returned as evidence */ }
  return Object.freeze({ inspection, authority });
}

export function assertCurrentDynamicFormalExecutionAuthority(expected, options = {}) {
  if (!verifyDynamicFormalExecutionAuthority(expected)) {
    throw new Error('dynamic_formal_execution_authority_required');
  }
  const current = inspectConfiguredDynamicFormalExecutionAuthority(options);
  if (!current.authority
    || JSON.stringify(current.authority) !== JSON.stringify(expected)) {
    throw new Error('dynamic_formal_execution_authority_drift');
  }
  return current;
}
