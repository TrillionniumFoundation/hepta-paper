import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  PROCESS_ISOLATED_RAW_EVENT_RECOMPUTATION_ASSURANCE_SCOPE,
  verifyProcessIsolatedRawEventRecomputationAssurance,
} from '../research-verify/process-isolated-system-benchmark-recomputation.mjs';

export function buildIndependentRecomputationAssurance({
  producerManifest,
  processAssurance,
  producerImplementationHash,
  recomputationInput,
  versionedExperimentIrHash,
} = {}) {
  const processAssuranceVerified = verifyProcessIsolatedRawEventRecomputationAssurance(
    processAssurance,
    recomputationInput,
  );
  const independentManifest = processAssurance?.workerReceipt?.manifest || null;
  const sameManifest = JSON.stringify(producerManifest) === JSON.stringify(independentManifest);
  const blockers = Object.freeze([
    ...(processAssuranceVerified
      && independentManifest?.status === 'raw_event_recomputation_verified'
      && Array.isArray(independentManifest.blockers)
      && independentManifest.blockers.length === 0
      ? [] : ['independent_raw_event_recomputation_blocked']),
    ...(sameManifest ? [] : ['independent_raw_event_recomputation_manifest_mismatch']),
  ]);
  const payload = {
    version: 2,
    kind: 'IndependentRawEventRecomputationAssurance',
    status: blockers.length
      ? 'independent_raw_event_recomputation_assurance_blocked'
      : 'independent_raw_event_recomputation_assurance_verified',
    assuranceScope: PROCESS_ISOLATED_RAW_EVENT_RECOMPUTATION_ASSURANCE_SCOPE,
    producerManifestHash: producerManifest?.rawEventRecomputationManifestHash || null,
    independentManifestHash:
      independentManifest?.rawEventRecomputationManifestHash || null,
    producerImplementationHash,
    verifierImplementationHash:
      processAssurance?.workerImplementationHash || null,
    independenceContractHash:
      processAssurance?.processIsolatedRawEventRecomputationAssuranceHash || null,
    maximumAbsoluteResidual: Number(independentManifest?.maximumAbsoluteResidual),
    processIndependent: processAssuranceVerified,
    processIsolatedRawEventRecomputationAssurance: processAssurance || null,
    processIsolatedWorkerReceiptHash: processAssurance?.workerReceiptHash || null,
    processIsolatedWorkerImplementationSourceHash:
      processAssurance?.workerImplementationSourceHash || null,
    processIsolatedWorkerPid: processAssurance?.workerPid || null,
    versionedExperimentIrHash,
    blockers,
  };
  return Object.freeze({
    ...payload,
    independentRawEventRecomputationAssuranceHash: hashRecord(
      'IndependentRawEventRecomputationAssurance',
      payload,
    ),
  });
}
