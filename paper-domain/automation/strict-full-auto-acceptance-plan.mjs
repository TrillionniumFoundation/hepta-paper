import {
  ABSOLUTE_PATH_FLAGS,
  FINAL_VERIFICATION_ARGUMENT_GRAMMAR,
  FINAL_VERIFICATION_INVOCATION_POLICY,
  FORBIDDEN_INVOCATION_ARGUMENTS,
  IDENTIFIER,
  ONLINE_TRANSITION_ID_ASSERTION,
  PRINCIPAL_REFERENCE_IDS,
  QUALIFICATION_PAPER_ID_ASSERTION,
  READINESS_ENVIRONMENT_REFERENCES,
  SHA256,
  STEP_ARGUMENT_GRAMMAR,
  STEP_INVOCATION_POLICY,
  STRICT_FULL_AUTO_ACCEPTANCE_FINAL_VERIFICATION_STEP_ID,
  STRICT_FULL_AUTO_ACCEPTANCE_REFERENCE_POLICY,
  STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER,
} from './strict-full-auto-acceptance-policy.mjs';
import { exactKeys, strictFullAutoAcceptanceHash } from './strict-full-auto-acceptance-primitives.mjs';

function assertReferenceBindings(bindings) {
  if (!Array.isArray(bindings)
    || bindings.length !== Object.keys(STRICT_FULL_AUTO_ACCEPTANCE_REFERENCE_POLICY).length) {
    throw new Error('strict_full_auto_acceptance_reference_set_incomplete');
  }
  const byId = new Map(bindings.map((binding) => [binding?.referenceId, binding]));
  if (byId.size !== bindings.length) {
    throw new Error('strict_full_auto_acceptance_reference_duplicate');
  }
  for (const [referenceId, requiredKind] of Object.entries(
    STRICT_FULL_AUTO_ACCEPTANCE_REFERENCE_POLICY,
  )) {
    const binding = byId.get(referenceId);
    if (!exactKeys(binding, [
      'referenceId', 'kind', 'subjectId', 'resolvedPath', 'identity',
      'contentHash', 'documentPins',
    ]) || binding.kind !== requiredKind || !IDENTIFIER.test(String(binding.subjectId || ''))
      || typeof binding.resolvedPath !== 'string' || !binding.resolvedPath.startsWith('/')
      || !SHA256.test(String(binding.identity || ''))
      || (['public-reference', 'private-configuration-reference'].includes(requiredKind)
        && !SHA256.test(String(binding.contentHash || '')))
      || (!['public-reference', 'private-configuration-reference'].includes(requiredKind)
        && binding.contentHash !== null)
      || !binding.documentPins || typeof binding.documentPins !== 'object'
      || Array.isArray(binding.documentPins)
      || (new Set([
        'research-author-principal',
        'formal-reviewer-principal',
        'formal-sandbox-runtime-config',
        'production-mathlib-build-authority-config',
        'autonomous-venue-profile-config',
        'autonomous-submission-metadata-config',
        'submission-portal-descriptor-config',
        'prior-art-service-config',
        'external-replay-config',
      ]).has(referenceId)
        && !SHA256.test(String(binding.documentPins.configurationHash || '')))
      || (referenceId === 'prior-art-service-config'
        && binding.documentPins.tokenEnvironmentVariable
          !== 'HEPTA_PRIOR_ART_SERVICE_TOKEN_FILE')
      || (referenceId === 'external-replay-config'
        && binding.documentPins.tokenEnvironmentVariable
          !== 'HEPTA_EXTERNAL_REPLAY_SERVICE_TOKEN_FILE')
      || (referenceId === 'formal-reviewer-principal'
        && (!exactKeys(binding.documentPins, [
          'configurationHash',
          'reviewerServiceTokenEnvironmentVariables',
        ])
          || !Array.isArray(
            binding.documentPins.reviewerServiceTokenEnvironmentVariables,
          )
          || binding.documentPins.reviewerServiceTokenEnvironmentVariables.length < 4
          || binding.documentPins.reviewerServiceTokenEnvironmentVariables.length > 16
          || new Set(
            binding.documentPins.reviewerServiceTokenEnvironmentVariables,
          ).size !== binding.documentPins.reviewerServiceTokenEnvironmentVariables.length
          || binding.documentPins.reviewerServiceTokenEnvironmentVariables.some(
            (name) => !/^[A-Z][A-Z0-9_]{1,122}_FILE$/.test(String(name || '')),
          )
          || JSON.stringify(
            [...binding.documentPins.reviewerServiceTokenEnvironmentVariables].sort(),
          ) !== JSON.stringify(
            binding.documentPins.reviewerServiceTokenEnvironmentVariables,
          )))
      || (referenceId === 'submission-portal-descriptor-config'
        && (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(String(
          binding.documentPins.portalId || '',
        )) || !SHA256.test(String(binding.documentPins.portalDescriptorHash || ''))))) {
      throw new Error(`strict_full_auto_acceptance_reference_invalid:${referenceId}`);
    }
  }
  const principalReferences = PRINCIPAL_REFERENCE_IDS.map((id) => byId.get(id));
  if (new Set(principalReferences.map((binding) => binding.resolvedPath)).size
      !== principalReferences.length
    || new Set(principalReferences.map((binding) => binding.contentHash)).size
      !== principalReferences.length) {
    throw new Error('strict_full_auto_acceptance_principal_reference_alias_forbidden');
  }
  const authorCredential = byId.get('research-author-credential-root');
  const reviewerCredential = byId.get('formal-reviewer-credential-root');
  if (authorCredential.subjectId === reviewerCredential.subjectId
    || pathsOverlap(authorCredential.resolvedPath, reviewerCredential.resolvedPath)
    || authorCredential.identity === reviewerCredential.identity) {
    throw new Error(
      'strict_full_auto_acceptance_provider_credential_root_independence_required',
    );
  }
  const reviewerServiceCredential = byId.get(
    'formal-reviewer-service-credential-root',
  );
  if ([
    authorCredential,
    reviewerCredential,
  ].some((binding) => (
    reviewerServiceCredential.subjectId === binding.subjectId
    || pathsOverlap(reviewerServiceCredential.resolvedPath, binding.resolvedPath)
    || reviewerServiceCredential.identity === binding.identity
  ))) {
    throw new Error(
      'strict_full_auto_acceptance_reviewer_service_credential_root_independence_required',
    );
  }
  return Object.freeze([...bindings].sort((left, right) => (
    left.referenceId.localeCompare(right.referenceId)
  )).map((binding) => Object.freeze({ ...binding })));
}

