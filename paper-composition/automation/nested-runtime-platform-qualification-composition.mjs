import {
  verifyNestedRuntimePlatformQualification,
} from '../../paper-adapters/automation/nested-runtime-platform-qualification-verifier.mjs';

export function composeNestedRuntimePlatformQualificationVerification(options = {}) {
  return verifyNestedRuntimePlatformQualification(options);
}
