import {
  normalizeContainerImageDigest,
} from '../runtime/sandbox-backend-probe.mjs';

export function createPinnedFormalSandboxRuntime({ image, imageDigest } = {}) {
  const normalizedImage = String(image || '').trim();
  const normalizedDigest = normalizeContainerImageDigest(imageDigest);
  const referenceDigest = normalizeContainerImageDigest(normalizedImage.split('@').at(-1));
  const blockers = [];
  if (!normalizedImage) blockers.push('formal_sandbox_runtime_image_required');
  if (!normalizedDigest) blockers.push('formal_sandbox_runtime_image_digest_invalid');
  if (!referenceDigest) blockers.push('formal_sandbox_runtime_image_reference_not_digest_pinned');
  if (normalizedDigest && referenceDigest && normalizedDigest !== referenceDigest) {
    blockers.push('formal_sandbox_runtime_image_digest_mismatch');
  }
  if (blockers.length) {
    throw new Error(`formal_sandbox_runtime_invalid:${blockers.join(',')}`);
  }
  return Object.freeze({
    version: 1,
    kind: 'PinnedFormalSandboxRuntime',
    image: normalizedImage,
    imageDigest: normalizedDigest,
  });
}