function assertJsonAssertion(assertion, label) {
  if (!exactKeys(assertion, ['path', 'equals'])
    || typeof assertion.path !== 'string' || !assertion.path.startsWith('/')
    || assertion.path.includes('~') || assertion.equals === undefined
    || (assertion.equals !== null && typeof assertion.equals === 'object')) {
    throw new Error(`strict_full_auto_acceptance_assertion_invalid:${label}`);
  }
  return Object.freeze({ path: assertion.path, equals: assertion.equals });
}

function assertInvocationPolicy(invocation, stepId, phase, label, {
  policyOverride = null,
  grammarOverride = null,
} = {}) {
  const policy = policyOverride || STEP_INVOCATION_POLICY[stepId]?.[phase];
  const grammar = grammarOverride || STEP_ARGUMENT_GRAMMAR[stepId]?.[phase];
  const flags = invocation.arguments.filter((argument) => argument.startsWith('--'));
  const flagCounts = flags.reduce((counts, flag) => counts.set(
    flag, (counts.get(flag) || 0) + 1,
  ), new Map());
  const repeatableValueFlags = new Set(policy?.repeatableValueFlags || []);
  if (!policy || invocation.command !== policy.command
    || [...flagCounts].some(([flag, count]) => count > 1 && !repeatableValueFlags.has(flag))
    || invocation.arguments.some((argument) => FORBIDDEN_INVOCATION_ARGUMENTS.has(argument)
      || /REPLACE|PLACEHOLDER|<[^>]+>/i.test(argument))
    || policy.requiredArguments.some((argument) => !invocation.arguments.includes(argument))
    || (policy.exactArguments
      && invocation.arguments.join('\0') !== policy.requiredArguments.join('\0'))
    || Object.keys(invocation.environmentReferences).sort().join('\0')
      !== Object.keys(policy.environmentReferences).sort().join('\0')
    || Object.entries(policy.environmentReferences).some(([name, referenceId]) => (
      invocation.environmentReferences[name] !== referenceId
    ))
    || invocation.assertions.length !== policy.assertions.length
    || policy.assertions.some(([assertionPath, expected], index) => {
      const actual = invocation.assertions[index];
      return actual?.path !== assertionPath
        || (expected === QUALIFICATION_PAPER_ID_ASSERTION
          ? !IDENTIFIER.test(String(actual?.equals || ''))
          : expected === ONLINE_TRANSITION_ID_ASSERTION
            ? !SHA256.test(String(actual?.equals || ''))
          : actual?.equals !== expected);
    })) {
    throw new Error(`strict_full_auto_acceptance_invocation_policy_mismatch:${label}`);
  }
  for (const flag of policy.requiredSha256ValueFlags || []) {
    const index = invocation.arguments.indexOf(flag);
    if (index < 0 || !SHA256.test(String(invocation.arguments[index + 1] || ''))) {
      throw new Error(`strict_full_auto_acceptance_invocation_policy_mismatch:${label}:${flag}`);
    }
  }
  if (policy.planHashValueFlag) {
    const index = invocation.arguments.indexOf(policy.planHashValueFlag);
    if (index < 0 || invocation.arguments[index + 1] !== '@acceptance-plan-hash') {
      throw new Error(
        `strict_full_auto_acceptance_invocation_policy_mismatch:${label}:plan_hash`,
      );
    }
  }
  if (grammar) {
    const booleanFlags = new Set(grammar.booleanFlags);
    const valueFlags = new Set(grammar.valueFlags);
    const expectedFlags = [...booleanFlags, ...valueFlags].sort();
    if ([...new Set(flags)].sort().join('\0') !== expectedFlags.join('\0')) {
      throw new Error(`strict_full_auto_acceptance_argument_grammar_invalid:${label}:flag_set`);
    }
    for (let index = 0; index < invocation.arguments.length;) {
      const argument = invocation.arguments[index];
      if (booleanFlags.has(argument)) {
        index += 1;
      } else if (valueFlags.has(argument)) {
        const value = invocation.arguments[index + 1];
        if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
          throw new Error(`strict_full_auto_acceptance_argument_grammar_invalid:${label}`);
        }
        if (ABSOLUTE_PATH_FLAGS.has(argument) && !value.startsWith('/')) {
          throw new Error(`strict_full_auto_acceptance_argument_path_invalid:${label}:${argument}`);
        }
        index += 2;
      } else {
        throw new Error(`strict_full_auto_acceptance_argument_grammar_invalid:${label}:${argument}`);
      }
    }
  }
  const limitIndex = invocation.arguments.indexOf('--limit');
  if (limitIndex >= 0) {
    const limit = Number(invocation.arguments[limitIndex + 1]);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error(`strict_full_auto_acceptance_argument_limit_invalid:${label}`);
    }
  }
  for (const [flag, expected] of Object.entries(policy.requiredFlagValues || {})) {
    const index = invocation.arguments.indexOf(flag);
    if (index < 0 || invocation.arguments[index + 1] !== expected) {
      throw new Error(`strict_full_auto_acceptance_invocation_policy_mismatch:${label}:${flag}`);
    }
  }
  for (const flag of policy.requiredValueFlags || []) {
    const index = invocation.arguments.indexOf(flag);
    const value = invocation.arguments[index + 1];
    if (index < 0 || typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new Error(`strict_full_auto_acceptance_invocation_policy_mismatch:${label}:${flag}`);
    }
  }
  for (const [flag, expectedValues] of Object.entries(
    policy.requiredRepeatedFlagValues || {},
  )) {
    const actualValues = invocation.arguments.flatMap((argument, index) => (
      argument === flag ? [invocation.arguments[index + 1]] : []
    ));
    if (JSON.stringify(actualValues) !== JSON.stringify(expectedValues)) {
      throw new Error(
        `strict_full_auto_acceptance_invocation_policy_mismatch:${label}:${flag}`,
      );
    }
  }
}

