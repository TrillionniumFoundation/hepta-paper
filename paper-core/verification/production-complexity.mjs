import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'espree';

import { inspectTrackedProductionGraph } from './tracked-production-graph.mjs';

const thisFile = fileURLToPath(import.meta.url);
const defaultWorkspaceRoot = path.resolve(path.dirname(thisFile), '..', '..');

export const PRODUCTION_COMPLEXITY_LAYER_POLICIES = Object.freeze([
  Object.freeze({
    id: 'adapters',
    pathPrefix: 'paper-adapters/',
    ceilings: Object.freeze({
      sourceLines: 800,
      dependencyFanout: 22,
      publicExports: 30,
      responsibilitySurface: 32,
      controlFlowPoints: 340,
    }),
  }),
  Object.freeze({
    id: 'application',
    pathPrefix: 'paper-application/',
    ceilings: Object.freeze({
      sourceLines: 720,
      dependencyFanout: 20,
      publicExports: 24,
      responsibilitySurface: 28,
      controlFlowPoints: 240,
    }),
  }),
  Object.freeze({
    id: 'composition',
    pathPrefix: 'paper-composition/',
    ceilings: Object.freeze({
      sourceLines: 740,
      dependencyFanout: 24,
      publicExports: 24,
      responsibilitySurface: 36,
      controlFlowPoints: 300,
    }),
  }),
  Object.freeze({
    id: 'operator',
    pathPrefix: 'paper-core/bin/',
    ceilings: Object.freeze({
      sourceLines: 360,
      dependencyFanout: 12,
      publicExports: 8,
      responsibilitySurface: 16,
      controlFlowPoints: 100,
    }),
  }),
  Object.freeze({
    id: 'core',
    pathPrefix: 'paper-core/src/',
    ceilings: Object.freeze({
      sourceLines: 640,
      dependencyFanout: 6,
      publicExports: 8,
      responsibilitySurface: 12,
      controlFlowPoints: 50,
    }),
  }),
  Object.freeze({
    id: 'domain',
    pathPrefix: 'paper-domain/',
    ceilings: Object.freeze({
      sourceLines: 800,
      dependencyFanout: 24,
      publicExports: 48,
      responsibilitySurface: 60,
      controlFlowPoints: 420,
    }),
  }),
  Object.freeze({
    id: 'ports',
    pathPrefix: 'paper-ports/',
    ceilings: Object.freeze({
      sourceLines: 160,
      dependencyFanout: 8,
      publicExports: 20,
      responsibilitySurface: 24,
      controlFlowPoints: 60,
    }),
  }),
  Object.freeze({
    id: 'kernel',
    pathPrefix: 'workflow-kernel/',
    ceilings: Object.freeze({
      sourceLines: 220,
      dependencyFanout: 6,
      publicExports: 18,
      responsibilitySurface: 22,
      controlFlowPoints: 100,
    }),
  }),
]);

// Payload exclusions are path-declared. Content shape, filename fragments such
// as "registry", and current size never grant an implicit complexity waiver.
export const PRODUCTION_COMPLEXITY_PAYLOAD_EXCLUSIONS = Object.freeze([
  Object.freeze({
    id: 'versioned-journal-profile-dataset',
    path: 'paper-domain/journal/data/journal-profiles.v1.data.mjs',
  }),
]);

export const PRODUCTION_COMPLEXITY_PATH_CEILING_OVERRIDES = Object.freeze({
  'paper-adapters/empirical-analysis/index.mjs': Object.freeze({ sourceLines: 400 }),
  'paper-adapters/journal-manage/index.mjs': Object.freeze({ sourceLines: 400 }),
  'paper-adapters/referee-revise/index.mjs': Object.freeze({ sourceLines: 400 }),
  'paper-adapters/proposal/index.mjs': Object.freeze({ sourceLines: 400 }),
  'paper-adapters/automation/workspace-attempt-repository.mjs':
    Object.freeze({ sourceLines: 450 }),
  'paper-adapters/automation/runtime-retention.mjs':
    Object.freeze({ sourceLines: 250 }),
  'paper-application/automation/autonomous-research-campaign.mjs':
    Object.freeze({
      sourceLines: 620,
      dependencyFanout: 16,
      responsibilitySurface: 20,
      controlFlowPoints: 160,
    }),
});

