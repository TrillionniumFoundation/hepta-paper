import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { leanTypeIdentity } from './lean-type-identity.mjs';

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_']*$/;
const SUPPORTED_ATOMS = Object.freeze(new Map([
  ['Nat', 'nat'],
  ['Int', 'int'],
  ['Bool', 'bool'],
  ['Real', 'real'],
]));
export const TYPED_THEOREM_DSL_DOMAIN_CAPABILITIES = Object.freeze([
  Object.freeze({
    domain: 'Vector',
    fragment: 'fixed-dimension-additive-identity-v2',
    counterexampleSearch: 'not-applicable-kernel-elaboration-only-v1',
    requiredImports: Object.freeze(['Mathlib']),
  }),
  Object.freeze({
    domain: 'Matrix',
    fragment: 'fixed-dimension-additive-identity-v2',
    counterexampleSearch: 'not-applicable-kernel-elaboration-only-v1',
    requiredImports: Object.freeze(['Mathlib']),
  }),
  Object.freeze({
    domain: 'Measure',
    fragment: 'finite-carrier-measure-additive-identity-v2',
    counterexampleSearch: 'not-applicable-kernel-elaboration-only-v1',
    requiredImports: Object.freeze(['Mathlib']),
  }),
  Object.freeze({
    domain: 'OptimizationFeasibleSet',
    fragment: 'real-feasible-set-universal-intersection-v2',
    counterexampleSearch: 'not-applicable-kernel-elaboration-only-v1',
    requiredImports: Object.freeze(['Mathlib']),
  }),
  Object.freeze({
    domain: 'StochasticProcess',
    fragment: 'nat-indexed-finite-state-real-process-additive-identity-v2',
    counterexampleSearch: 'not-applicable-kernel-elaboration-only-v1',
    requiredImports: Object.freeze(['Mathlib']),
  }),
  Object.freeze({
    domain: 'Real',
    fragment: 'ordered-ring-polynomial-v1',
    counterexampleSearch: 'bounded-integer-embedding-incomplete-v1',
    requiredImports: Object.freeze(['Mathlib']),
  }),
  Object.freeze({
    domain: 'Nat',
    fragment: 'ordered-semiring-polynomial-v1',
    counterexampleSearch: 'bounded-prefix-incomplete-v1',
    requiredImports: Object.freeze(['Init']),
  }),
  Object.freeze({
    domain: 'Int',
    fragment: 'ordered-ring-polynomial-v1',
    counterexampleSearch: 'bounded-prefix-incomplete-v1',
    requiredImports: Object.freeze(['Init']),
  }),
  Object.freeze({
    domain: 'Bool',
    fragment: 'equality-v1',
    counterexampleSearch: 'complete-finite-domain-v1',
    requiredImports: Object.freeze(['Init']),
  }),
  Object.freeze({
    domain: 'Fin',
    fragment: 'bounded-equality-and-order-v1',
    counterexampleSearch: 'complete-finite-domain-v1',
    requiredImports: Object.freeze(['Init']),
  }),
]);
const RELATIONS = Object.freeze(['!=', '>=', '<=', '=', '<', '>']);
const ARITHMETIC = Object.freeze([
  Object.freeze({ symbols: ['∩'], names: ['intersection'] }),
  Object.freeze({ symbols: ['+', '-'], names: ['add', 'sub'] }),
  Object.freeze({ symbols: ['*'], names: ['mul'] }),
]);

function normalizeSource(value) {
  return String(value || '').normalize('NFKC')
    .replace(/∀/g, 'forall ')
    .replace(/→/g, ' -> ')
    .replace(/≠/g, ' != ')
    .replace(/≤/g, ' <= ')
    .replace(/≥/g, ' >= ')
    .replace(/\s+/g, ' ')
    .trim();
}

function balancedOuterParentheses(source) {
  if (!source.startsWith('(') || !source.endsWith(')')) return false;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    if (source[index] === ')') depth -= 1;
    if (depth === 0 && index < source.length - 1) return false;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function stripOuterParentheses(value) {
  let source = String(value || '').trim();
  while (balancedOuterParentheses(source)) source = source.slice(1, -1).trim();
  return source;
}

function topLevelIndex(source, symbols) {
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    if (depth !== 0) continue;
    for (const symbol of symbols) {
      if (source.slice(index, index + symbol.length) === symbol) return index;
    }
  }
  return -1;
}

