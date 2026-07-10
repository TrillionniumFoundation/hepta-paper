import path from 'node:path';
import { CASE_LEDGER_OUTCOMES } from './case-ledger-contracts.mjs';
import { digest } from './hash-utils.mjs';

export const FEEDBACK_INGEST_CONTRACT_VERSION = 1;

export const FEEDBACK_INGEST_LEDGER_OUTCOMES = Object.freeze(
  CASE_LEDGER_OUTCOMES.filter((item) => item !== 'review'),
);

export const FEEDBACK_INGEST_SAFETY = Object.freeze({
  localContractOnly: true,
  readsFiles: false,
  writesFiles: false,
  callsProviderOrModel: false,
  fetchesChannelState: false,
  mutatesChannelState: false,
  uploads: false,
  submits: false,
  sendsMessages: false,
  acceptsDelivery: false,
  pays: false,
  grantsExecutionPermission: false,
});

const LEDGER_OUTCOMES = new Set(FEEDBACK_INGEST_LEDGER_OUTCOMES);
const SUCCESS_RE = /中标了你的稿件|已中标|中标成功|稿件中标|恭喜.{0,12}中标|采纳了你的稿件|已采纳|验收(?:成功|通过)|已通过|雇主.{0,12}(?:确认|满意|认可|选中)|客户.{0,12}(?:确认|满意|认可)|买家.{0,12}(?:确认|满意|认可)|最终.{0,12}(?:通过|确认|中标|验收)/i;
const REJECT_RE = /被否|拒绝|未中|不中|不要|不行|重复|跑题|偏题|错字|文字错误|不像|太满|太俗|模板|AI痕迹|重做|返工/i;
const CORRECTION_RE = /买家|客户|雇主|反馈|修改|改成|调整|希望|要求|补充|纠正|改一下|再试|重做/i;
const INTERNAL_FEEDBACK_LINE_RE = /拒绝AI|纯手工打造|定稿后向您提供|选择中标后稿件下方|稿件下方显示联系方式|如未中标|未中标|版权归还|数字备案中心|定标后|爱典风格|原创设计|放心选择|联系他|站内IM|设计作品说话|20874#PPT模板设计|如遇 GeeTest|DevToolsActivePort|final-package-review|submission-plan|submission-note|专业完成度|professional_finish|template_filler|main_subject_text|blocking|decision|checks|sourceHash|approvalHash|evidenceHash|worksIsHidden|buyerIsHide|无明显占位|未见占位|无占位|无关模板|与要求一致|主标题清晰|主视觉文字|content\\?":|notes\\?":|text\\?":/i;

function patternForKind(kindOrPattern) {
  if (kindOrPattern instanceof RegExp) return kindOrPattern;
  const kind = String(kindOrPattern || '').toLowerCase();
  if (kind === 'success') return SUCCESS_RE;
  if (kind === 'rejected' || kind === 'reject') return REJECT_RE;
  if (kind === 'correction' || kind === 'buyer_correction') return CORRECTION_RE;
  return new RegExp(String(kindOrPattern || '$.^'), 'i');
}

function splitPatternArg(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(splitPatternArg);
  return String(value).split(/\s*[|;]\s*/).map((item) => item.trim()).filter(Boolean);
}

