import { CHANNEL_IDS, EXTERNAL_ACTIONS, normalizeText } from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const SUBMISSION_DESCRIPTION_CONTRACT_VERSION = 1;
export const STANDARD_SUBMISSION_NOTE_MAX_CHARS = 2000;

export const STANDARD_SUBMISSION_NOTE = [
  '拒绝AI，纯手工打造，选标后可免费设计到满意为止，谢谢。定稿后向您提供可修改源文件。您好，本稿件为我方根据项目需求深度解读后定制设计，拒绝AI一键生成、模板套图和素材拼凑，全程由设计师手工原创打造，确保作品具备品牌识别度与后续落地延展价值。',
  '我们是专业品牌设计机构，先后为5000多家企业提供LOGO、VI、包装、画册、宣传物料等品牌方案。与平台上大量业余设计师不同，我们会从品牌定位、行业属性、目标客户和传播场景出发，以独特角度展开设计，赋予品牌更完整的视觉内涵。',
  '◇ 原创设计，放心选择。中标后稿件下方显示联系方式；修改满意后交接源文件并按平台流程付款。',
  '◇ 如需沟通，请备选后点击头像旁“联系他”，通过站内IM联系我们。',
  '◇ 中标作品一年内可免费微调；商标注册过程中的局部调整也可免费配合。',
  '◇ 免费保存并提供源文件及高清格式：SVG、AI、PSD、PNG、JPG等。',
  '◇ 中标客户可免费咨询标识、包装、宣传物料、品牌延展等设计问题。',
  '◇ 如暂未满意但认可我们的能力，可选择一对一深度合作，获得更系统的品牌设计方案。'
].join('\n\n');

export const SUBMISSION_DESCRIPTION_FIELD_KINDS = Object.freeze([
  'manuscript_description',
  'replacement_description',
  'supplement_description',
  'tender_description',
  'bid_description',
  'quote_description',
  'quote_two',
  'work_desc',
  'live_submit_description',
]);

const STANDARD_NOTE_CHANNELS = new Set([CHANNEL_IDS.ZBJ, CHANNEL_IDS.EPWK]);

function normalizeChannelId(channelId) {
  const normalized = normalizeText(channelId || CHANNEL_IDS.ZBJ).toLowerCase();
  return Object.values(CHANNEL_IDS).includes(normalized) ? normalized : CHANNEL_IDS.MANUAL;
}

function normalizeFieldKind(fieldKind) {
  const normalized = normalizeText(fieldKind || 'live_submit_description')
    .toLowerCase()
    .replace(/[ -]+/g, '_');
  return SUBMISSION_DESCRIPTION_FIELD_KINDS.includes(normalized) ? normalized : 'live_submit_description';
}

function sha(value) {
  return digest({ kind: 'SubmissionDescriptionContract', value });
}

export function standardSubmissionNote() {
  if (STANDARD_SUBMISSION_NOTE.length > STANDARD_SUBMISSION_NOTE_MAX_CHARS) {
    throw new Error(`STANDARD_SUBMISSION_NOTE exceeds ${STANDARD_SUBMISSION_NOTE_MAX_CHARS} chars: ${STANDARD_SUBMISSION_NOTE.length}`);
  }
  return STANDARD_SUBMISSION_NOTE;
}

export function standardSubmissionDescription({ channelId = CHANNEL_IDS.ZBJ } = {}) {
  const normalizedChannel = normalizeChannelId(channelId);
  return STANDARD_NOTE_CHANNELS.has(normalizedChannel) ? standardSubmissionNote() : standardSubmissionNote();
}

export function normalizeSubmissionNoteForCompare(value = '') {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+$/g, '');
}

export function submissionNoteCompliance(value, { required = true, channelId = CHANNEL_IDS.ZBJ, maxChars = STANDARD_SUBMISSION_NOTE_MAX_CHARS } = {}) {
  const normalized = normalizeSubmissionNoteForCompare(value);
  const standard = standardSubmissionDescription({ channelId });
  if (!normalized) {
    return {
      ok: !required,
      reason: required ? 'missing_standard_submission_note' : 'missing_submission_note',
      length: 0,
      standardLength: standard.length,
      maxChars,
      standardNoteHash: sha(standard),
      descriptionHash: null,
    };
  }
  if (normalized.length > maxChars) {
    return {
      ok: false,
      reason: 'submission_note_too_long',
      length: normalized.length,
      standardLength: standard.length,
      maxChars,
      standardNoteHash: sha(standard),
      descriptionHash: sha(normalized),
    };
  }
  if (normalized !== standard) {
    return {
      ok: false,
      reason: 'nonstandard_submission_note',
      length: normalized.length,
      standardLength: standard.length,
      maxChars,
      standardNoteHash: sha(standard),
      descriptionHash: sha(normalized),
    };
  }
  return {
    ok: true,
    reason: 'standard_submission_note',
    length: normalized.length,
    standardLength: standard.length,
    maxChars,
    standardNoteHash: sha(standard),
    descriptionHash: sha(normalized),
  };
}