export const PRODUCTION_COMPLEXITY_HIGH_RISK_PATHS = Object.freeze([
  'paper-adapters/empirical-analysis/index.mjs',
  'paper-adapters/empirical-analysis/benchmark-contracts.mjs',
  'paper-adapters/empirical-analysis/execution-contracts.mjs',
  'paper-adapters/journal-manage/index.mjs',
  'paper-adapters/referee-revise/index.mjs',
  'paper-adapters/referee-revise/planning-service.mjs',
  'paper-adapters/referee-revise/post-repair.mjs',
  'paper-adapters/referee-revise/reconciliation.mjs',
  'paper-adapters/proposal/index.mjs',
  'paper-adapters/proposal/proposal-generation.mjs',
  'paper-adapters/proposal/proposal-materialization.mjs',
  'paper-adapters/automation/workspace-attempt-repository.mjs',
  'paper-adapters/automation/workspace-attempt-root-snapshot.mjs',
  'paper-adapters/automation/workspace-attempt-manifest.mjs',
  'paper-adapters/automation/workspace-attempt-descriptor.mjs',
  'paper-adapters/automation/workspace-attempt-commit-journal-repository.mjs',
  'paper-adapters/automation/workspace-snapshot-exporter.mjs',
  'paper-adapters/automation/workspace-snapshot-staging-repository.mjs',
  'paper-adapters/automation/workspace-snapshot-publication-repository.mjs',
  'paper-adapters/automation/runtime-retention.mjs',
  'paper-adapters/automation/runtime-retention-scope-repository.mjs',
  'paper-adapters/automation/runtime-retention-evidence-policy.mjs',
  'paper-adapters/automation/runtime-retention-intent-operations.mjs',
  'paper-adapters/automation/runtime-retention-intent-repository.mjs',
  'paper-adapters/automation/autonomous-research-supervisor-state-repository.mjs',
  'paper-adapters/automation/autonomous-research-supervisor-external-action-repository-support.mjs',
  'paper-adapters/automation/autonomous-research-supervisor-provider-canary-state-operations.mjs',
  'paper-adapters/runtime/os-sandbox-worker-execution-finalizer.mjs',
  'paper-adapters/runtime/os-sandboxed-worker-runner.mjs',
  'paper-adapters/runtime/scoped-file-materialization-repository.mjs',
  'paper-adapters/runtime/scoped-file-materialization-operation-journal-repository.mjs',
  'paper-adapters/runtime/scoped-file-materialization-recovery-entry-repository.mjs',
  'paper-adapters/runtime/scoped-file-materialization-prepared-recovery-repository.mjs',
  'paper-adapters/runtime/runtime-permission-repository.mjs',
  'paper-adapters/persistence/sqlite-campaign-store.mjs',
  'paper-adapters/persistence/sqlite-campaign-row-mappers.mjs',
  'paper-adapters/persistence/campaign-definition-codec.mjs',
  'paper-application/reporting/campaign-result-summary.mjs',
  'paper-application/reporting/batch-result-summary.mjs',
  'paper-application/reporting/workflow-result-summary.mjs',
  'paper-application/automation/autonomous-research-supervisor-provider-canary-dispatch.mjs',
  'paper-composition/automation/autonomous-research-supervisor-external-action-composition.mjs',
  'paper-domain/automation/autonomous-research-supervisor-external-action-journal.mjs',
  'paper-domain/automation/autonomous-research-campaign-execution-admission.mjs',
  'paper-domain/automation/campaign-research-contract.mjs',
]);

const PRODUCTION_COMPLEXITY_HIGH_RISK_PATH_SET =
  new Set(PRODUCTION_COMPLEXITY_HIGH_RISK_PATHS);
