import path from 'node:path';

import {
  executeAutonomousResearchOnlineSchemaTransition,
  planAutonomousResearchOnlineSchemaTransition,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import { readRegularJsonFileSync } from '../../paper-adapters/runtime/pinned-file-reader.mjs';

export function composeAutonomousResearchOnlineSchemaTransitionService({
  workspaceRoot,
  runtimeRoot,
  authorityProcessConfigurationPath,
  clock = { now: () => new Date() },
  createAuthorityClient,
} = {}) {
  if (!workspaceRoot || !runtimeRoot || !authorityProcessConfigurationPath) {
    throw new Error('autonomous_research_online_schema_transition_composition_prerequisites_missing');
  }
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const resolvedAuthorityProcessConfigurationPath = path.resolve(
    authorityProcessConfigurationPath,
  );
  const manifestPath = path.join(
    path.resolve(workspaceRoot),
    'paper-core',
    'config',
    'autonomous-research-state-databases.v1.json',
  );
  const stateDatabaseManifest = readRegularJsonFileSync(manifestPath);
  const shared = Object.freeze({
    runtimeRoot: resolvedRuntimeRoot,
    stateDatabaseManifest,
    writerManifest: AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
    authorityProcessConfigurationPath: resolvedAuthorityProcessConfigurationPath,
    clock,
    ...(createAuthorityClient ? { createAuthorityClient } : {}),
  });
  return Object.freeze({
    plan({ requestedLeaseMs, requiredExecutionWindowMs } = {}) {
      return planAutonomousResearchOnlineSchemaTransition({
        ...shared,
        ...(requestedLeaseMs === undefined ? {} : { requestedLeaseMs }),
        ...(requiredExecutionWindowMs === undefined
          ? {} : { requiredExecutionWindowMs }),
      });
    },
    execute({
      expectedTransitionId,
      requestedLeaseMs,
      requiredExecutionWindowMs,
      commitSafetyMarginMs,
    } = {}) {
      return executeAutonomousResearchOnlineSchemaTransition({
        ...shared,
        expectedTransitionId,
        ...(requestedLeaseMs === undefined ? {} : { requestedLeaseMs }),
        ...(requiredExecutionWindowMs === undefined
          ? {} : { requiredExecutionWindowMs }),
        ...(commitSafetyMarginMs === undefined ? {} : { commitSafetyMarginMs }),
      });
    },
    manifestPath,
    runtimeRoot: resolvedRuntimeRoot,
    authorityProcessConfigurationPath: resolvedAuthorityProcessConfigurationPath,
  });
}