function assertInvocation(invocation, stepId, phase, label, policyOptions = {}) {
  if (!exactKeys(invocation, [
    'command', 'arguments', 'environmentReferences', 'assertions',
  ]) || !IDENTIFIER.test(String(invocation.command || ''))
    || !Array.isArray(invocation.arguments)
    || invocation.arguments.some((item) => typeof item !== 'string' || item.length === 0)
    || !invocation.environmentReferences
    || typeof invocation.environmentReferences !== 'object'
    || Array.isArray(invocation.environmentReferences)
    || !Array.isArray(invocation.assertions) || invocation.assertions.length === 0) {
    throw new Error(`strict_full_auto_acceptance_invocation_invalid:${label}`);
  }
  const environmentReferences = exactKeys(invocation.environmentReferences, ['@profile'])
    && invocation.environmentReferences['@profile'] === 'readiness'
    ? READINESS_ENVIRONMENT_REFERENCES : invocation.environmentReferences;
  for (const [name, referenceId] of Object.entries(environmentReferences)) {
    if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(name)
      || !(referenceId in STRICT_FULL_AUTO_ACCEPTANCE_REFERENCE_POLICY)
      || (/(TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$/.test(name)
        && !/(FILE|PATH|CONFIG|REFERENCE)$/.test(name))) {
      throw new Error(`strict_full_auto_acceptance_environment_reference_invalid:${label}:${name}`);
    }
  }
  const normalizedInvocation = Object.freeze({ ...invocation, environmentReferences });
  assertInvocationPolicy(normalizedInvocation, stepId, phase, label, policyOptions);
  return Object.freeze({
    command: invocation.command,
    arguments: Object.freeze([...invocation.arguments]),
    environmentReferences: Object.freeze({ ...environmentReferences }),
    assertions: Object.freeze(invocation.assertions.map((item, index) => (
      assertJsonAssertion(item, `${label}:${index}`)
    ))),
  });
}

