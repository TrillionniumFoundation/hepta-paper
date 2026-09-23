import {
  buildFormalReadableProofExplanationBundle,
  verifyFormalReadableProofExplanationBundle,
} from '../../paper-domain/research/formal-readable-proof-contract.mjs';

export function certificateBundleFromFormalWorkerResult(result) {
  const {
    replayReceipt: _replayReceipt,
    formalCertificateReplayReceiptHash: _formalCertificateReplayReceiptHash,
    readableProofExplanationBundle: _readableProofExplanationBundle,
    formalReadableProofExplanationBundleHash: _formalReadableProofExplanationBundleHash,
    productionReadableProofExplanationReady: _productionReadableProofExplanationReady,
    ...certificateBundle
  } = result || {};
  return Object.freeze(certificateBundle);
}

export function independentlyVerifyFormalReadableProofWorkerResult(result, {
  required = false,
} = {}) {
  const blockers = [];
  const bundle = result?.readableProofExplanationBundle || null;
  if (!bundle) {
    if (required) blockers.push('formal_readable_proof_explanation_required');
    return Object.freeze({
      valid: blockers.length === 0,
      ready: false,
      blockers: Object.freeze(blockers),
    });
  }
  const certificateBundle = certificateBundleFromFormalWorkerResult(result);
  if (bundle.status === 'formal_readable_proof_explanation_bundle_blocked') {
    const rebuilt = buildFormalReadableProofExplanationBundle({
      certificateBundle,
      replayReceipt: result?.replayReceipt,
    });
    if (JSON.stringify(rebuilt) !== JSON.stringify(bundle)) {
      blockers.push('formal_readable_proof_blocked_bundle_rebuild_mismatch');
    }
    if (required) blockers.push('formal_readable_proof_explanation_required');
    return Object.freeze({
      valid: blockers.length === 0,
      ready: false,
      blockers: Object.freeze([...new Set(blockers)]),
    });
  }
  const verification = verifyFormalReadableProofExplanationBundle(bundle, {
    certificateBundle,
    replayReceipt: result?.replayReceipt,
  });
  blockers.push(...verification.blockers);
  if (result?.formalReadableProofExplanationBundleHash
      !== bundle.formalReadableProofExplanationBundleHash
    || result?.productionReadableProofExplanationReady !== verification.valid) {
    blockers.push('formal_readable_proof_worker_binding_invalid');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    ready: blockers.length === 0 && bundle.productionReadableProofReady === true,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}