function splitTopLevel(source, symbol) {
  const parts = [];
  let remaining = source;
  while (true) {
    const index = topLevelIndex(remaining, [symbol]);
    if (index < 0) break;
    parts.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index + symbol.length).trim();
  }
  parts.push(remaining.trim());
  return parts;
}

function parseDomain(value) {
  const source = stripOuterParentheses(value);
  if (SUPPORTED_ATOMS.has(source)) {
    return Object.freeze({ kind: SUPPORTED_ATOMS.get(source) });
  }
  const fin = /^Fin\s+([1-9][0-9]{0,5})$/.exec(source);
  if (fin) return Object.freeze({ kind: 'fin', size: Number(fin[1]) });
  const vector = /^Vector\s+Real\s+([1-9][0-9]{0,3})$/.exec(source);
  if (vector) return Object.freeze({ kind: 'vector-real', size: Number(vector[1]) });
  const matrix = /^Matrix\s+\(Fin\s+([1-9][0-9]{0,3})\)\s+\(Fin\s+([1-9][0-9]{0,3})\)\s+Real$/.exec(source);
  if (matrix) return Object.freeze({
    kind: 'matrix-real', rows: Number(matrix[1]), columns: Number(matrix[2]),
  });
  const measureBool = /^MeasureTheory\.Measure\s+Bool$/.exec(source);
  if (measureBool) return Object.freeze({ kind: 'measure-bool' });
  const measureFin = /^MeasureTheory\.Measure\s+\(Fin\s+([1-9][0-9]{0,3})\)$/.exec(source);
  if (measureFin) return Object.freeze({ kind: 'measure-fin', size: Number(measureFin[1]) });
  if (source === 'Set Real') return Object.freeze({ kind: 'optimization-feasible-set-real' });
  if (source === 'Nat -> Bool -> Real') {
    return Object.freeze({ kind: 'stochastic-process-nat-bool-real' });
  }
  throw new Error('typed_theorem_dsl_domain_unsupported');
}

function parseTerm(value, variables) {
  const source = stripOuterParentheses(value);
  for (const level of ARITHMETIC) {
    let depth = 0;
    for (let index = source.length - 1; index >= 0; index -= 1) {
      const character = source[index];
      if (character === ')') depth += 1;
      else if (character === '(') depth -= 1;
      if (depth !== 0 || !level.symbols.includes(character)) continue;
      if (character === '-' && index === 0) continue;
      const left = source.slice(0, index).trim();
      const right = source.slice(index + 1).trim();
      if (!left || !right) continue;
      return Object.freeze({
        kind: level.names[level.symbols.indexOf(character)],
        left: parseTerm(left, variables),
        right: parseTerm(right, variables),
      });
    }
  }
  if (/^-?[0-9]+$/.test(source)) {
    const valueNumber = Number(source);
    if (!Number.isSafeInteger(valueNumber)) throw new Error('typed_theorem_dsl_literal_invalid');
    return Object.freeze({ kind: 'literal', value: valueNumber });
  }
  if (source === 'true' || source === 'false') {
    return Object.freeze({ kind: 'boolean', value: source === 'true' });
  }
  if (source === 'Set.univ') return Object.freeze({ kind: 'set-univ' });
  if (SAFE_NAME.test(source) && variables.has(source)) {
    return Object.freeze({ kind: 'variable', name: source });
  }
  throw new Error('typed_theorem_dsl_term_unsupported');
}

function parseRelation(value, variables) {
  const source = stripOuterParentheses(value);
  const index = topLevelIndex(source, RELATIONS);
  if (index < 0) throw new Error('typed_theorem_dsl_relation_required');
  const relation = RELATIONS.find((candidate) => (
    source.slice(index, index + candidate.length) === candidate
  ));
  const left = source.slice(0, index).trim();
  const right = source.slice(index + relation.length).trim();
  if (!left || !right) throw new Error('typed_theorem_dsl_relation_invalid');
  return Object.freeze({
    kind: 'relation',
    relation,
    left: parseTerm(left, variables),
    right: parseTerm(right, variables),
  });
}