function assertSteps(steps) {
  if (!Array.isArray(steps) || steps.length !== STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER.length) {
    throw new Error('strict_full_auto_acceptance_step_set_incomplete');
  }
  return Object.freeze(steps.map((step, index) => {
    const expectedId = STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER[index];
    if (!exactKeys(step, ['stepId', 'idempotencyKey', 'execute', 'verify'])
      || step.stepId !== expectedId || !SHA256.test(String(step.idempotencyKey || ''))) {
      throw new Error(`strict_full_auto_acceptance_step_invalid:${expectedId}`);
    }
    const execute = assertInvocation(
      step.execute,
      expectedId,
      'execute',
      `${expectedId}:execute`,
    );
    const verify = assertInvocation(step.verify, expectedId, 'verify', `${expectedId}:verify`);
    for (const [phase, invocation] of [['execute', execute], ['verify', verify]]) {
      const idempotencyValueFlag = STEP_INVOCATION_POLICY[expectedId][phase]
        .idempotencyValueFlag;
      if (idempotencyValueFlag) {
        const argumentIndex = invocation.arguments.indexOf(idempotencyValueFlag);
        if (argumentIndex < 0
          || invocation.arguments[argumentIndex + 1] !== step.idempotencyKey) {
          throw new Error(
            `strict_full_auto_acceptance_child_idempotency_mismatch:${expectedId}:${phase}`,
          );
        }
      }
    }
    return Object.freeze({
      stepId: expectedId,
      idempotencyKey: step.idempotencyKey,
      execute,
      verify,
    });
  }));
}

