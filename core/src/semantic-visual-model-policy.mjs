import { digest } from './hash-utils.mjs';

export const SEMANTIC_VISUAL_MODEL_POLICY_VERSION = 1;

export const SEMANTIC_VISUAL_MODEL_POLICY_SAFETY = Object.freeze({
  localPolicyOnly: true,
  callsProviderOrModel: false,
  fetchesChannelState: false,
  mutatesChannelState: false,
  grantsExecutionPermission: false,
});

export const DEFAULT_SEMANTIC_VISUAL_MODEL_ARG_KEYS = Object.freeze([
  'semantic-model',
  'visual-model',
]);

export const DEFAULT_SEMANTIC_VISUAL_MODEL_ENV_KEYS = Object.freeze([
  'SEMANTIC_VISUAL_MODEL',
  'IMAGE_SEMANTIC_MODEL',
  'FINAL_REVIEW_SEMANTIC_MODEL',
]);

export const DEFAULT_SEMANTIC_VISUAL_MODEL_ALLOW_ARG_KEYS = Object.freeze([
  'allow-semantic-model-override',
  'allow-semantic-visual-model-override',
  'allow-gpt-5-4-semantic',
]);

export const DEFAULT_SEMANTIC_VISUAL_MODEL_ALLOW_ENV_KEYS = Object.freeze([
  'ALLOW_SEMANTIC_MODEL_OVERRIDE',
  'ALLOW_SEMANTIC_VISUAL_MODEL_OVERRIDE',
  'ALLOW_GPT_5_4_SEMANTIC',
]);

export const DISALLOWED_SEMANTIC_VISUAL_MODEL_RE = /(?:^|[/:\s-])gpt-5\.4(?:$|[/:\s-]|-mini\b)/i;
export const DISALLOWED_SEMANTIC_VISUAL_MODEL_TIER_RE = /(?:^|[/:\s-])gpt-\d+(?:\.\d+)?-(?:mini|nano|small|lite)(?:$|[/:\s-])/i;
export const DEFAULT_SEMANTIC_VISUAL_MODEL_MINIMUM = Object.freeze({
  family: 'gpt',
  major: 5,
  minor: 5,
});

function boolish(value) {
  return value === true || value === 1 || ['1', 'true', 'yes', 'allow'].includes(String(value || '').toLowerCase());
}

function firstValue(keys = [], source = {}) {
  for (const key of keys) {
    if (Object.hasOwn(source, key) && source[key] !== undefined && source[key] !== null) return source[key];
  }
  return null;
}

function policyError(message, { code, step, model = null } = {}) {
  const error = new Error(message);
  error.code = code;
  error.step = step;
  if (model) error.model = model;
  return error;
}