export function compactFeedbackLine(line) {
  return String(line || '').replace(/\s+/g, ' ').replace(/^[-*#>\s]+/, '').trim().slice(0, 220);
}

export function isUsefulFeedbackLine(line) {
  const value = compactFeedbackLine(line);
  if (!value) return false;
  if (INTERNAL_FEEDBACK_LINE_RE.test(value)) return false;
  if (/^["{},\[\]]+$/.test(value)) return false;
  return true;
}

export function extractFeedbackPatterns(chunks, kindOrPattern, limit = 12) {
  const pattern = patternForKind(kindOrPattern);
  const seen = new Set();
  const out = [];
  for (const chunk of chunks || []) {
    const lines = String(chunk.text || '').split(/\r?\n|[。；;]/).map(compactFeedbackLine).filter(isUsefulFeedbackLine);
    for (const line of lines) {
      if (!pattern.test(line)) continue;
      const normalized = line.replace(/^(买家|客户|雇主)?(反馈|要求|说|表示)?[:：\s]*/, '').trim();
      const key = normalized.toLowerCase();
      if (!normalized || seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function feedbackSourceReliability(chunks) {
  let score = 0.45;
  const files = (chunks || []).map((chunk) => path.basename(String(chunk.file || ''))).join(' ');
  const text = (chunks || []).map((chunk) => chunk.text).join('\n').slice(0, 60000);
  if (/workList\.json|final-package-review|submission-plan|submission-note/.test(files)) score += 0.12;
  if (/im-history|buyer-feedback|feedback\.md/.test(files)) score += 0.16;
  if (/稿件编号|交稿成功|中标|验收|worksId|submitted_verified/i.test(text)) score += 0.16;
  if (/用户确认|人工确认|human confirmed|confirmed_by_user/i.test(text)) score += 0.16;
  if (/猜测|可能|疑似|不确定|uncertain/i.test(text)) score -= 0.12;
  return Math.max(0.15, Math.min(0.95, Number(score.toFixed(3))));
}

export function feedbackSourceWeight(chunks, args = {}) {
  if (args['source-weight']) return Number(args['source-weight']);
  const files = (chunks || []).map((chunk) => String(chunk.file || '')).join(' ');
  if (args.confirmed || args['human-confirmed']) return 1.25;
  if (/workList\.json|seller|verify|final-package-review/.test(files)) return 0.9;
  if (/im-history|buyer-feedback|feedback\.md/.test(files)) return 0.65;
  return 0.55;
}

export function inferFeedbackOutcome(ctx = {}, args = {}, chunks = []) {
  if (args.outcome) return args.outcome;
  const flowStatus = ctx.flowJob?.status || ctx.entry?.submissionStatus || '';
  const text = [flowStatus, ...chunks.map((chunk) => chunk.text)].join('\n').slice(0, 50000);
  if (/中标了你的稿件|已中标|中标成功|稿件中标|恭喜.{0,12}中标|采纳了你的稿件|已采纳|验收成功|验收通过|已通过|雇主.{0,12}(确认|满意|认可|选中)|客户.{0,12}(确认|满意|认可)|买家.{0,12}(确认|满意|认可)/.test(text)) return 'success';
  if (/重做后成功|返工后通过|redo_success/i.test(text)) return 'redo_success';
  if (/淘汰了你的稿件|已淘汰|被否|未中|不中|拒绝|buyer_rejected/i.test(text)) return 'rejected';
  if (/重做|返工|修改|buyer_correction/i.test(text)) return 'buyer_correction';
  return 'review';
}

export function providerOutcomeForFeedbackOutcome(outcome, rejectedPatterns = []) {
  if (outcome === 'success' || outcome === 'redo_success') return 'submitted_success';
  if (outcome === 'rejected') return 'buyer_rejected';
  if (outcome === 'redo_failed') return 'redo_required';
  if ((rejectedPatterns || []).some((item) => /错字|文字错误|拼写|英文错|中文错/.test(item))) return 'text_error';
  return null;
}

export function buildFeedbackLedgerCandidate({ ctx = {}, args = {}, chunks = [] } = {}) {
  const successPatterns = args.success ? splitPatternArg(args.success) : extractFeedbackPatterns(chunks, 'success');
  const rejectedPatterns = args.rejected ? splitPatternArg(args.rejected) : extractFeedbackPatterns(chunks, 'rejected');
  const buyerCorrections = args.correction ? splitPatternArg(args.correction) : extractFeedbackPatterns(chunks, 'correction');
  const outcome = inferFeedbackOutcome(ctx, args, chunks);
  const confidence = args.confidence !== undefined ? Number(args.confidence) : feedbackSourceReliability(chunks);
  const weight = feedbackSourceWeight(chunks, args);
  const patternCount = successPatterns.length + rejectedPatterns.length + buyerCorrections.length;
  const workflowId = ctx.plan?.workflowId || null;
  const industryId = ctx.plan?.industrySpec?.id || null;
  const designReferenceId = ctx.plan?.designReferenceSpec?.id || null;
  const taskId = ctx.entry?.taskId || ctx.flowJob?.taskId || null;
  const outcomeEligible = LEDGER_OUTCOMES.has(outcome);
  const eligibleForLedger = !!taskId && !!workflowId && !!industryId && patternCount > 0
    && (outcomeEligible || rejectedPatterns.length > 0 || buyerCorrections.length > 0);
  const reasons = [
    outcomeEligible ? `outcome:${outcome}` : null,
    successPatterns.length ? `successPatterns:${successPatterns.length}` : null,
    rejectedPatterns.length ? `rejectedPatterns:${rejectedPatterns.length}` : null,
    buyerCorrections.length ? `buyerCorrections:${buyerCorrections.length}` : null,
    chunks.length ? `sourceFiles:${chunks.length}` : null,
  ].filter(Boolean);
  const score = Number((
    (outcomeEligible ? 18 : 0)
    + Math.min(24, patternCount * 4)
    + confidence * 12
    + (designReferenceId ? 6 : 0)
    + (args.confirmed || args['human-confirmed'] ? 12 : 0)
  ).toFixed(3));
  const candidate = {
    version: FEEDBACK_INGEST_CONTRACT_VERSION,
    taskId,
    orderId: ctx.entry?.orderId || ctx.flowJob?.orderId || null,
    title: ctx.entry?.title || ctx.flowJob?.title || null,
    workflowId,
    industryId,
    designReferenceId,
    outcome,
    eligibleForLedger,
    reasons,
    score,
    confidence,
    sourceWeight: weight,
    sourceFiles: chunks.map((chunk) => chunk.file),
    successPatterns,
    rejectedPatterns,
    buyerCorrections,
    providerId: args.provider || ctx.plan?.provider?.providerId || null,
    command: taskId ? `npm run flow:feedback-ingest -- execute --task ${taskId} --outcome ${outcome}` : null,
  };
  candidate.candidateHash = digest({
    taskId: candidate.taskId,
    orderId: candidate.orderId,
    workflowId: candidate.workflowId,
    industryId: candidate.industryId,
    designReferenceId: candidate.designReferenceId,
    outcome: candidate.outcome,
    successPatterns,
    rejectedPatterns,
    buyerCorrections,
  });
  return candidate;
}

export function feedbackIngestReportHash(report = {}) {
  const candidates = Array.isArray(report.candidates) ? report.candidates : [];
  return digest({
    version: FEEDBACK_INGEST_CONTRACT_VERSION,
    status: report.status,
    scannedCount: report.scannedCount,
    candidateCount: report.candidateCount,
    eligibleCount: report.eligibleCount,
    candidates: candidates.map((item) => ({
      taskId: item.taskId,
      orderId: item.orderId,
      outcome: item.outcome,
      workflowId: item.workflowId,
      industryId: item.industryId,
      designReferenceId: item.designReferenceId,
      successPatterns: item.successPatterns,
      rejectedPatterns: item.rejectedPatterns,
      buyerCorrections: item.buyerCorrections,
    })),
  });
}

export function feedbackIngestScanMarkdown(report) {
  const lines = [
    '# Feedback Ingest Scan',
    '',
    `- status: ${report.status}`,
    `- generatedAt: ${report.generatedAt}`,
    `- scanned: ${report.scannedCount}`,
    `- candidates: ${report.candidateCount}`,
    `- eligible: ${report.eligibleCount}`,
    `- reportHash: ${report.reportHash}`,
    '',
    '## Candidates',
    '',
  ];
  if (!report.candidates.length) lines.push('- none');
  for (const item of report.candidates.slice(0, 50)) {
    lines.push(`- task ${item.taskId || '-'} / order ${item.orderId || '-'}: ${item.outcome}, score=${item.score}, confidence=${item.confidence}, eligible=${item.eligibleForLedger}`);
    lines.push(`  - workflow/industry/refpack: ${item.workflowId || '-'} / ${item.industryId || '-'} / ${item.designReferenceId || '-'}`);
    if (item.reasons.length) lines.push(`  - reasons: ${item.reasons.join(', ')}`);
    if (item.rejectedPatterns.length) lines.push(`  - rejected: ${item.rejectedPatterns.slice(0, 3).join(' | ')}`);
    if (item.buyerCorrections.length) lines.push(`  - corrections: ${item.buyerCorrections.slice(0, 3).join(' | ')}`);
    if (item.successPatterns.length) lines.push(`  - success: ${item.successPatterns.slice(0, 3).join(' | ')}`);
    if (item.command) lines.push(`  - command: \`${item.command}\``);
  }
  lines.push('');
  lines.push('Safety: scan is read-only and writes only this report. Ledger writes still require an explicit per-task `execute` command.');
  return lines.join('\n') + '\n';
}

export function feedbackIngestContractsSelftest() {
  const chunks = [{ file: 'buyer-feedback.md', text: '客户反馈：不要太模板，英文错字需要调整。最终中标成功。' }];
  const successPatterns = extractFeedbackPatterns(chunks, 'success');
  const rejectedPatterns = extractFeedbackPatterns(chunks, 'rejected');
  const buyerCorrections = extractFeedbackPatterns(chunks, 'correction');
  const outcome = inferFeedbackOutcome({ flowJob: { status: 'submitted_verified' }, entry: {} }, {}, chunks);
  const confidence = feedbackSourceReliability(chunks);
  const candidate = buildFeedbackLedgerCandidate({
    ctx: {
      entry: { taskId: 999301, orderId: 889901, title: 'feedback selftest' },
      flowJob: { status: 'submitted_verified' },
      plan: {
        workflowId: 'logo_brand',
        industrySpec: { id: 'general_business_service' },
        designReferenceSpec: { id: 'refpack_general_business_service_v1' },
      },
    },
    chunks,
  });
  const reportHash = feedbackIngestReportHash({
    status: 'feedback_ingest_scan_ready',
    scannedCount: 1,
    candidateCount: 1,
    eligibleCount: 1,
    candidates: [candidate],
  });
  return {
    ok: outcome === 'success'
      && successPatterns.length > 0
      && rejectedPatterns.length > 0
      && buyerCorrections.length > 0
      && confidence > 0
      && candidate.eligibleForLedger
      && candidate.reasons.some((item) => item.startsWith('rejectedPatterns'))
      && reportHash.startsWith('sha256:'),
    version: FEEDBACK_INGEST_CONTRACT_VERSION,
    safety: FEEDBACK_INGEST_SAFETY,
    candidateHash: candidate.candidateHash,
    reportHash,
  };
}