const ROOT_BINDING_ACCESS_MODES = Object.freeze({
  'control-root': 'read-write',
  'runtime-root': 'read-write',
  'asset-root': 'read-only',
  'dataset-root': 'read-only',
});
const ROOT_BINDING_IDS = Object.freeze(Object.keys(ROOT_BINDING_ACCESS_MODES));
const REQUIRED_OPERATIONAL_ENVIRONMENT_KEYS = Object.freeze([
  'HEPTA_RESEARCH_AUTHOR_PROVIDER',
  'HEPTA_RESEARCH_AUTHOR_CODEX_BINARY',
  'HEPTA_RESEARCH_AUTHOR_MODEL',
  'HEPTA_FORMAL_REVIEW_PROVIDER',
  'HEPTA_FORMAL_REVIEW_CODEX_BINARY',
  'HEPTA_FORMAL_REVIEW_MODEL',
  'HEPTA_RESEARCH_AUTHOR_MAXIMUM_COST_PER_CALL_USD',
  'HEPTA_FORMAL_REVIEWER_MAXIMUM_COST_PER_CALL_USD',
  'HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT',
  'HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_ACTIVATION_POINTER',
  'HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE',
  'HEPTA_DYNAMIC_FORMAL_CLAIMS_ENABLED',
  'HEPTA_FORMAL_ELAN_HOME',
  'HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT',
  'HEPTA_DYNAMIC_FORMAL_PROJECT_SCOPE_ROOT',
  'HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH',
  'HEPTA_DYNAMIC_FORMAL_PROJECT_PROBE',
  'HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT',
]);