function parseBindersAndBody(value) {
  let source = normalizeSource(value);
  const binders = [];
  while (source.startsWith('forall ')) {
    source = source.slice('forall '.length).trim();
    const comma = topLevelIndex(source, [',']);
    if (comma < 0) throw new Error('typed_theorem_dsl_binder_separator_missing');
    const declaration = stripOuterParentheses(source.slice(0, comma));
    source = source.slice(comma + 1).trim();
    const separator = topLevelIndex(declaration, [':']);
    if (separator < 0) throw new Error('typed_theorem_dsl_binder_type_missing');
    const names = declaration.slice(0, separator).trim().split(/\s+/).filter(Boolean);
    const domain = parseDomain(declaration.slice(separator + 1));
    if (!names.length || names.some((name) => !SAFE_NAME.test(name))) {
      throw new Error('typed_theorem_dsl_binder_name_invalid');
    }
    for (const name of names) binders.push(Object.freeze({ name, domain }));
  }
  if (!binders.length) throw new Error('typed_theorem_dsl_binder_required');
  if (new Set(binders.map((binder) => binder.name)).size !== binders.length) {
    throw new Error('typed_theorem_dsl_binder_duplicate');
  }
  return Object.freeze({ binders: Object.freeze(binders), body: source });
}

function compileDomain(domain) {
  if (domain.kind === 'nat') return 'Nat';
  if (domain.kind === 'int') return 'Int';
  if (domain.kind === 'bool') return 'Bool';
  if (domain.kind === 'real') return 'Real';
  if (domain.kind === 'fin') return `Fin ${domain.size}`;
  if (domain.kind === 'vector-real') return `Vector Real ${domain.size}`;
  if (domain.kind === 'matrix-real') {
    return `Matrix (Fin ${domain.rows}) (Fin ${domain.columns}) Real`;
  }
  if (domain.kind === 'measure-bool') return 'MeasureTheory.Measure Bool';
  if (domain.kind === 'measure-fin') return `MeasureTheory.Measure (Fin ${domain.size})`;
  if (domain.kind === 'optimization-feasible-set-real') return 'Set Real';
  if (domain.kind === 'stochastic-process-nat-bool-real') return 'Nat → Bool → Real';
  throw new Error('typed_theorem_dsl_domain_invalid');
}

function domainRequiresMathlib(domain) {
  return [
    'real', 'vector-real', 'matrix-real', 'measure-bool', 'measure-fin',
    'optimization-feasible-set-real', 'stochastic-process-nat-bool-real',
  ].includes(domain.kind);
}

function compileTerm(term, parentPrecedence = 0, rightOperand = false) {
  if (term.kind === 'variable') return term.name;
  if (term.kind === 'literal') return String(term.value);
  if (term.kind === 'boolean') return term.value ? 'true' : 'false';
  if (term.kind === 'set-univ') return 'Set.univ';
  const operators = { intersection: '∩', add: '+', sub: '-', mul: '*' };
  if (operators[term.kind]) {
    const precedence = term.kind === 'intersection' ? 0 : term.kind === 'mul' ? 2 : 1;
    const source = `${compileTerm(term.left, precedence)} ${operators[term.kind]} ${compileTerm(
      term.right,
      precedence,
      true,
    )}`;
    return precedence < parentPrecedence
      || (rightOperand && precedence === parentPrecedence && term.kind === 'sub')
      ? `(${source})` : source;
  }
  throw new Error('typed_theorem_dsl_term_invalid');
}

function compileRelation(relation) {
  const symbols = { '!=': '≠', '>=': '≥', '<=': '≤', '=': '=', '<': '<', '>': '>' };
  if (!symbols[relation.relation]) throw new Error('typed_theorem_dsl_relation_invalid');
  return `${compileTerm(relation.left)} ${symbols[relation.relation]} ${compileTerm(relation.right)}`;
}

export function compileTypedTheoremDsl(dsl) {
  if (dsl?.version !== 1 || dsl?.kind !== 'TypedTheoremDsl'
    || !Array.isArray(dsl.binders) || !dsl.binders.length
    || !Array.isArray(dsl.assumptions) || !dsl.conclusion) {
    throw new Error('typed_theorem_dsl_invalid');
  }
  const binderGroups = [];
  for (const binder of dsl.binders) {
    const domain = compileDomain(binder.domain);
    const previous = binderGroups.at(-1);
    if (previous?.domain === domain) previous.names.push(binder.name);
    else binderGroups.push({ domain, names: [binder.name] });
  }
  const binderSource = binderGroups.map((group) => (
    `${group.names.join(' ')} : ${group.domain}`
  )).join(', ');
  const proposition = [...dsl.assumptions, dsl.conclusion]
    .map(compileRelation).join(' → ');
  return `∀ ${binderSource}, ${proposition}`;
}

function canonicalNegativeScope() {
  return Object.freeze({
    boundedToDeclaredBinders: true,
    excludedClaimClasses: Object.freeze([
      'causal_inference', 'empirical_generalization', 'open_world_domain_extension',
    ]),
  });
}