const PRODUCTION_COMPLEXITY_HIGH_RISK_CEILINGS = Object.freeze({
  sourceLines: 700,
  dependencyFanout: 16,
  publicExports: 30,
  responsibilitySurface: 32,
  controlFlowPoints: 220,
});

const STRUCTURAL_PRODUCTION_GRAPH_BLOCKERS = new Set([
  'production_graph_entrypoints_invalid',
  'production_graph_entrypoints_missing',
  'production_graph_workspace_escape_detected',
  'production_graph_modules_unreadable',
  'production_graph_relative_imports_unresolved',
  'production_graph_modules_unmerged',
]);

const METRIC_BLOCKERS = Object.freeze({
  sourceLines: 'production_complexity_source_lines_exceeded',
  dependencyFanout: 'production_complexity_dependency_fanout_exceeded',
  publicExports: 'production_complexity_public_exports_exceeded',
  responsibilitySurface: 'production_complexity_responsibility_surface_exceeded',
  controlFlowPoints: 'production_complexity_control_flow_exceeded',
});

function posix(relativePath) {
  return relativePath.replace(/\\/g, '/');
}

function normalizedModulePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.isAbsolute(relativePath)) return null;
  const normalized = posix(path.normalize(relativePath.trim())).replace(/^\.\//, '');
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('\0')) return null;
  return normalized;
}

function isWithinWorkspace(workspaceRoot, candidate) {
  const relative = path.relative(workspaceRoot, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function policyFor(relative, policies) {
  return policies.find((policy) => relative.startsWith(policy.pathPrefix)) || null;
}

function exclusionFor(relative, exclusions) {
  return exclusions.find((rule) => relative === rule.path) || null;
}

function ceilingsFor(relative, policy, pathCeilingOverrides) {
  const highRiskCeilings = PRODUCTION_COMPLEXITY_HIGH_RISK_PATH_SET.has(relative)
    ? PRODUCTION_COMPLEXITY_HIGH_RISK_CEILINGS : {};
  const pathCeilings = pathCeilingOverrides[relative] || {};
  return Object.freeze(Object.fromEntries(Object.entries(policy.ceilings).map(
    ([metric, maximum]) => [
      metric,
      Math.min(
        maximum,
        highRiskCeilings[metric] ?? maximum,
        pathCeilings[metric] ?? maximum,
      ),
    ],
  )));
}

function boundIdentifierCount(node) {
  if (!node) return 0;
  if (node.type === 'Identifier') return 1;
  if (node.type === 'RestElement') return boundIdentifierCount(node.argument);
  if (node.type === 'AssignmentPattern') return boundIdentifierCount(node.left);
  if (node.type === 'ArrayPattern') {
    return node.elements.reduce((count, element) => count + boundIdentifierCount(element), 0);
  }
  if (node.type === 'ObjectPattern') {
    return node.properties.reduce((count, property) => (
      count + boundIdentifierCount(property.type === 'RestElement' ? property.argument : property.value)
    ), 0);
  }
  return 0;
}

function publicExportContribution(node) {
  if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportAllDeclaration') return 1;
  if (node.type !== 'ExportNamedDeclaration') return 0;
  if (!node.declaration) return node.specifiers.length;
  if (node.declaration.type !== 'VariableDeclaration') return 1;
  return node.declaration.declarations.reduce(
    (count, declaration) => count + boundIdentifierCount(declaration.id),
    0,
  );
}

function controlFlowContribution(node) {
  if ([
    'IfStatement',
    'ForStatement',
    'ForInStatement',
    'ForOfStatement',
    'WhileStatement',
    'DoWhileStatement',
    'CatchClause',
    'ConditionalExpression',
  ].includes(node.type)) return 1;
  if (node.type === 'SwitchCase') return node.test ? 1 : 0;
  if (node.type === 'LogicalExpression' && ['&&', '||', '??'].includes(node.operator)) return 1;
  return 0;
}

function inspectSyntaxMetrics(source) {
  const ast = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowHashBang: true,
  });
  let publicExports = 0;
  let controlFlowPoints = 0;
  const pending = [ast];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    publicExports += publicExportContribution(node);
    controlFlowPoints += controlFlowContribution(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'range') continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === 'object') pending.push(child);
        }
      } else if (value && typeof value === 'object') {
        pending.push(value);
      }
    }
  }
  return { publicExports, controlFlowPoints };
}

