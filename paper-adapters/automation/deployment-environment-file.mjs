import fs from 'node:fs';
import path from 'node:path';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const AUTOMATION_READINESS_DEPLOYMENT_ENVIRONMENT_KEYS = Object.freeze([
  'ELAN_HOME',
  'HEPTA_ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_REGISTRY',
  'HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG',
  'HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE',
  'HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT',
  'HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG',
  'HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG',
  'HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG',
  'HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG',
  'HEPTA_AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_PROFILE',
  'HEPTA_AUTONOMOUS_SUBMISSION_HANDOFF_MUTATION_AUTHORITY_PROCESS_CONFIG',
  'HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG',
  'HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG_HASH',
  'HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH',
  'HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG',
  'HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG',
  'HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG_HASH',
  'HEPTA_DYNAMIC_FORMAL_CLAIMS_ENABLED',
  'HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH',
  'HEPTA_DYNAMIC_FORMAL_PROJECT_PROBE',
  'HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT',
  'HEPTA_DYNAMIC_FORMAL_PROJECT_SCOPE_ROOT',
  'HEPTA_EXTERNAL_REPLAY_CONFIG',
  'HEPTA_FORMAL_REVIEW_CODEX_HOME',
  'HEPTA_FORMAL_REVIEW_MODEL',
  'HEPTA_FORMAL_REVIEWER_MAXIMUM_COST_PER_CALL_USD',
  'HEPTA_PAPER_ASSET_ROOT',
  'HEPTA_PAPER_RUNTIME_ROOT',
  'HEPTA_PRIOR_ART_SERVICE_CONFIG',
  'HEPTA_RESEARCH_AUTHOR_CODEX_HOME',
  'HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG',
  'HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH',
  'HEPTA_RESEARCH_AUTHOR_MAXIMUM_COST_PER_CALL_USD',
  'HEPTA_RESEARCH_AUTHOR_MODEL',
  'HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG',
  'HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG',
  'HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG',
  'HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_MAXIMUM_REFRESH_ATTEMPTS_PER_EPOCH',
  'HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_MAXIMUM_REFRESH_COST_USD_PER_EPOCH',
  'HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_REFRESH_ACTION_SAFETY_MARGIN_MS',
  'HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_REFRESH_RENEWAL_LEAD_MS',
  'HEPTA_SUPERVISOR_INSTANCE_HEARTBEAT_MS',
  'HEPTA_SUPERVISOR_INSTANCE_LEASE_MS',
  'HEPTA_SUPERVISOR_MAXIMUM_DISPATCHES',
  'HEPTA_SUPERVISOR_MAXIMUM_LIFECYCLE_COST_USD',
  'HEPTA_SUPERVISOR_MAXIMUM_LIFETIME_MS',
  'HEPTA_SUPERVISOR_POLL_MS',
  'HEPTA_SUPERVISOR_QUALIFICATION_ACTION_SAFETY_MARGIN_MS',
]);

const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const allowedKeys = new Set(AUTOMATION_READINESS_DEPLOYMENT_ENVIRONMENT_KEYS);

function decodeValue(source, lineNumber) {
  const value = source.trim();
  if (!value.length) return '';
  const quote = value[0];
  if (quote === "'" || quote === '"') {
    if (value.at(-1) !== quote || value.length < 2) {
      throw new Error(`deployment_environment_value_quote_invalid:${lineNumber}`);
    }
    const inner = value.slice(1, -1);
    if (quote === "'" && inner.includes("'")) {
      throw new Error(`deployment_environment_single_quote_invalid:${lineNumber}`);
    }
    if (quote === '"') {
      return inner.replace(/\\(["\\])/g, '$1');
    }
    return inner;
  }
  if (/\s/.test(value) || value.includes('#')) {
    throw new Error(`deployment_environment_unquoted_value_invalid:${lineNumber}`);
  }
  return value;
}

function parseDeploymentEnvironmentFile(content) {
  const entries = {};
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) {
      throw new Error(`deployment_environment_assignment_invalid:${lineNumber}`);
    }
    const key = line.slice(0, separator).trim();
    if (!KEY_PATTERN.test(key) || !allowedKeys.has(key)) {
      throw new Error(`deployment_environment_key_not_allowlisted:${lineNumber}:${key}`);
    }
    if (Object.hasOwn(entries, key)) {
      throw new Error(`deployment_environment_key_duplicate:${lineNumber}:${key}`);
    }
    entries[key] = decodeValue(line.slice(separator + 1), lineNumber);
  }
  return Object.freeze(entries);
}

function inspectFile(filePath) {
  const resolved = path.resolve(filePath);
  if (resolved !== filePath) {
    throw new Error('deployment_environment_file_absolute_path_required');
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('deployment_environment_file_regular_file_required');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('deployment_environment_file_permissions_too_broad');
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (stat.uid !== 0 && stat.uid !== currentUid) {
    throw new Error('deployment_environment_file_owner_invalid');
  }
  const bytes = fs.readFileSync(resolved);
  return Object.freeze({
    resolved,
    bytes,
    entries: parseDeploymentEnvironmentFile(bytes.toString('utf8')),
  });
}

export function loadAutomationReadinessDeploymentEnvironment({
  baseEnvironment = process.env,
  filePath = null,
} = {}) {
  if (!filePath) {
    const payload = {
      version: 1,
      kind: 'AutomationReadinessDeploymentEnvironmentInspection',
      status: 'automation_readiness_ambient_environment_observed',
      source: 'ambient-process-environment',
      filePath: null,
      fileHash: null,
      loadedKeys: Object.freeze([]),
      credentialMaterialLoaded: false,
    };
    return Object.freeze({
      environment: Object.freeze({ ...baseEnvironment }),
      inspection: Object.freeze({
        ...payload,
        automationReadinessDeploymentEnvironmentInspectionHash: hashRecord(
          'AutomationReadinessDeploymentEnvironmentInspection',
          payload,
        ),
      }),
    });
  }
  const observed = inspectFile(filePath);
  const loadedKeys = Object.freeze(Object.keys(observed.entries).sort());
  const payload = {
    version: 1,
    kind: 'AutomationReadinessDeploymentEnvironmentInspection',
    status: 'automation_readiness_deployment_environment_loaded',
    source: 'explicit-owner-private-environment-file',
    filePath: observed.resolved,
    fileHash: hashBytes(observed.bytes),
    loadedKeys,
    credentialMaterialLoaded: false,
  };
  return Object.freeze({
    environment: Object.freeze({ ...baseEnvironment, ...observed.entries }),
    inspection: Object.freeze({
      ...payload,
      automationReadinessDeploymentEnvironmentInspectionHash: hashRecord(
        'AutomationReadinessDeploymentEnvironmentInspection',
        payload,
      ),
    }),
  });
}