function assertOperationalEnvironment(environment) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new Error('strict_full_auto_acceptance_operational_environment_invalid');
  }
  const entries = Object.entries(environment);
  if (entries.length !== REQUIRED_OPERATIONAL_ENVIRONMENT_KEYS.length
    || entries.some(([name]) => !REQUIRED_OPERATIONAL_ENVIRONMENT_KEYS.includes(name))) {
    throw new Error('strict_full_auto_acceptance_operational_environment_invalid');
  }
  if (REQUIRED_OPERATIONAL_ENVIRONMENT_KEYS.some((name) => (
    !Object.prototype.hasOwnProperty.call(environment, name)
  )) || environment.HEPTA_RESEARCH_AUTHOR_PROVIDER !== 'codex'
    || environment.HEPTA_FORMAL_REVIEW_PROVIDER !== 'codex'
    || environment.HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE !== 'agent-evidence-bound'
    || environment.HEPTA_DYNAMIC_FORMAL_CLAIMS_ENABLED !== 'true'
    || [
      'HEPTA_RESEARCH_AUTHOR_CODEX_BINARY',
      'HEPTA_FORMAL_REVIEW_CODEX_BINARY',
      'HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT',
      'HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_ACTIVATION_POINTER',
      'HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT',
      'HEPTA_FORMAL_ELAN_HOME',
      'HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT',
      'HEPTA_DYNAMIC_FORMAL_PROJECT_SCOPE_ROOT',
    ].some((name) => !String(environment[name] || '').startsWith('/'))
    || !SHA256.test(environment.HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH)
    || !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,255}\.lean$/.test(
      environment.HEPTA_DYNAMIC_FORMAL_PROJECT_PROBE,
    )
    || environment.HEPTA_DYNAMIC_FORMAL_PROJECT_PROBE.split('/').includes('..')
    || !environment.HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT.startsWith(
      `${environment.HEPTA_DYNAMIC_FORMAL_PROJECT_SCOPE_ROOT}/`,
    )
    || [
      'HEPTA_RESEARCH_AUTHOR_MAXIMUM_COST_PER_CALL_USD',
      'HEPTA_FORMAL_REVIEWER_MAXIMUM_COST_PER_CALL_USD',
    ].some((name) => !Number.isFinite(Number(environment[name]))
      || Number(environment[name]) <= 0)) {
    throw new Error('strict_full_auto_acceptance_operational_environment_incomplete');
  }
  for (const [name, value] of entries) {
    if (!/^HEPTA_[A-Z0-9_]{2,127}$/.test(name)
      || /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|KEY|AUTH|COOKIE|SESSION)(?:_|$)/
        .test(name)
      || ['HEPTA_PAPER_RUNTIME_ROOT', 'HEPTA_PAPER_ASSET_ROOT',
        'HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_CONTROL_ROOT',
        'HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH',
        'HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY'].includes(name)
      || typeof value !== 'string' || value.length === 0 || value.length > 4096
      || /REPLACE|PLACEHOLDER|<[^>]+>/i.test(value)) {
      throw new Error(`strict_full_auto_acceptance_operational_environment_invalid:${name}`);
    }
  }
  return Object.freeze(Object.fromEntries(entries.sort(([left], [right]) => (
    left.localeCompare(right)
  ))));
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function assertRootBindings({ controlRoot, runtimeRoot, assetRoot, datasetRoot, rootBindings }) {
  const roots = {
    'control-root': controlRoot,
    'runtime-root': runtimeRoot,
    'asset-root': assetRoot,
    'dataset-root': datasetRoot,
  };
  if (!Array.isArray(rootBindings) || rootBindings.length !== ROOT_BINDING_IDS.length
    || ROOT_BINDING_IDS.some((rootId, index) => rootBindings[index]?.rootId !== rootId)
    || Object.values(roots).some((candidate) => typeof candidate !== 'string'
      || !candidate.startsWith('/') || candidate === '/')) {
    throw new Error('strict_full_auto_acceptance_root_binding_set_invalid');
  }
  const selectedRoots = Object.values(roots);
  for (let left = 0; left < selectedRoots.length; left += 1) {
    for (let right = left + 1; right < selectedRoots.length; right += 1) {
      if (pathsOverlap(selectedRoots[left], selectedRoots[right])) {
        throw new Error('strict_full_auto_acceptance_roots_overlap');
      }
    }
  }
  return Object.freeze(rootBindings.map((binding) => {
    if (!exactKeys(binding, [
      'rootId', 'accessMode', 'resolvedPath', 'anchorKind', 'anchorPath', 'anchorRealPath',
      'anchorDevice', 'anchorInode', 'anchorMode', 'anchorUid', 'anchorGid', 'identity',
    ]) || binding.accessMode !== ROOT_BINDING_ACCESS_MODES[binding.rootId]
      || binding.resolvedPath !== roots[binding.rootId]
      || !['parent', 'target'].includes(binding.anchorKind)
      || typeof binding.anchorPath !== 'string' || !binding.anchorPath.startsWith('/')
      || typeof binding.anchorRealPath !== 'string' || !binding.anchorRealPath.startsWith('/')
      || !/^\d+$/.test(String(binding.anchorDevice || ''))
      || !/^\d+$/.test(String(binding.anchorInode || ''))
      || !Number.isSafeInteger(binding.anchorMode) || binding.anchorMode < 0
      || !/^\d+$/.test(String(binding.anchorUid || ''))
      || !/^\d+$/.test(String(binding.anchorGid || ''))
      || !SHA256.test(String(binding.identity || ''))) {
      throw new Error(`strict_full_auto_acceptance_root_binding_invalid:${binding?.rootId}`);
    }
    return Object.freeze({ ...binding });
  }));
}

function assertFinalVerification(invocation) {
  return assertInvocation(
    invocation,
    STRICT_FULL_AUTO_ACCEPTANCE_FINAL_VERIFICATION_STEP_ID,
    'verify',
    STRICT_FULL_AUTO_ACCEPTANCE_FINAL_VERIFICATION_STEP_ID,
    {
      policyOverride: FINAL_VERIFICATION_INVOCATION_POLICY,
      grammarOverride: FINAL_VERIFICATION_ARGUMENT_GRAMMAR,
    },
  );
}