function sourceLineCount(source) {
  if (!source) return 0;
  const lines = source.split(/\r\n?|\n/);
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

function manifestModules(graphReport) {
  return graphReport?.manifest?.modules;
}

function metricViolation({ relative, layer, metric, actual, maximum }) {
  return Object.freeze({
    blocker: METRIC_BLOCKERS[metric],
    path: relative,
    layer,
    metric,
    actual,
    maximum,
  });
}

function maximumByLayer(rows) {
  const result = {};
  for (const row of rows) {
    if (row.excluded || !row.layer || !row.metrics) continue;
    if (!result[row.layer]) {
      result[row.layer] = {
        sourceLines: 0,
        dependencyFanout: 0,
        publicExports: 0,
        responsibilitySurface: 0,
        controlFlowPoints: 0,
      };
    }
    for (const [metric, value] of Object.entries(row.metrics)) {
      result[row.layer][metric] = Math.max(result[row.layer][metric], value);
    }
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(result).map(([layer, metrics]) => [layer, Object.freeze(metrics)]),
  ));
}

export function inspectProductionComplexity({
  workspaceRoot = defaultWorkspaceRoot,
  graphReport = null,
  layerPolicies = PRODUCTION_COMPLEXITY_LAYER_POLICIES,
  payloadExclusions = PRODUCTION_COMPLEXITY_PAYLOAD_EXCLUSIONS,
  pathCeilingOverrides = PRODUCTION_COMPLEXITY_PATH_CEILING_OVERRIDES,
} = {}) {
  const absoluteWorkspace = path.resolve(workspaceRoot);
  const graph = graphReport || inspectTrackedProductionGraph({ workspaceRoot: absoluteWorkspace });
  const manifest = graph?.manifest;
  const modules = manifestModules(graph);
  const manifestValid = manifest?.version === 1
    && manifest?.kind === 'ProductionReachabilityManifest'
    && Number.isSafeInteger(manifest?.moduleCount)
    && manifest.moduleCount >= 0
    && Array.isArray(modules)
    && manifest.moduleCount === modules.length;
  if (!manifestValid) {
    return Object.freeze({
      version: 1,
      kind: 'ProductionComplexityReport',
      status: 'production_complexity_blocked',
      moduleCount: 0,
      inspectedModuleCount: 0,
      excludedModuleCount: 0,
      blockers: Object.freeze(['production_complexity_graph_manifest_invalid']),
      violations: Object.freeze([]),
      rows: Object.freeze([]),
      maximaByLayer: Object.freeze({}),
    });
  }

  const rows = [];
  const violations = [];
  if (modules.length === 0) {
    violations.push(Object.freeze({
      blocker: 'production_complexity_graph_manifest_empty',
    }));
  }
  if (graph?.blockers !== undefined && !Array.isArray(graph.blockers)) {
    violations.push(Object.freeze({
      blocker: 'production_complexity_graph_report_invalid',
    }));
  }
  for (const blocker of Array.isArray(graph?.blockers) ? graph.blockers : []) {
    if (STRUCTURAL_PRODUCTION_GRAPH_BLOCKERS.has(blocker)) {
      violations.push(Object.freeze({
        blocker,
        source: 'tracked-production-graph',
      }));
    }
  }
  const seen = new Set();
  for (const moduleRow of modules) {
    const relative = normalizedModulePath(moduleRow?.path);
    if (!relative || seen.has(relative)) {
      violations.push(Object.freeze({
        blocker: relative
          ? 'production_complexity_graph_module_duplicate'
          : 'production_complexity_graph_module_path_invalid',
        path: relative || String(moduleRow?.path || ''),
      }));
      continue;
    }
    seen.add(relative);
    const absolute = path.resolve(absoluteWorkspace, relative);
    if (!isWithinWorkspace(absoluteWorkspace, absolute)) {
      violations.push(Object.freeze({
        blocker: 'production_complexity_graph_module_path_invalid',
        path: relative,
      }));
      continue;
    }
    const dependenciesValid = Array.isArray(moduleRow?.dependencies)
      && moduleRow.dependencies.every((dependency) => (
        normalizedModulePath(dependency) !== null
      ));
    if (!dependenciesValid) {
      violations.push(Object.freeze({
        blocker: 'production_complexity_graph_module_dependencies_invalid',
        path: relative,
      }));
    }
    const dependencies = dependenciesValid
      ? [...new Set(moduleRow.dependencies.map(normalizedModulePath))]
      : [];
    const exclusion = exclusionFor(relative, payloadExclusions);
    if (exclusion) {
      rows.push(Object.freeze({
        path: relative,
        layer: null,
        excluded: true,
        exclusion: exclusion.id,
        metrics: null,
        ceilings: null,
      }));
      continue;
    }
    const policy = policyFor(relative, layerPolicies);
    if (!policy) {
      violations.push(Object.freeze({
        blocker: 'production_complexity_layer_unclassified',
        path: relative,
      }));
      rows.push(Object.freeze({
        path: relative,
        layer: null,
        excluded: false,
        exclusion: null,
        metrics: null,
        ceilings: null,
      }));
      continue;
    }
    const ceilings = ceilingsFor(relative, policy, pathCeilingOverrides);
    let source;
    try {
      source = fs.readFileSync(absolute, 'utf8');
    } catch (error) {
      violations.push(Object.freeze({
        blocker: 'production_complexity_module_unreadable',
        path: relative,
        message: error?.message || String(error),
      }));
      continue;
    }
    let syntaxMetrics;
    try {
      syntaxMetrics = inspectSyntaxMetrics(source);
    } catch (error) {
      violations.push(Object.freeze({
        blocker: 'production_complexity_module_parse_failed',
        path: relative,
        message: error?.message || String(error),
      }));
      continue;
    }
    const metrics = Object.freeze({
      sourceLines: sourceLineCount(source),
      dependencyFanout: dependencies.length,
      publicExports: syntaxMetrics.publicExports,
      responsibilitySurface: dependencies.length + syntaxMetrics.publicExports,
      controlFlowPoints: syntaxMetrics.controlFlowPoints,
    });
    const row = Object.freeze({
      path: relative,
      layer: policy.id,
      excluded: false,
      exclusion: null,
      metrics,
      ceilings,
    });
    rows.push(row);
    for (const [metric, maximum] of Object.entries(ceilings)) {
      if (metrics[metric] > maximum) {
        violations.push(metricViolation({
          relative,
          layer: policy.id,
          metric,
          actual: metrics[metric],
          maximum,
        }));
      }
    }
  }

  const blockers = [...new Set(violations.map((violation) => violation.blocker))].sort();
  const frozenRows = Object.freeze(rows.sort((left, right) => left.path.localeCompare(right.path)));
  return Object.freeze({
    version: 1,
    kind: 'ProductionComplexityReport',
    status: blockers.length ? 'production_complexity_blocked' : 'production_complexity_ready',
    productionGraphManifestHash: graph.productionGraphManifestHash || null,
    moduleCount: modules.length,
    inspectedModuleCount: frozenRows.filter((row) => !row.excluded && row.metrics).length,
    excludedModuleCount: frozenRows.filter((row) => row.excluded).length,
    blockers: Object.freeze(blockers),
    violations: Object.freeze(violations),
    rows: frozenRows,
    maximaByLayer: maximumByLayer(frozenRows),
  });
}
