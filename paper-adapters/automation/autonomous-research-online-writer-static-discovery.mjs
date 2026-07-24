import path from 'node:path';
import * as espree from 'espree';
import { analyze } from 'eslint-scope';

import {
  DIRECT_SQL_ALLOWED_ENTRYPOINT_EXCLUSIONS,
  GENERIC_MUTATION_SURFACES,
  MUTATION_SQL,
  NON_WRITER_ENTRYPOINT_EXCLUSIONS,
  NON_WRITER_EXCLUSIONS,
  SQL_CALLS,
  WRITABLE_FACTORY_IMPORT_SOURCES,
} from './autonomous-research-online-writer-static-config.mjs';
import {
  callbackCapabilityViolations,
  mutationCallbackProperty,
} from './autonomous-research-online-writer-static-callback-boundary.mjs';

function staticString(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral') {
    return node.quasis.map((quasi) => quasi.value.cooked || quasi.value.raw).join('?');
  }
  return null;
}

function propertyName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return String(node.value);
  return null;
}

function namedFunction(node, parent) {
  if (node.type === 'FunctionDeclaration' && node.id?.name) return node.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') {
    return parent.id.name;
  }
  if (parent?.type === 'Property') return propertyName(parent.key);
  if (parent?.type === 'MethodDefinition') return propertyName(parent.key);
  return null;
}

function enclosingEntrypoint(ancestors) {
  for (let index = ancestors.length - 2; index >= 0; index -= 1) {
    const { node, parent } = ancestors[index];
    if (node.type === 'FunctionDeclaration'
      || node.type === 'FunctionExpression'
      || node.type === 'ArrowFunctionExpression') {
      const name = namedFunction(node, parent);
      if (name) return name;
    }
  }
  return 'moduleSchemaProvisioning';
}

function literalMutationBinding(call) {
  const databaseRole = literalObjectProperty(call?.arguments?.[0], 'databaseRole');
  const operationId = literalObjectProperty(call?.arguments?.[0], 'operationId');
  return databaseRole && operationId ? { databaseRole, operationId } : null;
}

function isFencedMutationCall(call) {
  const property = callPropertyName(call);
  return property === 'executeMutation'
    || (['mutate', 'mutation'].includes(property) && literalMutationBinding(call));
}

function enclosingFencedMutationEntrypoint(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    if (ancestors[index].node?.type === 'CallExpression'
      && isFencedMutationCall(ancestors[index].node)) {
      return enclosingEntrypoint(ancestors.slice(0, index + 1));
    }
  }
  return null;
}

function callPropertyName(call) {
  if (call?.callee?.type === 'Identifier') return call.callee.name;
  if (call?.callee?.type === 'MemberExpression') return propertyName(call.callee.property);
  return null;
}

function callHasMutationSql(call) {
  const pending = [...(call.arguments || [])];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    const text = staticString(node);
    if (text !== null && MUTATION_SQL.test(text)) return true;
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'range', 'start', 'end'].includes(key)) continue;
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === 'object') pending.push(value);
    }
  }
  return false;
}

function callHasDynamicSql(call) {
  return (call.arguments || []).some((argument) => (
    argument?.type === 'Identifier'
    || (argument?.type === 'MemberExpression')
    || (argument?.type === 'TemplateLiteral' && argument.expressions.length > 0)
  ));
}

function callHasCreateTrue(call) {
  return (call.arguments || []).some((argument) => (
    argument?.type === 'ObjectExpression'
    && argument.properties.some((property) => (
      propertyName(property.key) === 'create'
      && property.value?.type === 'Literal'
      && property.value.value === true
    ))
  ));
}

function literalObjectProperty(object, key) {
  if (object?.type !== 'ObjectExpression') return null;
  const property = object.properties.find((candidate) => (
    candidate.type === 'Property' && propertyName(candidate.key) === key
  ));
  return staticString(property?.value);
}

function canonicalImportSource(relativePath, importSource) {
  if (typeof importSource !== 'string' || !importSource.startsWith('.')) return null;
  const resolved = path.posix.normalize(path.posix.join(
    path.posix.dirname(relativePath),
    importSource,
  ));
  return path.posix.extname(resolved) ? resolved : `${resolved}.mjs`;
}

