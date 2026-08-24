import { verifyDeepLearningIndependentReplayReceipt } from '../../paper-adapters/research-verify/deep-learning-independent-replay.mjs';
import {
  GPU_REPLAY_SCOPES,
  verifyGpuReplayReceipt,
} from '../research/p0-pde-dl-assurance/gpu-replay-assurance-contract.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40,64}$/u;
const KIND = 'PersonalSelfHostedGpuScientificReceiptBundle';
const PROFILE_ID = 'personal-self-hosted-v1';
const RECEIPT_KEYS = Object.freeze([
  'deepLearningReplayReceipt', 'externalActionPerformed', 'kind', 'observedAt',
  'pdeReplayReceipt', 'personalSelfHostedGpuScientificReceiptBundleHash',
  'productionPromotionEligible', 'profileId', 'releaseCommit', 'scientificChecksPassed',
  'secondHardwareReplayDiagnostic', 'status', 'version',
]);

function validHash(value) {
  return SHA256.test(String(value || ''));
}

function instant(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validSecondHardwareDiagnostic(value) {
  return hasExactObjectKeys(value, ['evidenceHash', 'status'])
    && ['not_required_personal_profile', 'verified_optional_diagnostic'].includes(value.status)
    && (value.evidenceHash === null || validHash(value.evidenceHash));
}

function validNestedReceipts({ pdeReplayReceipt, deepLearningReplayReceipt }) {
  return verifyGpuReplayReceipt(pdeReplayReceipt)
    && pdeReplayReceipt.replayScope === GPU_REPLAY_SCOPES.sameDevice
    && pdeReplayReceipt.scientificChecksPassed === true
    && pdeReplayReceipt.productionPromotionEligible === false
    && verifyDeepLearningIndependentReplayReceipt(deepLearningReplayReceipt)
    && deepLearningReplayReceipt.replayScope === 'same-device-gpu-v1'
    && deepLearningReplayReceipt.scientificChecksPassed === true
    && deepLearningReplayReceipt.productionPromotionEligible === false;
}

export function buildPersonalSelfHostedGpuScientificReceiptBundle({
  releaseCommit,
  observedAt,
  pdeReplayReceipt,
  deepLearningReplayReceipt,
  secondHardwareReplayDiagnostic = Object.freeze({
    status: 'not_required_personal_profile',
    evidenceHash: null,
  }),
} = {}) {
  if (!COMMIT.test(String(releaseCommit || '').toLowerCase())
    || !instant(observedAt)
    || !validNestedReceipts({ pdeReplayReceipt, deepLearningReplayReceipt })
    || !validSecondHardwareDiagnostic(secondHardwareReplayDiagnostic)) {
    throw new Error('personal_self_hosted_gpu_scientific_receipt_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: KIND,
    status: 'personal_self_hosted_gpu_scientific_verified',
    profileId: PROFILE_ID,
    releaseCommit: String(releaseCommit).toLowerCase(),
    observedAt,
    pdeReplayReceipt,
    deepLearningReplayReceipt,
    secondHardwareReplayDiagnostic,
    scientificChecksPassed: true,
    productionPromotionEligible: false,
    externalActionPerformed: false,
  });
  return Object.freeze({
    ...payload,
    personalSelfHostedGpuScientificReceiptBundleHash: hashRecord(KIND, payload),
  });
}

export function verifyPersonalSelfHostedGpuScientificReceiptBundle(value) {
  if (!value || !hasExactObjectKeys(value, RECEIPT_KEYS)
    || value.version !== 1 || value.kind !== KIND
    || value.profileId !== PROFILE_ID
    || !COMMIT.test(String(value.releaseCommit || ''))
    || !instant(value.observedAt)
    || value.status !== 'personal_self_hosted_gpu_scientific_verified'
    || value.scientificChecksPassed !== true
    || value.productionPromotionEligible !== false
    || value.externalActionPerformed !== false
    || !validSecondHardwareDiagnostic(value.secondHardwareReplayDiagnostic)
    || !validNestedReceipts(value)
    || !validHash(value.personalSelfHostedGpuScientificReceiptBundleHash)) return false;
  const { personalSelfHostedGpuScientificReceiptBundleHash, ...payload } = value;
  return hashRecord(KIND, payload) === personalSelfHostedGpuScientificReceiptBundleHash;
}

export const PERSONAL_SELF_HOSTED_GPU_RECEIPT_CONTRACT = Object.freeze({
  version: 1,
  kind: KIND,
  profileId: PROFILE_ID,
  gpuReplayScopes: Object.freeze({
    pde: GPU_REPLAY_SCOPES.sameDevice,
    deepLearning: 'same-device-gpu-v1',
  }),
  secondHardwareReplay: 'optional-diagnostic-not-a-readiness-axis',
});

