// Verification executable boundary for pinned formal tooling and exact code
// provenance. The bin layer consumes this narrow composition surface instead
// of binding infrastructure adapters directly.
export { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
export {
  resolvePinnedLakeExecutable,
} from '../../paper-adapters/research-verify/pinned-lake-executable-resolver.mjs';
