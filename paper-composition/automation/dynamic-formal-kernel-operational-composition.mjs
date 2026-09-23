// Pinned Lean resolution is an infrastructure binding; keep it out of the
// paper-core/bin process boundary and expose only the narrow resolver API.
export {
  resolvePinnedLakeExecutable,
} from '../../paper-adapters/research-verify/pinned-lake-executable-resolver.mjs';
