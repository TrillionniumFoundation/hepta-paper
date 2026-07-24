import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactPlainObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  verifyAutonomousResearchMachineIntake,
} from './autonomous-research-machine-intake-contract.mjs';
import {
  verifyAutonomousResearchTopicProducerCapabilityEnvelope,
} from './autonomous-research-topic-producer-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SOURCE_KINDS = new Set(['machine', 'recurring-golden', 'static-file']);
const ADMISSION_V1_KEYS = Object.freeze([
  'admissionCreatedAt',
  'autonomousResearchMachineIntakeAdmissionHash',
  'campaignId',
  'intakeHash',
  'intakeId',
  'kind',
  'paperId',
  'sourceAuthorityHash',
  'sourceKind',
  'version',
].sort());
const ADMISSION_V2_KEYS = Object.freeze([
  ...ADMISSION_V1_KEYS,
  'topicProducerCapabilityReceipt',
  'topicProducerCapabilityReceiptHash',
].sort());

export function buildAutonomousResearchMachineIntakeAdmission({
  intake,
  sourceKind,
  sourceAuthorityHash,
  topicProducerCapabilityReceipt = null,
} = {}) {
  if (!verifyAutonomousResearchMachineIntake(intake)
    || !SOURCE_KINDS.has(sourceKind)
    || !SHA256.test(String(sourceAuthorityHash || ''))
    || ((sourceKind === 'recurring-golden')
      !== (intake.launchMode === 'golden-bootstrap'))
    || (sourceKind !== 'recurring-golden'
      && intake.recurringGoldenProvenance !== null)
    || (topicProducerCapabilityReceipt !== null
      && (sourceKind !== 'machine'
        || !verifyAutonomousResearchTopicProducerCapabilityEnvelope(
          topicProducerCapabilityReceipt,
          { intake },
        )))) {
    throw new Error('autonomous_research_machine_intake_admission_invalid');
  }
  const payload = Object.freeze({
    version: topicProducerCapabilityReceipt === null ? 1 : 2,
    kind: 'AutonomousResearchMachineIntakeAdmission',
    intakeId: intake.intakeId,
    intakeHash: intake.intakeHash,
    paperId: intake.paperId,
    campaignId: intake.campaignId,
    admissionCreatedAt: intake.admissionCreatedAt,
    sourceKind,
    sourceAuthorityHash,
    ...(topicProducerCapabilityReceipt === null ? {} : {
      topicProducerCapabilityReceiptHash:
        topicProducerCapabilityReceipt
          .autonomousResearchTopicProducerCapabilityReceiptHash,
      topicProducerCapabilityReceipt,
    }),
  });
  return Object.freeze({
    ...payload,
    autonomousResearchMachineIntakeAdmissionHash: hashRecord(
      'AutonomousResearchMachineIntakeAdmission',
      payload,
    ),
  });
}

export function verifyAutonomousResearchMachineIntakeAdmission(value, {
  intake = null,
} = {}) {
  const keys = value?.version === 1 ? ADMISSION_V1_KEYS
    : value?.version === 2 ? ADMISSION_V2_KEYS : null;
  if (!keys || !exactKeys(value, keys)
    || value.kind !== 'AutonomousResearchMachineIntakeAdmission'
    || !SHA256.test(String(value.autonomousResearchMachineIntakeAdmissionHash || ''))
    || (value.version === 2 && (
      value.sourceKind !== 'machine'
      || value.topicProducerCapabilityReceiptHash
        !== value.topicProducerCapabilityReceipt
          ?.autonomousResearchTopicProducerCapabilityReceiptHash
    ))) {
    return false;
  }
  try {
    const sourceIntake = intake || Object.freeze({
      // A verified intake is mandatory when reconstructing. Without one, an admission
      // cannot independently prove the launch-mode and source-kind relationship.
    });
    if (!verifyAutonomousResearchMachineIntake(sourceIntake)) return false;
    const expected = buildAutonomousResearchMachineIntakeAdmission({
      intake: sourceIntake,
      sourceKind: value.sourceKind,
      sourceAuthorityHash: value.sourceAuthorityHash,
      topicProducerCapabilityReceipt:
        value.version === 2 ? value.topicProducerCapabilityReceipt : null,
    });
    return hashRecord('AutonomousResearchMachineIntakeAdmissionEquality', value)
      === hashRecord('AutonomousResearchMachineIntakeAdmissionEquality', expected);
  } catch { return false; }
}