export function buildTypedTheoremDslFromLeanType({
  leanTypeSource,
  leanTypeSourceHash = null,
  leanNormalizedTypeHash = null,
  allowedImports = [],
} = {}) {
  const source = String(leanTypeSource || '').trim();
  const sourceHash = hashBytes(Buffer.from(source, 'utf8'));
  const sourceTypeHash = leanTypeIdentity(source).normalizedTypeHash;
  const imports = Object.freeze([...new Set((Array.isArray(allowedImports)
    ? allowedImports : []).map(String))].sort());
  const base = {
    version: 1,
    kind: 'TypedTheoremDsl',
    sourceLeanTypeHash: sourceHash,
    sourceLeanNormalizedTypeHash: sourceTypeHash,
    allowedImports: imports,
    negativeScope: canonicalNegativeScope(),
  };
  if ((leanTypeSourceHash && leanTypeSourceHash !== sourceHash)
    || (leanNormalizedTypeHash && leanNormalizedTypeHash !== sourceTypeHash)) {
    throw new Error('typed_theorem_dsl_source_authority_mismatch');
  }
  try {
    const { binders, body } = parseBindersAndBody(source);
    if (!imports.includes('Mathlib')
      && binders.some((binder) => domainRequiresMathlib(binder.domain))) {
      throw new Error(binders.some((binder) => binder.domain.kind === 'real')
        ? 'typed_theorem_dsl_real_mathlib_import_required'
        : 'typed_theorem_dsl_mathlib_domain_import_required');
    }
    const variables = new Set(binders.map((binder) => binder.name));
    const propositions = splitTopLevel(body, '->');
    if (!propositions.length || propositions.some((item) => !item)) {
      throw new Error('typed_theorem_dsl_proposition_invalid');
    }
    const assumptions = Object.freeze(propositions.slice(0, -1)
      .map((item) => parseRelation(item, variables)));
    const conclusion = parseRelation(propositions.at(-1), variables);
    const payload = Object.freeze({
      ...base,
      status: 'typed_theorem_dsl_compiled',
      machineSearchEligible: true,
      semanticReviewOnlyReason: null,
      binders,
      assumptions,
      conclusion,
    });
    const compiledLeanTypeSource = compileTypedTheoremDsl(payload);
    const compiledLeanNormalizedTypeHash = leanTypeIdentity(compiledLeanTypeSource)
      .normalizedTypeHash;
    if (compiledLeanNormalizedTypeHash !== sourceTypeHash) {
      throw new Error('typed_theorem_dsl_compiler_type_mismatch');
    }
    const compilation = Object.freeze({
      ...payload,
      compiledLeanTypeSource,
      compiledLeanTypeSourceHash: hashBytes(Buffer.from(compiledLeanTypeSource, 'utf8')),
      compiledLeanNormalizedTypeHash,
    });
    return Object.freeze({
      ...compilation,
      typedTheoremDslHash: hashRecord('TypedTheoremDsl', compilation),
    });
  } catch (error) {
    const unsupported = Object.freeze({
      ...base,
      status: 'typed_theorem_dsl_semantic_review_only',
      machineSearchEligible: false,
      semanticReviewOnlyReason: String(error?.message || 'typed_theorem_dsl_unsupported'),
      binders: null,
      assumptions: null,
      conclusion: null,
      compiledLeanTypeSource: null,
      compiledLeanTypeSourceHash: null,
      compiledLeanNormalizedTypeHash: null,
    });
    return Object.freeze({
      ...unsupported,
      typedTheoremDslHash: hashRecord('TypedTheoremDsl', unsupported),
    });
  }
}

function termValue(term, environment, exactIntegerArithmetic = false) {
  if (term.kind === 'variable') return environment[term.name];
  if (term.kind === 'literal') {
    return exactIntegerArithmetic ? BigInt(term.value) : term.value;
  }
  if (term.kind === 'boolean') return term.value;
  const left = termValue(term.left, environment, exactIntegerArithmetic);
  const right = termValue(term.right, environment, exactIntegerArithmetic);
  if (term.kind === 'add') return left + right;
  if (term.kind === 'sub') return left - right;
  if (term.kind === 'mul') return left * right;
  throw new Error('typed_theorem_dsl_evaluation_term_invalid');
}

