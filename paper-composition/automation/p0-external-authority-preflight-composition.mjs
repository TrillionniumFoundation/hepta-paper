// Read-only P0 inspection composition. Keep governance/runtime adapter
// bindings behind the composition boundary used by the executable.
export {
  loadCapabilityConformanceProofs,
  loadCapabilityOperationalProofs,
} from '../../paper-adapters/governance/capability-proof-verifier.mjs';
export { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
