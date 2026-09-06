// Unicode-scalar guard around the frozen Candidate Router V1 core.
//
// The core orders legal object keys by unsigned UTF-8 bytes. UTF-8 is a total,
// injective encoding only for Unicode scalar-value strings; JavaScript also
// admits isolated UTF-16 surrogate code units, which Buffer.from replaces with
// U+FFFD. Reject those units before any V1 capture or hash operation so two
// distinct accepted keys can never compare equal while serializing differently.
import * as core from './candidate-router-v1-core.mjs';

export const CANDIDATE_ROUTER_INPUT_BOUNDARY = core.CANDIDATE_ROUTER_INPUT_BOUNDARY;

const MAX_SCAN_NODES = 131072;
const MAX_SCAN_DEPTH = 64;

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

function assertScalarGraph(value, state = { nodes: 0, stack: new WeakSet() }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_SCAN_NODES || depth > MAX_SCAN_DEPTH) {
    throw failure('candidate_unicode_scan_limit');
  }
  if (typeof value === 'string') {
    if (hasUnpairedSurrogate(value)) throw failure('candidate_value_string_invalid');
    return;
  }
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
  if (state.stack.has(value)) return; // The V1 core still owns cycle rejection.
  state.stack.add(value);
  try {
    let descriptors;
    let keys;
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
      keys = Reflect.ownKeys(value);
    } catch {
      return; // The V1 core emits its existing typed reflection failure.
    }
    for (const key of keys) {
      if (typeof key === 'string' && hasUnpairedSurrogate(key)) {
        throw failure('candidate_value_key_invalid');
      }
      const descriptor = descriptors[key];
      if (descriptor && Object.hasOwn(descriptor, 'value')) {
        assertScalarGraph(descriptor.value, state, depth + 1);
      }
    }
  } finally {
    state.stack.delete(value);
  }
}

export function sealPlanningModuleQualificationMetadataV1(value) {
  assertScalarGraph(value);
  return core.sealPlanningModuleQualificationMetadataV1(value);
}

export function capturePlanningModuleQualificationMetadataSetV1(value) {
  assertScalarGraph(value);
  return core.capturePlanningModuleQualificationMetadataSetV1(value);
}

export function sealActionCandidateV1(value) {
  assertScalarGraph(value);
  return core.sealActionCandidateV1(value);
}

export function routeActionCandidatesV1(value) {
  assertScalarGraph(value);
  return core.routeActionCandidatesV1(value);
}