export function isStandardSubmissionNote(value) {
  return submissionNoteCompliance(value, { required: true }).ok;
}

export function assertStandardSubmissionNote(value, { source = 'submission note', required = true, channelId = CHANNEL_IDS.ZBJ } = {}) {
  const status = submissionNoteCompliance(value, { required, channelId });
  if (!status.ok) {
    throw new Error(`${source} must match STANDARD_SUBMISSION_NOTE exactly except trailing newlines: ${status.reason}`);
  }
  return standardSubmissionDescription({ channelId });
}

export function createSubmissionDescriptionContract({
  channelId = CHANNEL_IDS.ZBJ,
  fieldKind = 'live_submit_description',
  action = EXTERNAL_ACTIONS.LIVE_SUBMIT,
  description = undefined,
  required = true,
  maxChars = STANDARD_SUBMISSION_NOTE_MAX_CHARS,
} = {}) {
  const normalizedChannel = normalizeChannelId(channelId);
  const normalizedFieldKind = normalizeFieldKind(fieldKind);
  const activeDescription = description === undefined ? standardSubmissionDescription({ channelId: normalizedChannel }) : description;
  const compliance = submissionNoteCompliance(activeDescription, {
    required,
    channelId: normalizedChannel,
    maxChars,
  });
  const contract = {
    version: SUBMISSION_DESCRIPTION_CONTRACT_VERSION,
    channelId: normalizedChannel,
    fieldKind: normalizedFieldKind,
    action,
    policyId: 'fixed_standard_submission_note',
    required: required !== false,
    ok: compliance.ok,
    reason: compliance.reason,
    compliance,
    standardNoteHash: compliance.standardNoteHash,
    descriptionHash: compliance.descriptionHash,
    safety: {
      localContractOnly: true,
      executesExternalAction: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      fetchesChannelState: false,
      callsProviderOrModel: false,
      grantsExecutionPermission: false,
    },
  };
  return {
    ...contract,
    contractHash: digest(contract),
  };
}

export function validateSubmissionDescriptionContract(contract = {}) {
  const blockers = [];
  if (contract.version !== SUBMISSION_DESCRIPTION_CONTRACT_VERSION) blockers.push('submission_description_contract_version_mismatch');
  if (!contract.channelId) blockers.push('submission_description_channel_required');
  if (!SUBMISSION_DESCRIPTION_FIELD_KINDS.includes(contract.fieldKind)) blockers.push('submission_description_field_kind_invalid');
  if (contract.policyId !== 'fixed_standard_submission_note') blockers.push('submission_description_policy_invalid');
  if (contract.ok !== true) blockers.push(contract.reason || 'submission_description_not_compliant');
  if (!contract.standardNoteHash) blockers.push('submission_description_standard_hash_required');
  if (!contract.descriptionHash && contract.required !== false) blockers.push('submission_description_hash_required');
  return {
    ok: blockers.length === 0,
    blockers,
    status: blockers.length ? 'blocked_submission_description_contract' : 'pass_submission_description_contract',
    safety: {
      localContractOnly: true,
      executesExternalAction: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      fetchesChannelState: false,
      callsProviderOrModel: false,
      grantsExecutionPermission: false,
    },
  };
}

export function submissionDescriptionContractsSelftest() {
  const standard = standardSubmissionNote();
  const ready = createSubmissionDescriptionContract({ description: `${standard}\n\n` });
  const missingOptional = createSubmissionDescriptionContract({ description: '', required: false });
  const bad = createSubmissionDescriptionContract({ description: '客户您好，这是生成出来的交稿说明。' });
  const tooLong = createSubmissionDescriptionContract({ description: `${standard}\n${'x'.repeat(2100)}` });
  const validation = validateSubmissionDescriptionContract(ready);
  return {
    ok: ready.ok === true
      && validation.ok === true
      && missingOptional.ok === true
      && bad.ok === false
      && bad.reason === 'nonstandard_submission_note'
      && tooLong.reason === 'submission_note_too_long',
    ready,
    bad,
    tooLong,
    validation,
    safety: {
      localContractOnly: true,
      executesExternalAction: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      fetchesChannelState: false,
      callsProviderOrModel: false,
      grantsExecutionPermission: false,
    },
  };
}