function modelRank(model) {
  const match = String(model || '').match(/(?:^|[/:\s-])gpt-(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  return {
    family: 'gpt',
    major: Number(match[1]),
    minor: Number(match[2] || 0),
  };
}

function belowMinimumModel(rank, minimum) {
  if (!rank) return true;
  if (rank.family !== minimum.family) return true;
  if (rank.major !== minimum.major) return rank.major < minimum.major;
  return rank.minor < minimum.minor;
}

export function normalizeSemanticVisualModelPolicyOptions(options = {}) {
  return {
    step: options.step || 'semantic visual review',
    env: options.env || {},
    argKeys: options.argKeys || DEFAULT_SEMANTIC_VISUAL_MODEL_ARG_KEYS,
    envKeys: options.envKeys || DEFAULT_SEMANTIC_VISUAL_MODEL_ENV_KEYS,
    allowArgKeys: options.allowArgKeys || DEFAULT_SEMANTIC_VISUAL_MODEL_ALLOW_ARG_KEYS,
    allowEnvKeys: options.allowEnvKeys || DEFAULT_SEMANTIC_VISUAL_MODEL_ALLOW_ENV_KEYS,
    disallowedModelRe: options.disallowedModelRe || DISALLOWED_SEMANTIC_VISUAL_MODEL_RE,
    disallowedTierRe: options.disallowedTierRe || DISALLOWED_SEMANTIC_VISUAL_MODEL_TIER_RE,
    minimumModel: options.minimumModel || DEFAULT_SEMANTIC_VISUAL_MODEL_MINIMUM,
  };
}

export function resolveSemanticVisualModel(args = {}, options = {}) {
  const policy = normalizeSemanticVisualModelPolicyOptions(options);
  const raw = firstValue(policy.argKeys, args) ?? firstValue(policy.envKeys, policy.env);
  if (!raw || raw === true) {
    throw policyError(`${policy.step}: explicit --semantic-model is required; refusing openclaw-image default model routing`, {
      code: 'SEMANTIC_VISUAL_MODEL_REQUIRED',
      step: policy.step,
    });
  }
  const model = String(raw).trim();
  if (!model) {
    throw policyError(`${policy.step}: explicit --semantic-model is empty`, {
      code: 'SEMANTIC_VISUAL_MODEL_REQUIRED',
      step: policy.step,
    });
  }
  const allowed = policy.allowArgKeys.some((key) => boolish(args[key]))
    || policy.allowEnvKeys.some((key) => boolish(policy.env[key]));
  if (policy.disallowedModelRe.test(model) && !allowed) {
    throw policyError(`${policy.step}: ${model} is disallowed; refusing gpt-5.4 semantic visual route`, {
      code: 'SEMANTIC_VISUAL_MODEL_DISALLOWED',
      step: policy.step,
      model,
    });
  }
  if (policy.disallowedTierRe.test(model) && !allowed) {
    throw policyError(`${policy.step}: ${model} is disallowed; refusing mini/nano/small/lite semantic visual route`, {
      code: 'SEMANTIC_VISUAL_MODEL_TIER_DISALLOWED',
      step: policy.step,
      model,
    });
  }
  const rank = modelRank(model);
  if (!rank && !allowed) {
    throw policyError(`${policy.step}: ${model} is not a recognized GPT semantic visual model route`, {
      code: 'SEMANTIC_VISUAL_MODEL_UNRECOGNIZED',
      step: policy.step,
      model,
    });
  }
  if (belowMinimumModel(rank, policy.minimumModel) && !allowed) {
    throw policyError(`${policy.step}: ${model} is below the required gpt-${policy.minimumModel.major}.${policy.minimumModel.minor} semantic visual floor`, {
      code: 'SEMANTIC_VISUAL_MODEL_BELOW_MINIMUM',
      step: policy.step,
      model,
    });
  }
  return model;
}

export function semanticVisualModelBlockerCheck(error, { id = 'semantic_visual_model_policy', label = 'Semantic visual reviewer uses an explicitly approved model.' } = {}) {
  return {
    id,
    label,
    status: 'review',
    notes: error?.message || String(error || 'semantic visual model policy blocked'),
    blocking: true,
    source: 'semantic_visual_referee',
    appliesTo: 'package',
  };
}

export function semanticVisualModelPolicySelftest() {
  const missing = (() => {
    try {
      resolveSemanticVisualModel({}, { env: {}, step: 'selftest missing model' });
      return null;
    } catch (error) {
      return error;
    }
  })();
  const disallowed = (() => {
    try {
      resolveSemanticVisualModel({ 'semantic-model': 'openclaw/gpt-5.4-mini' }, { env: {}, step: 'selftest disallowed model' });
      return null;
    } catch (error) {
      return error;
    }
  })();
  const belowMinimum = (() => {
    try {
      resolveSemanticVisualModel({ 'semantic-model': 'openai/gpt-5.3' }, { env: {}, step: 'selftest below minimum model' });
      return null;
    } catch (error) {
      return error;
    }
  })();
  const disallowedTier = (() => {
    try {
      resolveSemanticVisualModel({ 'semantic-model': 'openai/gpt-5.5-mini' }, { env: {}, step: 'selftest disallowed tier model' });
      return null;
    } catch (error) {
      return error;
    }
  })();
  const unrecognized = (() => {
    try {
      resolveSemanticVisualModel({ 'semantic-model': 'legacy-semantic-default' }, { env: {}, step: 'selftest unrecognized model' });
      return null;
    } catch (error) {
      return error;
    }
  })();
  const explicit = resolveSemanticVisualModel({ 'semantic-model': 'openai/gpt-5.5' }, { env: {}, step: 'selftest explicit model' });
  const envModel = resolveSemanticVisualModel({}, { env: { SEMANTIC_VISUAL_MODEL: 'openai/gpt-5.5-pro' }, step: 'selftest env model' });
  const allowedDisallowed = resolveSemanticVisualModel({
    'semantic-model': 'openclaw/gpt-5.4-mini',
    'allow-gpt-5-4-semantic': true,
  }, { env: {}, step: 'selftest allow override' });
  const blocker = semanticVisualModelBlockerCheck(missing);
  const summary = {
    explicit,
    envModel,
    allowedDisallowed,
    missingCode: missing?.code || null,
    disallowedCode: disallowed?.code || null,
    belowMinimumCode: belowMinimum?.code || null,
    disallowedTierCode: disallowedTier?.code || null,
    unrecognizedCode: unrecognized?.code || null,
    blockerStatus: blocker.status,
    blockerBlocking: blocker.blocking === true,
  };
  const policyHash = digest({
    version: SEMANTIC_VISUAL_MODEL_POLICY_VERSION,
    summary,
    safety: SEMANTIC_VISUAL_MODEL_POLICY_SAFETY,
  });
  return {
    ok: missing?.code === 'SEMANTIC_VISUAL_MODEL_REQUIRED'
      && disallowed?.code === 'SEMANTIC_VISUAL_MODEL_DISALLOWED'
      && belowMinimum?.code === 'SEMANTIC_VISUAL_MODEL_BELOW_MINIMUM'
      && disallowedTier?.code === 'SEMANTIC_VISUAL_MODEL_TIER_DISALLOWED'
      && unrecognized?.code === 'SEMANTIC_VISUAL_MODEL_UNRECOGNIZED'
      && explicit === 'openai/gpt-5.5'
      && envModel === 'openai/gpt-5.5-pro'
      && allowedDisallowed === 'openclaw/gpt-5.4-mini'
      && blocker.blocking === true,
    version: SEMANTIC_VISUAL_MODEL_POLICY_VERSION,
    status: 'pass_semantic_visual_model_policy_selftest',
    summary,
    safety: SEMANTIC_VISUAL_MODEL_POLICY_SAFETY,
    policyHash,
  };
}
