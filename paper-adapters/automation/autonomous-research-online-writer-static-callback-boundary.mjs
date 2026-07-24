import { MUTATION_CAPABILITY_METHODS } from './autonomous-research-online-writer-static-config.mjs';

function propertyName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return String(node.value);
  return null;
}

export function mutationCallbackProperty(call) {
  const input = call?.arguments?.[0];
  if (input?.type !== 'ObjectExpression') return null;
  return input.properties.find((candidate) => (
    candidate.type === 'Property' && propertyName(candidate.key) === 'mutate'
  ));
}

function mutationCallback(call, referenceVariables) {
  const value = mutationCallbackProperty(call)?.value;
  if (['FunctionExpression', 'ArrowFunctionExpression'].includes(value?.type)) return value;
  if (value?.type !== 'Identifier') return null;
  const variable = referenceVariables.get(value);
  for (const definition of variable?.defs || []) {
    const candidate = definition.type === 'Variable'
      ? definition.node?.init
      : definition.type === 'FunctionName'
        ? definition.node
        : null;
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']
      .includes(candidate?.type)) return candidate;
  }
  return null;
}

function rootIdentifier(node) {
  let current = node;
  while (current?.type === 'ChainExpression') current = current.expression;
  while (current?.type === 'MemberExpression') current = current.object;
  return current?.type === 'Identifier' ? current : null;
}

function scopeWithin(scope, boundary) {
  for (let current = scope; current; current = current.upper) {
    if (current === boundary) return true;
  }
  return false;
}

function rawCapabilityBindingName(name) {
  const normalized = String(name || '').toLowerCase();
  return normalized === 'db'
    || normalized.includes('database')
    || normalized.includes('store')
    || normalized.includes('persistence');
}

function memberContainsRawCapabilityName(member) {
  for (let current = member?.object; current?.type === 'MemberExpression';) {
    if (rawCapabilityBindingName(propertyName(current.property))) return true;
    current = current.object;
  }
  return false;
}

export function callbackCapabilityViolations(
  call,
  scopeManager,
  referenceVariables,
  binding,
  entrypoint,
) {
  const property = mutationCallbackProperty(call);
  if (!property) return [];
  const callback = mutationCallback(call, referenceVariables);
  if (!callback) return [Object.freeze({
    entrypoint,
    databaseRole: binding?.databaseRole || null,
    operationId: binding?.operationId || null,
    capabilityBinding: property.value?.name || property.value?.type || 'unknown',
    method: 'uninspectable-callback',
    line: property.loc.start.line,
    column: property.loc.start.column,
  })];
  const callbackScope = scopeManager.acquire(callback);
  const transactionParameter = callback.params?.[0];
  const trusted = new Set();
  if (callbackScope && transactionParameter?.type === 'Identifier') {
    const variable = callbackScope.set.get(transactionParameter.name);
    if (variable) trusted.add(variable);
  }
  const rawCapabilities = new Set();
  for (const scope of scopeManager.scopes) {
    for (const variable of scope.variables) {
      if (rawCapabilityBindingName(variable.name)) rawCapabilities.add(variable);
    }
  }
  const mutationReceiver = call?.callee?.type === 'MemberExpression'
    ? rootIdentifier(call.callee.object)
    : null;
  const receiverVariable = mutationReceiver
    ? referenceVariables.get(mutationReceiver)
    : null;
  if (receiverVariable) rawCapabilities.add(receiverVariable);
  const databaseInput = call?.arguments?.[0]?.type === 'ObjectExpression'
    ? call.arguments[0].properties.find((property) => (
      property.type === 'Property' && propertyName(property.key) === 'database'
    ))?.value
    : null;
  const databaseInputRoot = rootIdentifier(databaseInput);
  const databaseInputVariable = databaseInputRoot
    ? referenceVariables.get(databaseInputRoot)
    : null;
  if (databaseInputVariable) rawCapabilities.add(databaseInputVariable);
  let changed = true;
  while (changed) {
    changed = false;
    for (const scope of scopeManager.scopes.filter((candidate) => (
      scopeWithin(candidate, callbackScope)
    ))) {
      for (const variable of scope.variables) {
        if (trusted.has(variable)) continue;
        const aliasesTrustedTransaction = variable.defs.some((definition) => (
          definition.type === 'Variable'
          && definition.node?.init?.type === 'Identifier'
          && trusted.has(referenceVariables.get(definition.node.init))
        ));
        if (aliasesTrustedTransaction) {
          trusted.add(variable);
          changed = true;
        }
      }
    }
    for (const scope of scopeManager.scopes) {
      for (const variable of scope.variables) {
        if (rawCapabilities.has(variable)) continue;
        const aliasesRawCapability = variable.defs.some((definition) => {
          if (definition.type !== 'Variable') return false;
          const root = rootIdentifier(definition.node?.init);
          return root && rawCapabilities.has(referenceVariables.get(root));
        });
        if (aliasesRawCapability) {
          rawCapabilities.add(variable);
          changed = true;
        }
      }
    }
  }
  const violations = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'MemberExpression') {
      const dynamicMethod = node.computed
        && !['Literal', 'TemplateLiteral'].includes(node.property?.type);
      const method = dynamicMethod ? 'dynamic' : propertyName(node.property);
      const root = rootIdentifier(node);
      const variable = root ? referenceVariables.get(root) : null;
      const rawCapability = rawCapabilities.has(variable)
        || memberContainsRawCapabilityName(node);
      if ((MUTATION_CAPABILITY_METHODS.has(method) || dynamicMethod)
        && variable
        && rawCapability
        && !trusted.has(variable)) {
        violations.push(Object.freeze({
          entrypoint,
          databaseRole: binding?.databaseRole || null,
          operationId: binding?.operationId || null,
          capabilityBinding: root.name,
          method,
          line: node.loc.start.line,
          column: node.loc.start.column,
        }));
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'range', 'start', 'end'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach((child) => child?.type && visit(child));
      else if (value?.type) visit(value);
    }
  };
  visit(callback.body);
  return violations;
}