function importedWritableFactories(ast, relativePath) {
  const bindings = new Set();
  for (const node of ast.body || []) {
    if (node.type !== 'ImportDeclaration') continue;
    const importedSource = canonicalImportSource(relativePath, node.source?.value);
    const allowed = new Set(WRITABLE_FACTORY_IMPORT_SOURCES[importedSource] || []);
    if (allowed.size === 0) continue;
    for (const specifier of node.specifiers || []) {
      if (specifier.type !== 'ImportSpecifier') continue;
      const imported = propertyName(specifier.imported);
      if (allowed.has(imported)) bindings.add(specifier.local.name);
    }
  }
  return bindings;
}

function candidateWriterModule(relativePath, source) {
  return /from ['"]node:sqlite['"]/.test(source)
    || /\.executeMutation\s*\(/.test(source)
    || /\b(?:store|database|db|getApi\(\)|statement|stmt)\.(?:exec|execute|run|prepare|query|transaction)\s*\(/.test(source)
    || /\b(?:createSqliteStore|createReadOnlySqliteStore|writableStore|open[A-Za-z0-9]*Writable[A-Za-z0-9]*)\s*\(/.test(source)
    || Object.values(WRITABLE_FACTORY_IMPORT_SOURCES).some((entrypoints) => (
      entrypoints.some((entrypoint) => new RegExp(`\\b${entrypoint}\\s*\\(`).test(source))
    ))
    || /\bcreate[A-Za-z0-9]+Repository\s*\(\s*\{[^}]*\bcreate\s*:\s*true\b/s.test(source)
    || relativePath.startsWith('paper-adapters/persistence/')
    || relativePath.startsWith('paper-adapters/submission/');
}

export function discoverAutonomousResearchOnlineWriterMutationEntrypoints(
  relativePath,
  source,
) {
  if (NON_WRITER_EXCLUSIONS[relativePath]) return Object.freeze({
    entrypoints: Object.freeze([]),
    allFunctions: Object.freeze([]),
    coordinatorBindings: Object.freeze([]),
    callbackBoundaryViolations: Object.freeze([]),
    exclusionReason: NON_WRITER_EXCLUSIONS[relativePath],
  });
  if (!candidateWriterModule(relativePath, source)) return Object.freeze({
    entrypoints: Object.freeze([]),
    allFunctions: Object.freeze([]),
    coordinatorBindings: Object.freeze([]),
    callbackBoundaryViolations: Object.freeze([]),
    exclusionReason: null,
  });
  let ast;
  try {
    ast = espree.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      loc: true,
      range: true,
    });
  } catch {
    throw new Error(`autonomous_research_online_writer_ast_parse_failed:${relativePath}`);
  }
  const writableFactoryBindings = importedWritableFactories(ast, relativePath);
  const scopeManager = analyze(ast, {
    ecmaVersion: 2024,
    sourceType: 'module',
    impliedStrict: true,
  });
  const referenceVariables = new WeakMap();
  for (const scope of scopeManager.scopes) {
    for (const reference of [...scope.references, ...scope.through]) {
      if (reference.resolved) referenceVariables.set(reference.identifier, reference.resolved);
    }
  }
  const localWritableFactories = new Set(
    WRITABLE_FACTORY_IMPORT_SOURCES[relativePath] || [],
  );
  const ancestors = [];
  const mutations = new Set();
  const directSqlMutationEntrypoints = new Set();
  const coordinatorBindings = [];
  const callbackBoundaryViolations = [];
  const allFunctions = new Set(['moduleSchemaProvisioning']);
  const callsByEntrypoint = new Map();
  const recordCall = (caller, callee) => {
    if (!callee) return;
    if (!callsByEntrypoint.has(caller)) callsByEntrypoint.set(caller, new Set());
    callsByEntrypoint.get(caller).add(callee);
  };
  const visit = (node, parent) => {
    if (!node || typeof node !== 'object') return;
    ancestors.push({ node, parent });
    if (node.type === 'FunctionDeclaration'
      || node.type === 'FunctionExpression'
      || node.type === 'ArrowFunctionExpression') {
      const name = namedFunction(node, parent);
      if (name) allFunctions.add(name);
    }
    if (node.type === 'CallExpression') {
      const property = callPropertyName(node);
      const caller = enclosingFencedMutationEntrypoint(ancestors)
        || enclosingEntrypoint(ancestors);
      recordCall(caller, property);
      const literalBinding = literalMutationBinding(node);
      const fencedCallback = property === 'executeMutation'
        || (['mutate', 'mutation'].includes(property) && mutationCallbackProperty(node));
      if (fencedCallback) {
        callbackBoundaryViolations.push(...callbackCapabilityViolations(
          node,
          scopeManager,
          referenceVariables,
          literalBinding,
          caller,
        ));
      }
      if (property === 'executeMutation'
        || (['mutate', 'mutation'].includes(property) && literalBinding)) {
        coordinatorBindings.push(Object.freeze({
          entrypoint: caller,
          databaseRole: literalBinding?.databaseRole || null,
          operationId: literalBinding?.operationId || null,
        }));
      }
      const hasMutationSql = callHasMutationSql(node);
      const mutationSqlCall = SQL_CALLS.has(property) && hasMutationSql;
      const directDynamicWrite = ['execute', 'exec'].includes(property)
        && callHasDynamicSql(node);
      const preparedStatementRun = property === 'run';
      const writableOpen = ['createSqliteStore', 'writableStore'].includes(property)
        || writableFactoryBindings.has(property)
        || localWritableFactories.has(property)
        || (/^create[A-Za-z0-9]+Repository$/.test(String(property || ''))
          && callHasCreateTrue(node));
      if (mutationSqlCall || directDynamicWrite || preparedStatementRun || writableOpen) {
        mutations.add(caller);
      }
      if (mutationSqlCall || directDynamicWrite) {
        directSqlMutationEntrypoints.add(caller);
      }
    }
    const literal = staticString(node);
    if (literal !== null && MUTATION_SQL.test(literal)) {
      const entrypoint = enclosingEntrypoint(ancestors);
      mutations.add(entrypoint);
      directSqlMutationEntrypoints.add(entrypoint);
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'range', 'start', 'end'].includes(key)) continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child?.type) visit(child, node);
        }
      } else if (value?.type) visit(value, node);
    }
    ancestors.pop();
  };
  visit(ast, null);
  for (;;) {
    let changed = false;
    for (const [caller, callees] of callsByEntrypoint) {
      if (!mutations.has(caller) && [...callees].some((callee) => mutations.has(callee))) {
        mutations.add(caller);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const entrypoint of GENERIC_MUTATION_SURFACES[relativePath] || []) {
    if (allFunctions.has(entrypoint)) mutations.add(entrypoint);
  }
  const excludedEntrypoints = [];
  const excludedEntrypointNames = new Set();
  const exclusionApplies = (entrypoint) => {
    const key = `${relativePath}:${entrypoint}`;
    return Boolean(NON_WRITER_ENTRYPOINT_EXCLUSIONS[key]
      && (!directSqlMutationEntrypoints.has(entrypoint)
        || DIRECT_SQL_ALLOWED_ENTRYPOINT_EXCLUSIONS.has(key)));
  };
  const exclusionCandidates = new Set([
    ...mutations,
    ...coordinatorBindings.map((binding) => binding.entrypoint),
  ]);
  for (const entrypoint of exclusionCandidates) {
    const key = `${relativePath}:${entrypoint}`;
    if (!exclusionApplies(entrypoint)) continue;
    mutations.delete(entrypoint);
    excludedEntrypointNames.add(entrypoint);
    excludedEntrypoints.push(Object.freeze({
      sourceFile: relativePath,
      entrypoint,
      reason: NON_WRITER_ENTRYPOINT_EXCLUSIONS[key],
    }));
  }
  const uniqueCoordinatorBindings = [...new Map(coordinatorBindings.map((binding) => [
    [binding.entrypoint, binding.databaseRole, binding.operationId].join('\0'),
    binding,
  ])).values()];
  return Object.freeze({
    entrypoints: Object.freeze([...mutations].sort()),
    allFunctions: Object.freeze([...allFunctions].sort()),
    coordinatorBindings: Object.freeze(uniqueCoordinatorBindings
      .filter((binding) => !excludedEntrypointNames.has(binding.entrypoint))
      .sort((left, right) => (
      left.entrypoint.localeCompare(right.entrypoint)
        || String(left.operationId).localeCompare(String(right.operationId))
      ))),
    callbackBoundaryViolations: Object.freeze(callbackBoundaryViolations.filter(
      (violation) => !excludedEntrypointNames.has(violation.entrypoint),
    )),
    exclusionReason: null,
    excludedEntrypoints: Object.freeze(excludedEntrypoints),
  });
}
