import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHANNEL_IMPORT_ALLOWLIST_TARGETS } from './channel-import-allowlist.mjs';
import { digest } from './hash-utils.mjs';

export const PACKAGE_ROOT_RESOLVER_VERSION = 1;

export const PACKAGE_ROOT_RESOLVER_STABLE_MODULE_ID = 'package-root-resolver';

export const PACKAGE_ROOT_RESOLVER_REPORT_FILE_ID = 'package-root-resolver-latest.json';

export const PACKAGE_ROOT_RESOLVER_SPECIFIER = 'design-production-core';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(packageRoot, '..');

function relative(filePath) {
  return path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function modulesFromIndexExport(exportName) {
  const indexText = readText(path.join(packageRoot, 'src', 'index.mjs'));
  const match = indexText.match(new RegExp(`${exportName}\\s*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\);`));
  if (!match) return [];
  const modules = [];
  const itemRegex = /'([^']+)'/g;
  let item = itemRegex.exec(match[1]);
  while (item) {
    modules.push(item[1]);
    item = itemRegex.exec(match[1]);
  }
  return modules;
}

function existingChannelRoot(target) {
  return (target.roots || [])
    .map((root) => ({
      path: root,
      absolutePath: path.join(workspaceRoot, root),
      exists: fs.existsSync(path.join(workspaceRoot, root)),
    }))
    .find((root) => root.exists) || null;
}

function realpath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function buildPackageLink() {
  const linkPath = path.join(workspaceRoot, 'node_modules', PACKAGE_ROOT_RESOLVER_SPECIFIER);
  let lstat = null;
  try {
    lstat = fs.lstatSync(linkPath);
  } catch {
    lstat = null;
  }
  const exists = Boolean(lstat);
  const isSymlink = Boolean(lstat?.isSymbolicLink());
  const rawTarget = isSymlink ? fs.readlinkSync(linkPath) : null;
  const resolvedTarget = exists
    ? realpath(linkPath)
    : null;
  const expectedTarget = realpath(packageRoot) || packageRoot;
  const resolvesToPackageRoot = Boolean(resolvedTarget && expectedTarget && resolvedTarget === expectedTarget);
  return {
    path: relative(linkPath),
    exists,
    isSymlink,
    rawTarget,
    resolvedTarget: resolvedTarget ? relative(resolvedTarget) : null,
    expectedTarget: relative(expectedTarget),
    resolvesToPackageRoot,
    status: resolvesToPackageRoot
      ? 'pass_package_root_workspace_link'
      : exists
        ? 'blocked_package_root_workspace_link_wrong_target'
        : 'blocked_package_root_workspace_link_missing',
  };
}

