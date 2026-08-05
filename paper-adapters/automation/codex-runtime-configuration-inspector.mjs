import fs from 'node:fs';
import path from 'node:path';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  openClawModelRuntimeProvenance,
} from './codex-openclaw-managed-configuration.mjs';
import {
  DEFAULT_MAXIMUM_CONTEXT_BYTES,
  DEFAULT_MAXIMUM_FILE_COUNT,
} from './codex-openclaw-managed-runtime-common.mjs';

function fail(prefix, suffix) {
  const error = new Error(`${prefix}_${suffix}`);
  error.retryable = false;
  throw error;
}

function configuredModel(source, prefix) {
  const topLevel = String(source || '').split(/^\s*\[/m, 1)[0];
  const match = topLevel.match(/^\s*model\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/m);
  if (!match) fail(prefix, 'model_required_in_config');
  let model;
  try {
    model = match[1].startsWith('"')
      ? JSON.parse(match[1])
      : match[1].slice(1, -1);
  } catch {
    fail(prefix, 'model_invalid_in_config');
  }
  const selected = String(model || '').trim();
  if (!selected) fail(prefix, 'model_invalid_in_config');
  return selected;
}

function managedOpenClawRuntimeConfiguration(source, prefix) {
  const text = String(source || '');
  const header = /^\s*\[hepta_openclaw_managed\]\s*$/m.exec(text);
  if (!header) {
    return Object.freeze({
      requested: false,
      agentId: null,
      principalRole: null,
      maximumContextBytes: null,
      maximumFileCount: null,
      openClawManagedAuthBindingMode: null,
      openClawManagedAuthProfileIdentityHash: null,
      openClawManagedGatewayRouteIdentityHash: null,
      openClawManagedAuthSourceIdentityHash: null,
    });
  }
  const remainder = text.slice(header.index + header[0].length);
  const nextSectionIndex = remainder.search(/^\s*\[[A-Za-z0-9_.-]+\]\s*$/m);
  const section = nextSectionIndex < 0
    ? remainder : remainder.slice(0, nextSectionIndex);
  if (!/^\s*version\s*=\s*4\s*(?:#.*)?$/m.test(section)
    || !/^\s*managed_auth\s*=\s*true\s*(?:#.*)?$/m.test(section)) {
    fail(prefix, 'openclaw_managed_config_invalid');
  }
  const managedString = (name) => {
    const match = section.match(new RegExp(
      `^\\s*${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*(?:#.*)?$`,
      'm',
    ));
    try {
      return match?.[1]?.startsWith('"')
        ? JSON.parse(match[1]) : match?.[1]?.slice(1, -1);
    } catch {
      fail(prefix, 'openclaw_managed_config_invalid');
    }
    return null;
  };
  const gatewayTransport = /^\s*gateway_transport\s*=\s*true\s*(?:#.*)?$/m.test(section);
  const authBindingMode = managedString('auth_binding_mode') || (gatewayTransport
    ? 'current-agent-gateway-oauth' : 'user-locked');
  const authProfileId = managedString('auth_profile_id') ?? null;
  const agentId = managedString('agent_id');
  const principalRole = managedString('principal_role');
  const openclawBinary = managedString('openclaw_binary');
  const openclawConfigPath = managedString('openclaw_config_path');
  const openclawStateDir = managedString('openclaw_state_dir');
  const managedInteger = (name, fallback) => {
    const match = section.match(new RegExp(
      `^\\s*${name}\\s*=\\s*([0-9]+)\\s*(?:#.*)?$`,
      'm',
    ));
    return match ? Number(match[1]) : fallback;
  };
  const maximumContextBytes = managedInteger(
    'maximum_context_bytes',
    DEFAULT_MAXIMUM_CONTEXT_BYTES,
  );
  const maximumFileCount = managedInteger(
    'maximum_file_count',
    DEFAULT_MAXIMUM_FILE_COUNT,
  );
  if ((gatewayTransport
    ? (authBindingMode !== 'current-agent-gateway-oauth'
      || authProfileId !== null)
    : (authBindingMode !== 'user-locked'
      || !/^openai:[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,247}$/.test(
        String(authProfileId || ''),
      )))
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(String(agentId || ''))
    || !['research-author', 'formal-reviewer'].includes(principalRole)
    || !path.isAbsolute(String(openclawBinary || ''))
    || !path.isAbsolute(String(openclawConfigPath || ''))
    || !path.isAbsolute(String(openclawStateDir || ''))
    || path.resolve(openclawConfigPath) !== openclawConfigPath
    || path.resolve(openclawStateDir) !== openclawStateDir
    || path.dirname(openclawConfigPath) !== openclawStateDir
    || !Number.isInteger(maximumContextBytes)
    || maximumContextBytes < 4096
    || maximumContextBytes > 4 * 1024 * 1024
    || !Number.isInteger(maximumFileCount)
    || maximumFileCount < 1
    || maximumFileCount > 256) {
    fail(prefix, 'openclaw_managed_config_invalid');
  }
  let runtimeProvenance;
  let gatewayRouteIdentityHash = null;
  try {
    const resolvedOpenClawBinary = fs.realpathSync(openclawBinary);
    const binaryStat = fs.statSync(resolvedOpenClawBinary);
    fs.accessSync(resolvedOpenClawBinary, fs.constants.X_OK);
    if (!binaryStat.isFile()) throw new Error('runtime binary is not a file');
    runtimeProvenance = openClawModelRuntimeProvenance(
      resolvedOpenClawBinary,
    );
    if (gatewayTransport) {
      gatewayRouteIdentityHash = hashRecord(
        'OpenClawManagedGatewayRouteIdentity',
        {
          version: 1,
          agentId,
          authBindingMode: 'current-agent-gateway-oauth-route',
          openclawConfigPathHash: hashBytes(openclawConfigPath),
          openclawConfigContentHash:
            hashBytes(fs.readFileSync(openclawConfigPath)),
          openclawStateDirPathHash: hashBytes(openclawStateDir),
          transport: 'openclaw-gateway-runtime-direct-rpc',
        },
      );
    }
  } catch {
    fail(prefix, 'openclaw_managed_runtime_provenance_invalid');
  }
  return Object.freeze({
    requested: true,
    agentId,
    principalRole,
    maximumContextBytes,
    maximumFileCount,
    gatewayTransport,
    openClawManagedAuthBindingMode: gatewayTransport
      ? 'current-agent-gateway-oauth-route' : 'user-locked-profile',
    openClawManagedRuntimeProvenanceHash:
      runtimeProvenance.openClawManagedRuntimeProvenanceHash,
    openClawManagedAuthProfileIdentityHash: gatewayTransport ? null
      : hashRecord('OpenClawManagedAuthProfileIdentity', {
        provider: 'openai', authProfileId,
      }),
    openClawManagedGatewayRouteIdentityHash: gatewayRouteIdentityHash,
    openClawManagedAuthSourceIdentityHash:
      hashRecord('OpenClawManagedAuthSourceIdentity', {
        agentId,
        openclawConfigPath,
        openclawStateDir,
      }),
  });
}

export function inspectCodexRuntimeConfiguration({
  source,
  errorPrefix,
  explicitModel = '',
} = {}) {
  const managedConfiguration = managedOpenClawRuntimeConfiguration(
    source,
    errorPrefix,
  );
  const selectedModel = explicitModel || configuredModel(source, errorPrefix);
  const managedOpenClawRuntime = managedConfiguration.requested;
  return Object.freeze({
    managedConfiguration,
    managedOpenClawRuntime,
    model: managedOpenClawRuntime
      ? String(selectedModel).replace(/^openai\//, '') : selectedModel,
    modelSelectionSource: managedConfiguration.gatewayTransport
      ? 'openclaw_agent_default_verified'
      : explicitModel ? 'explicit_override' : 'codex_home_config',
  });
}