function relationValue(relation, environment, exactIntegerArithmetic = false) {
  const left = termValue(relation.left, environment, exactIntegerArithmetic);
  const right = termValue(relation.right, environment, exactIntegerArithmetic);
  if (relation.relation === '=') return left === right;
  if (relation.relation === '!=') return left !== right;
  if (relation.relation === '<') return left < right;
  if (relation.relation === '<=') return left <= right;
  if (relation.relation === '>') return left > right;
  if (relation.relation === '>=') return left >= right;
  throw new Error('typed_theorem_dsl_evaluation_relation_invalid');
}

function valuesForDomain(domain, bounds) {
  if (domain.kind === 'bool') return { complete: true, values: [false, true] };
  if (domain.kind === 'fin') {
    return { complete: true, values: Array.from({ length: domain.size }, (_, index) => index) };
  }
  if (domain.kind === 'nat') {
    return { complete: false, values: Array.from({ length: bounds.natUpperBound + 1 }, (_, index) => index) };
  }
  if (domain.kind === 'int') {
    return { complete: false, values: Array.from(
      { length: (bounds.intAbsoluteBound * 2) + 1 },
      (_, index) => index - bounds.intAbsoluteBound,
    ) };
  }
  if (domain.kind === 'real') {
    return { complete: false, values: Array.from(
      { length: (bounds.realAbsoluteBound * 2) + 1 },
      (_, index) => index - bounds.realAbsoluteBound,
    ) };
  }
  throw new Error('typed_theorem_dsl_evaluation_domain_invalid');
}

export function searchTypedTheoremDslCounterexample(dsl, {
  natUpperBound = 32,
  intAbsoluteBound = 16,
  realAbsoluteBound = 8,
  maximumAssignments = 4096,
} = {}) {
  if (dsl?.status !== 'typed_theorem_dsl_compiled' || !dsl.machineSearchEligible) {
    throw new Error('typed_theorem_dsl_counterexample_search_unsupported');
  }
  if (![natUpperBound, intAbsoluteBound, realAbsoluteBound, maximumAssignments]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('typed_theorem_dsl_counterexample_bounds_invalid');
  }
  const bounds = { natUpperBound, intAbsoluteBound, realAbsoluteBound };
  const domains = dsl.binders.map((binder) => valuesForDomain(binder.domain, bounds));
  const totalAssignments = domains.reduce((total, domain) => total * domain.values.length, 1);
  if (!Number.isSafeInteger(totalAssignments) || totalAssignments > maximumAssignments) {
    const payload = Object.freeze({
      status: 'bounded_counterexample_search_inconclusive',
      reason: 'assignment_limit_exceeded',
      checkedAssignments: 0,
      completeFiniteDomain: false,
      witness: null,
      bounds,
    });
    return Object.freeze({ ...payload, resultHash: hashRecord('TypedTheoremCounterexampleSearch', payload) });
  }
  let checkedAssignments = 0;
  let witness = null;
  const exactIntegerArithmetic = dsl.binders.every((binder) => binder.domain.kind === 'real');
  const visit = (ordinal, environment) => {
    if (witness) return;
    if (ordinal === dsl.binders.length) {
      checkedAssignments += 1;
      const evaluationEnvironment = exactIntegerArithmetic
        ? Object.fromEntries(Object.entries(environment).map(([name, value]) => (
          [name, BigInt(value)]
        ))) : environment;
      if (dsl.assumptions.every((assumption) => relationValue(
        assumption,
        evaluationEnvironment,
        exactIntegerArithmetic,
      )) && !relationValue(dsl.conclusion, evaluationEnvironment, exactIntegerArithmetic)) {
        witness = Object.freeze({ ...environment });
      }
      return;
    }
    const binder = dsl.binders[ordinal];
    for (const value of domains[ordinal].values) visit(ordinal + 1, { ...environment, [binder.name]: value });
  };
  visit(0, {});
  const completeFiniteDomain = domains.every((domain) => domain.complete);
  const payload = Object.freeze({
    status: witness
      ? 'bounded_counterexample_found'
      : completeFiniteDomain
        ? 'bounded_counterexample_absent_complete_finite_domain'
        : 'bounded_counterexample_search_inconclusive',
    reason: witness ? 'witness_evaluates_conclusion_false'
      : completeFiniteDomain ? 'all_finite_assignments_checked' : 'bounded_prefix_exhausted',
    checkedAssignments,
    completeFiniteDomain,
    witness,
    bounds,
  });
  return Object.freeze({ ...payload, resultHash: hashRecord('TypedTheoremCounterexampleSearch', payload) });
}