function runResolverProbe(cwd) {
  const script = `
const result = {};
try {
  const module = await import('${PACKAGE_ROOT_RESOLVER_SPECIFIER}');
  result.rootImport = {
    ok: true,
    errorCode: null,
    errorMessage: null,
    publicModuleCount: Array.isArray(module.CORE_PUBLIC_MODULES) ? module.CORE_PUBLIC_MODULES.length : null,
    compatibilityModuleCount: Array.isArray(module.CORE_COMPATIBILITY_MODULES) ? module.CORE_COMPATIBILITY_MODULES.length : null,
    zeroCompatibilityInvariant: module.publicApiSummary?.().stability?.zeroCompatibilityInvariant === true
  };
} catch (error) {
  result.rootImport = {
    ok: false,
    errorCode: error?.code || error?.name || null,
    errorMessage: error?.message || String(error),
    publicModuleCount: null,
    compatibilityModuleCount: null,
    zeroCompatibilityInvariant: false
  };
}
try {
  await import('${PACKAGE_ROOT_RESOLVER_SPECIFIER}/src/index.mjs');
  result.deepImport = {
    ok: true,
    errorCode: null,
    errorMessage: null
  };
} catch (error) {
  result.deepImport = {
    ok: false,
    errorCode: error?.code || error?.name || null,
    errorMessage: error?.message || String(error)
  };
}
console.log(JSON.stringify(result));
if (!result.rootImport.ok || result.deepImport.errorCode !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') process.exit(1);
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return {
    exitCode: result.status,
    signal: result.signal || null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output: parseJson((result.stdout || '').trim()) || {},
    spawnError: result.error ? result.error.message : null,
  };
}

function fixtureProbeResult(target, probeResultsByChannel = {}) {
  if (!probeResultsByChannel) return null;
  const probe = probeResultsByChannel[target.channelId];
  if (!probe) return null;
  return {
    channelId: target.channelId,
    label: target.label,
    cwd: probe.cwd || `${target.roots?.[0] || target.channelId}`,
    rootImport: {
      ok: probe.rootImport?.ok === true,
      errorCode: probe.rootImport?.errorCode || null,
      errorMessage: probe.rootImport?.errorMessage || null,
      publicModuleCount: probe.rootImport?.publicModuleCount ?? null,
      compatibilityModuleCount: probe.rootImport?.compatibilityModuleCount ?? null,
      zeroCompatibilityInvariant: probe.rootImport?.zeroCompatibilityInvariant === true,
    },
    deepImport: {
      ok: probe.deepImport?.ok === true,
      errorCode: probe.deepImport?.errorCode || null,
      errorMessage: probe.deepImport?.errorMessage || null,
    },
    exitCode: probe.exitCode ?? (probe.rootImport?.ok === true ? 0 : 1),
    signal: probe.signal || null,
    spawnError: null,
    fixture: true,
  };
}

function normalizeProbe({ target, probe, expectedPublicModuleCount, packageLink }) {
  const blockers = [
    ...(!packageLink.resolvesToPackageRoot ? [{
      code: 'package_root_workspace_link_not_ready',
      notes: `${packageLink.path} must resolve to ${packageLink.expectedTarget}.`,
    }] : []),
    ...(!probe.rootImport.ok ? [{
      code: 'channel_package_root_import_failed',
      notes: `${target.channelId} cannot import ${PACKAGE_ROOT_RESOLVER_SPECIFIER}: ${probe.rootImport.errorCode || probe.rootImport.errorMessage || 'unknown error'}.`,
    }] : []),
    ...(probe.rootImport.ok && probe.rootImport.publicModuleCount !== expectedPublicModuleCount ? [{
      code: 'channel_package_root_public_module_count_mismatch',
      notes: `${target.channelId} resolved ${probe.rootImport.publicModuleCount} public modules, expected ${expectedPublicModuleCount}.`,
    }] : []),
    ...(probe.rootImport.ok && probe.rootImport.compatibilityModuleCount !== 0 ? [{
      code: 'channel_package_root_compatibility_modules_present',
      notes: `${target.channelId} resolved ${probe.rootImport.compatibilityModuleCount} compatibility modules from the package root.`,
    }] : []),
    ...(probe.rootImport.ok && probe.rootImport.zeroCompatibilityInvariant !== true ? [{
      code: 'channel_package_root_zero_compatibility_invariant_missing',
      notes: `${target.channelId} package root import did not expose zeroCompatibilityInvariant=true.`,
    }] : []),
    ...(probe.deepImport.errorCode !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' ? [{
      code: 'channel_package_deep_src_import_not_blocked',
      notes: `${target.channelId} deep package import should fail with ERR_PACKAGE_PATH_NOT_EXPORTED, got ${probe.deepImport.ok ? 'import_ok' : probe.deepImport.errorCode || 'unknown_error'}.`,
    }] : []),
  ];
  return {
    channelId: target.channelId,
    label: target.label,
    status: blockers.length ? 'blocked_package_root_resolver' : 'pass_package_root_resolver',
    ok: blockers.length === 0,
    cwd: probe.cwd,
    rootImport: probe.rootImport,
    deepImport: probe.deepImport,
    exitCode: probe.exitCode,
    signal: probe.signal,
    spawnError: probe.spawnError,
    fixture: probe.fixture === true,
    blockers,
  };
}

function probeTarget({ target, expectedPublicModuleCount, packageLink, probeResultsByChannel }) {
  const fixture = fixtureProbeResult(target, probeResultsByChannel);
  if (fixture) {
    return normalizeProbe({
      target,
      probe: fixture,
      expectedPublicModuleCount,
      packageLink,
    });
  }
  const root = existingChannelRoot(target);
  if (!root) {
    return {
      channelId: target.channelId,
      label: target.label,
      status: 'blocked_package_root_resolver_no_channel_root',
      ok: false,
      cwd: null,
      rootImport: {
        ok: false,
        errorCode: 'CHANNEL_ROOT_MISSING',
        errorMessage: 'No existing channel root was available for package root resolver probe.',
        publicModuleCount: null,
        compatibilityModuleCount: null,
        zeroCompatibilityInvariant: false,
      },
      deepImport: {
        ok: false,
        errorCode: 'CHANNEL_ROOT_MISSING',
        errorMessage: 'No existing channel root was available for package root resolver probe.',
      },
      exitCode: null,
      signal: null,
      spawnError: null,
      fixture: false,
      blockers: [{
        code: 'channel_root_missing',
        notes: `${target.channelId} has no existing runtime root for package root resolver probe.`,
      }],
    };
  }
  const rawProbe = runResolverProbe(root.absolutePath);
  const output = rawProbe.output || {};
  return normalizeProbe({
    target,
    expectedPublicModuleCount,
    packageLink,
    probe: {
      channelId: target.channelId,
      label: target.label,
      cwd: relative(root.absolutePath),
      rootImport: {
        ok: output.rootImport?.ok === true,
        errorCode: output.rootImport?.errorCode || null,
        errorMessage: output.rootImport?.errorMessage || null,
        publicModuleCount: output.rootImport?.publicModuleCount ?? null,
        compatibilityModuleCount: output.rootImport?.compatibilityModuleCount ?? null,
        zeroCompatibilityInvariant: output.rootImport?.zeroCompatibilityInvariant === true,
      },
      deepImport: {
        ok: output.deepImport?.ok === true,
        errorCode: output.deepImport?.errorCode || null,
        errorMessage: output.deepImport?.errorMessage || null,
      },
      exitCode: rawProbe.exitCode,
      signal: rawProbe.signal,
      spawnError: rawProbe.spawnError,
      fixture: false,
    },
  });
}

export function buildPackageRootResolverReport({
  channelTargets = CHANNEL_IMPORT_ALLOWLIST_TARGETS,
  packageLink = buildPackageLink(),
  probeResultsByChannel = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const publicModules = modulesFromIndexExport('CORE_PUBLIC_MODULES');
  const compatibilityModules = modulesFromIndexExport('CORE_COMPATIBILITY_MODULES');
  const channels = channelTargets.map((target) => probeTarget({
    target,
    expectedPublicModuleCount: publicModules.length,
    packageLink,
    probeResultsByChannel,
  }));
  const blockers = [
    ...(!packageLink.resolvesToPackageRoot ? [{
      code: 'package_root_workspace_link_not_ready',
      notes: `${packageLink.path} must resolve to ${packageLink.expectedTarget}.`,
    }] : []),
    ...channels.flatMap((channel) => channel.blockers.map((item) => ({
      code: `${channel.channelId}_${item.code}`,
      notes: item.notes,
      channelId: channel.channelId,
      cwd: channel.cwd,
    }))),
  ];
  const report = {
    version: PACKAGE_ROOT_RESOLVER_VERSION,
    kind: 'PackageRootResolverReport',
    status: blockers.length ? 'blocked_package_root_resolver' : 'pass_package_root_resolver',
    ok: blockers.length === 0,
    generatedAt,
    packageName: PACKAGE_ROOT_RESOLVER_SPECIFIER,
    packageRoot: relative(packageRoot),
    expectedPublicModuleCount: publicModules.length,
    expectedCompatibilityModuleCount: compatibilityModules.length,
    packageLink,
    channels,
    summary: {
      channelCount: channels.length,
      resolverReadyChannels: channels.filter((channel) => channel.ok).length,
      packageLinkReady: packageLink.resolvesToPackageRoot === true,
      rootImportReadyChannels: channels.filter((channel) => channel.rootImport.ok).length,
      deepImportBlockedChannels: channels.filter((channel) => channel.deepImport.errorCode === 'ERR_PACKAGE_PATH_NOT_EXPORTED').length,
      zeroCompatibilityChannels: channels.filter((channel) => channel.rootImport.compatibilityModuleCount === 0).length,
      zeroCompatibilityInvariantChannels: channels.filter((channel) => channel.rootImport.zeroCompatibilityInvariant === true).length,
      blockerCount: blockers.length,
    },
    blockers,
    safety: {
      localOnly: true,
      readOnly: true,
      executesExternalAction: false,
      providerSpend: false,
      browserAutomation: false,
      upload: false,
      submit: false,
      messaging: false,
      payment: false,
      acceptance: false,
      deployment: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      grantsExecutionPermission: false,
    },
  };
  const resolverHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    packageName: report.packageName,
    packageRoot: report.packageRoot,
    expectedPublicModuleCount: report.expectedPublicModuleCount,
    expectedCompatibilityModuleCount: report.expectedCompatibilityModuleCount,
    packageLink: report.packageLink,
    channels: report.channels.map((channel) => ({
      channelId: channel.channelId,
      status: channel.status,
      ok: channel.ok,
      cwd: channel.cwd,
      rootImport: channel.rootImport,
      deepImport: {
        ok: channel.deepImport.ok,
        errorCode: channel.deepImport.errorCode,
      },
      blockers: channel.blockers,
    })),
    summary: report.summary,
    blockers: report.blockers,
    safety: report.safety,
  });
  return {
    ...report,
    resolverHash,
    hash: resolverHash,
  };
}

export function summarizePackageRootResolverReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_package_root_resolver_report',
    ok: report?.ok === true,
    resolverHash: report?.resolverHash || null,
    packageName: report?.packageName || PACKAGE_ROOT_RESOLVER_SPECIFIER,
    channelCount: report?.summary?.channelCount || 0,
    resolverReadyChannels: report?.summary?.resolverReadyChannels || 0,
    packageLinkReady: report?.summary?.packageLinkReady === true,
    rootImportReadyChannels: report?.summary?.rootImportReadyChannels || 0,
    deepImportBlockedChannels: report?.summary?.deepImportBlockedChannels || 0,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: report?.safety?.localOnly === true,
      readOnly: report?.safety?.readOnly === true,
      executesExternalAction: report?.safety?.executesExternalAction === true,
    },
  };
}