export function buildStrictFullAutoAcceptancePlan({
  configurationHash,
  controlRoot,
  runtimeRoot,
  assetRoot,
  datasetRoot,
  rootBindings,
  operationalEnvironment,
  referenceBindings,
  steps,
  finalVerification,
} = {}) {
  if (!SHA256.test(String(configurationHash || ''))
    || typeof controlRoot !== 'string' || !controlRoot.startsWith('/')
    || typeof runtimeRoot !== 'string' || !runtimeRoot.startsWith('/')
    || typeof assetRoot !== 'string' || !assetRoot.startsWith('/')
    || typeof datasetRoot !== 'string' || !datasetRoot.startsWith('/')) {
    throw new Error('strict_full_auto_acceptance_plan_input_invalid');
  }
  const verifiedRootBindings = assertRootBindings({
    controlRoot, runtimeRoot, assetRoot, datasetRoot, rootBindings,
  });
  const verifiedSteps = assertSteps(steps);
  const verifiedFinalVerification = assertFinalVerification(finalVerification);
  const stepById = new Map(verifiedSteps.map((step) => [step.stepId, step]));
  const flagValue = (invocation, flag) => {
    const index = invocation.arguments.indexOf(flag);
    return index < 0 ? null : invocation.arguments[index + 1];
  };
  const assertionValue = (invocation, pointer) => invocation.assertions
    .find((assertion) => assertion.path === pointer)?.equals ?? null;
  const externalQualification = stepById.get('external-qualifier');
  const goldenQualification = stepById.get('golden-qualification');
  const productionQualification = stepById.get('production-campaign-qualification');
  const genericConvergence = stepById.get('generic-domain-capability-convergence');
  const qualificationPaperId = flagValue(externalQualification.execute, '--paper-id');
  if (!IDENTIFIER.test(String(qualificationPaperId || ''))
    || flagValue(externalQualification.verify, '--paper-id') !== qualificationPaperId
    || flagValue(goldenQualification.execute, '--paper-id') !== qualificationPaperId
    || assertionValue(externalQualification.execute, '/campaign/paperId')
      !== qualificationPaperId
    || assertionValue(externalQualification.verify, '/campaign/paperId')
      !== qualificationPaperId
    || assertionValue(goldenQualification.execute, '/campaign/paperId')
      !== qualificationPaperId
    || assertionValue(goldenQualification.verify, '/fullResearchQualification/paperId')
      !== qualificationPaperId
    || assertionValue(verifiedFinalVerification, '/fullResearchQualification/paperId')
      !== qualificationPaperId) {
    throw new Error('strict_full_auto_acceptance_qualification_paper_binding_invalid');
  }
  const productionPaperPointers = [
    '/autonomousResearchAgendaAuthorityInspection/paperId',
    '/experimentIrExecutionAuthorityInspection/paperId',
    '/autonomousResearchVenueRequirementAuthorityInspection/paperId',
    '/autonomousResearchAssuranceAuthorityInspection/paperId',
  ];
  const productionPaperId = assertionValue(
    productionQualification.verify,
    productionPaperPointers[0],
  );
  if (!IDENTIFIER.test(String(productionPaperId || ''))
    || productionPaperId === qualificationPaperId
    || productionPaperPointers.some((pointer) => (
      assertionValue(productionQualification.verify, pointer) !== productionPaperId
    ))
    || flagValue(genericConvergence.execute, '--paper-id') !== productionPaperId
    || flagValue(genericConvergence.verify, '--paper-id') !== productionPaperId
    || assertionValue(genericConvergence.execute, '/paperId') !== productionPaperId
    || assertionValue(genericConvergence.verify, '/paperId') !== productionPaperId) {
    throw new Error('strict_full_auto_acceptance_production_paper_binding_invalid');
  }
  const canonical = Object.freeze({
    version: 1,
    kind: 'StrictFullAutoAcceptancePlan',
    configurationHash,
    controlRoot,
    runtimeRoot,
    assetRoot,
    datasetRoot,
    qualificationPaperId,
    rootBindings: verifiedRootBindings,
    operationalEnvironment: assertOperationalEnvironment(operationalEnvironment),
    referenceBindings: assertReferenceBindings(referenceBindings),
    steps: verifiedSteps,
    finalVerification: verifiedFinalVerification,
    zeroSkipRequired: true,
    privateKeyMaterialHandled: false,
    selfSignedAuthorityPermitted: false,
  });
  const references = new Map(canonical.referenceBindings.map((item) => [item.referenceId, item]));
  for (const step of canonical.steps) {
    for (const phase of ['execute', 'verify']) {
      const policy = STEP_INVOCATION_POLICY[step.stepId][phase];
      for (const [flag, referenceId] of Object.entries(policy.argumentReferenceFlags || {})) {
        const index = step[phase].arguments.indexOf(flag);
        if (index < 0 || step[phase].arguments[index + 1]
          !== references.get(referenceId)?.resolvedPath) {
          throw new Error(
            `strict_full_auto_acceptance_argument_reference_mismatch:${step.stepId}:${phase}:${flag}`,
          );
        }
      }
      for (const name of Object.keys(step[phase].environmentReferences)) {
        if (Object.prototype.hasOwnProperty.call(canonical.operationalEnvironment, name)) {
          throw new Error(`strict_full_auto_acceptance_environment_binding_conflict:${name}`);
        }
      }
    }
  }
  const runtimeStep = stepById.get('runtime-reproducibility');
  const receiptPath = canonical.operationalEnvironment
    .HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT;
  if (flagValue(runtimeStep.execute, '--receipt') !== receiptPath
    || flagValue(runtimeStep.verify, '--receipt') !== receiptPath) {
    throw new Error('strict_full_auto_acceptance_runtime_receipt_path_mismatch');
  }
  const activationStep = stepById.get('advanced-numeric-activation');
  const activationPointer = canonical.operationalEnvironment
    .HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_ACTIVATION_POINTER;
  if (flagValue(activationStep.execute, '--activation') !== activationPointer
    || flagValue(activationStep.verify, '--activation') !== activationPointer) {
    throw new Error('strict_full_auto_acceptance_activation_pointer_path_mismatch');
  }
  const operationalDatasetRoot = canonical.operationalEnvironment
    .HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT;
  if (flagValue(stepById.get('state-provisioning').execute, '--dataset-root')
      !== canonical.datasetRoot
    || operationalDatasetRoot !== canonical.datasetRoot) {
    throw new Error('strict_full_auto_acceptance_dataset_root_binding_mismatch');
  }
  const stateProvisioningTransitionId = assertionValue(
    stepById.get('state-provisioning').verify,
    '/plan/transitionId',
  );
  const onlineTransition = stepById.get('online-transition');
  if (stateProvisioningTransitionId !== onlineTransition.idempotencyKey
    || flagValue(onlineTransition.execute, '--transition-id')
      !== stateProvisioningTransitionId) {
    throw new Error('strict_full_auto_acceptance_online_transition_id_binding_mismatch');
  }
  const portal = references.get('submission-portal-descriptor-config');
  const submission = stepById.get('submission-dispatcher');
  for (const invocation of [submission.execute, submission.verify]) {
    if (flagValue(invocation, '--portal-id') !== portal.documentPins.portalId
      || flagValue(invocation, '--portal-configuration-hash')
        !== portal.documentPins.configurationHash
      || flagValue(invocation, '--portal-descriptor-hash')
        !== portal.documentPins.portalDescriptorHash) {
      throw new Error('strict_full_auto_acceptance_submission_portal_binding_mismatch');
    }
  }
  return Object.freeze({ ...canonical, planHash: strictFullAutoAcceptanceHash(canonical) });
}

export function verifyStrictFullAutoAcceptancePlan(plan) {
  if (!exactKeys(plan, [
    'version', 'kind', 'configurationHash', 'controlRoot', 'runtimeRoot', 'assetRoot', 'datasetRoot',
    'qualificationPaperId', 'rootBindings', 'operationalEnvironment', 'referenceBindings', 'steps',
    'finalVerification', 'zeroSkipRequired', 'privateKeyMaterialHandled',
    'selfSignedAuthorityPermitted', 'planHash',
  ]) || !SHA256.test(String(plan.planHash || ''))) {
    throw new Error('strict_full_auto_acceptance_plan_invalid');
  }
  const rebuilt = buildStrictFullAutoAcceptancePlan(plan);
  if (rebuilt.planHash !== plan.planHash) {
    throw new Error('strict_full_auto_acceptance_plan_hash_mismatch');
  }
  return rebuilt;
}
