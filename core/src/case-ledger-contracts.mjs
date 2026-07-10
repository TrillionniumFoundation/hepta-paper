export const CASE_LEDGER_VERSION = 2;

export const CASE_LEDGER_OUTCOMES = Object.freeze([
  'success',
  'rejected',
  'redo_success',
  'redo_failed',
  'buyer_correction',
  'review',
]);

const OUTCOMES = new Set(CASE_LEDGER_OUTCOMES);

export function emptyCaseLedger() {
  return { version: CASE_LEDGER_VERSION, updatedAt: null, cases: [], buckets: {} };
}

function normalizePattern(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function clamp01(value, fallback = 0.5) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function uniquePatterns(values, limit = 24) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = normalizePattern(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

export function caseLedgerBucketKey({ industryId = null, workflowId = null } = {}) {
  return [industryId || 'unknown_industry', workflowId || 'unknown_workflow'].join('::');
}

function patternFingerprint({ successPatterns = [], rejectedPatterns = [], buyerCorrections = [] } = {}) {
  return [...successPatterns, ...rejectedPatterns, ...buyerCorrections]
    .map((item) => normalizePattern(item).toLowerCase())
    .filter(Boolean)
    .sort()
    .join('|')
    .slice(0, 1000);
}

export function caseLedgerSourceWeight(source, { humanConfirmed = false } = {}) {
  if (humanConfirmed) return 1.25;
  if (/manual|human|confirmed/i.test(String(source || ''))) return 1.0;
  if (/workList|seller|submitted|acceptance|verify/i.test(String(source || ''))) return 0.9;
  if (/im|chat|feedback-ingest/i.test(String(source || ''))) return 0.55;
  return 0.65;
}

function upsertWeightedPattern(list = [], value, source, opts = {}) {
  const text = normalizePattern(value);
  if (!text) return list;
  const now = opts.now || new Date().toISOString();
  const sourceWeight = Number(opts.sourceWeight ?? caseLedgerSourceWeight(source, opts));
  const confidence = clamp01(opts.confidence, opts.humanConfirmed ? 0.9 : 0.55);
  const existing = list.find((item) => String(item.text || '').toLowerCase() === text.toLowerCase());
  if (existing) {
    existing.count = Number(existing.count || 0) + 1;
    existing.weight = Number((Number(existing.weight || existing.count || 0) + sourceWeight).toFixed(3));
    existing.confidence = Number(Math.max(Number(existing.confidence || 0), confidence).toFixed(3));
    existing.humanConfirmed = !!existing.humanConfirmed || !!opts.humanConfirmed;
    existing.lastSeenAt = now;
    if (source && !(existing.sources || []).includes(source)) existing.sources = [...(existing.sources || []), source].slice(-8);
    return list;
  }
  return [...list, { text, count: 1, weight: Number(sourceWeight.toFixed(3)), confidence: Number(confidence.toFixed(3)), humanConfirmed: !!opts.humanConfirmed, firstSeenAt: now, lastSeenAt: now, sources: source ? [source] : [] }];
}

function sortedPatternTexts(list = [], limit = 8) {
  const seen = new Set();
  return [...list]
    .sort((a, b) => Number(b.weight || b.count || 0) - Number(a.weight || a.count || 0) || Number(b.confidence || 0) - Number(a.confidence || 0) || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')))
    .map((item) => item.text)
    .filter(Boolean)
    .filter((text) => {
      const key = String(text).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

export function normalizeCaseLedgerEntry(entry = {}, { createdAt = null } = {}) {
  const outcome = OUTCOMES.has(entry.outcome) ? entry.outcome : 'review';
  const successPatterns = uniquePatterns(entry.successPatterns || []);
  const rejectedPatterns = uniquePatterns(entry.rejectedPatterns || []);
  const buyerCorrections = uniquePatterns(entry.buyerCorrections || []);
  const humanConfirmed = !!entry.humanConfirmed || !!entry.confirmed;
  const confidence = clamp01(entry.confidence, humanConfirmed ? 0.9 : 0.55);
  const source = entry.source || 'manual';
  const sourceWeight = Number(entry.sourceWeight ?? caseLedgerSourceWeight(source, { humanConfirmed }));
  const dedupeKey = entry.dedupeKey || [
    entry.taskId || entry.orderId || 'unknown_task',
    outcome,
    entry.industryId || 'unknown_industry',
    entry.workflowId || 'unknown_workflow',
    patternFingerprint({ successPatterns, rejectedPatterns, buyerCorrections }),
  ].join('::');
  return {
    version: 1,
    taskId: entry.taskId || null,
    orderId: entry.orderId || null,
    title: entry.title || null,
    industryId: entry.industryId || 'unknown_industry',
    workflowId: entry.workflowId || 'unknown_workflow',
    designReferenceId: entry.designReferenceId || null,
    providerId: entry.providerId || null,
    authProfileId: entry.authProfileId || null,
    outcome,
    successPatterns,
    rejectedPatterns,
    buyerCorrections,
    confidence,
    sourceWeight,
    humanConfirmed,
    dedupeKey,
    notes: entry.notes || null,
    source,
    createdAt: createdAt || entry.createdAt || new Date().toISOString(),
  };
}

export function applyCaseLedgerEntryToLedger(ledger = null, entry = {}, { maxCases = 1000, allowDuplicate = false } = {}) {
  const next = {
    ...emptyCaseLedger(),
    ...(ledger || {}),
    cases: [...(ledger?.cases || [])],
    buckets: { ...(ledger?.buckets || {}) },
  };
  const clean = entry.version === 1 ? entry : normalizeCaseLedgerEntry(entry);
  const existing = next.cases.find((item) => item.dedupeKey && item.dedupeKey === clean.dedupeKey);
  if (existing && !allowDuplicate) {
    existing.lastSeenAt = clean.createdAt;
    existing.seenCount = Number(existing.seenCount || 1) + 1;
    existing.confidence = Number(Math.max(Number(existing.confidence || 0), clean.confidence).toFixed(3));
    existing.humanConfirmed = !!existing.humanConfirmed || clean.humanConfirmed;
    next.updatedAt = clean.createdAt;
    return { ledger: next, entry: existing, deduped: true, dedupeKey: clean.dedupeKey };
  }
  next.cases.push(clean);
  next.cases = next.cases.slice(-Math.max(1, Number(maxCases || 1000)));
  const key = caseLedgerBucketKey(clean);
  const bucket = next.buckets[key] || {
    industryId: clean.industryId,
    workflowId: clean.workflowId,
    caseCount: 0,
    successCount: 0,
    rejectedCount: 0,
    redoSuccessCount: 0,
    redoFailedCount: 0,
    correctionCount: 0,
    weightedCaseCount: 0,
    confidenceSamples: 0,
    humanConfirmedCount: 0,
    successPatterns: [],
    rejectedPatterns: [],
    buyerCorrections: [],
  };
  bucket.caseCount = Number(bucket.caseCount || 0) + 1;
  bucket.weightedCaseCount = Number((Number(bucket.weightedCaseCount || 0) + clean.sourceWeight).toFixed(3));
  bucket.confidenceSamples = Number((Number(bucket.confidenceSamples || 0) + clean.confidence).toFixed(3));
  if (clean.humanConfirmed) bucket.humanConfirmedCount = Number(bucket.humanConfirmedCount || 0) + 1;
  if (clean.outcome === 'success') bucket.successCount = Number(bucket.successCount || 0) + 1;
  if (clean.outcome === 'rejected') bucket.rejectedCount = Number(bucket.rejectedCount || 0) + 1;
  if (clean.outcome === 'redo_success') bucket.redoSuccessCount = Number(bucket.redoSuccessCount || 0) + 1;
  if (clean.outcome === 'redo_failed') bucket.redoFailedCount = Number(bucket.redoFailedCount || 0) + 1;
  if (clean.outcome === 'buyer_correction') bucket.correctionCount = Number(bucket.correctionCount || 0) + 1;
  const patternSource = clean.taskId ? `${clean.source}:${clean.taskId}` : clean.source;
  const patternOpts = { sourceWeight: clean.sourceWeight, confidence: clean.confidence, humanConfirmed: clean.humanConfirmed, now: clean.createdAt };
  for (const item of clean.successPatterns) bucket.successPatterns = upsertWeightedPattern(bucket.successPatterns, item, patternSource, patternOpts);
  for (const item of clean.rejectedPatterns) bucket.rejectedPatterns = upsertWeightedPattern(bucket.rejectedPatterns, item, patternSource, patternOpts);
  for (const item of clean.buyerCorrections) bucket.buyerCorrections = upsertWeightedPattern(bucket.buyerCorrections, item, patternSource, patternOpts);
  next.buckets[key] = bucket;
  next.version = CASE_LEDGER_VERSION;
  next.updatedAt = clean.createdAt;
  return { ledger: next, entry: clean, bucketKey: key, bucket, deduped: false };
}

export function caseLedgerGuidanceFor({ industryId = null, workflowId = null, limit = 8, ledger = null, includeWorkflowFallback = false } = {}) {
  const source = { ...emptyCaseLedger(), ...(ledger || {}) };
  const exact = source.buckets?.[caseLedgerBucketKey({ industryId, workflowId })] || {};
  const industryBuckets = Object.entries(source.buckets || {})
    .filter(([key]) => industryId && key.startsWith(industryId + '::'))
    .map(([, value]) => value);
  const workflowBuckets = includeWorkflowFallback
    ? Object.entries(source.buckets || {})
      .filter(([key]) => workflowId && key.endsWith('::' + workflowId))
      .map(([, value]) => value)
    : [];
  const merged = {
    successPatterns: [
      ...(exact.successPatterns || []),
      ...industryBuckets.flatMap((bucket) => bucket.successPatterns || []),
      ...workflowBuckets.flatMap((bucket) => bucket.successPatterns || []),
    ],
    rejectedPatterns: [
      ...(exact.rejectedPatterns || []),
      ...industryBuckets.flatMap((bucket) => bucket.rejectedPatterns || []),
      ...workflowBuckets.flatMap((bucket) => bucket.rejectedPatterns || []),
    ],
    buyerCorrections: [
      ...(exact.buyerCorrections || []),
      ...industryBuckets.flatMap((bucket) => bucket.buyerCorrections || []),
      ...workflowBuckets.flatMap((bucket) => bucket.buyerCorrections || []),
    ],
  };
  return {
    version: CASE_LEDGER_VERSION,
    industryId: industryId || null,
    workflowId: workflowId || null,
    caseCount: Number(exact.caseCount || 0),
    inheritedCaseCount: industryBuckets.reduce((sum, bucket) => sum + Number(bucket.caseCount || 0), 0),
    successPatterns: sortedPatternTexts(merged.successPatterns, limit),
    rejectedPatterns: sortedPatternTexts(merged.rejectedPatterns, limit),
    buyerCorrections: sortedPatternTexts(merged.buyerCorrections, limit),
  };
}

export function caseLedgerContractsSelftest() {
  let ledger = emptyCaseLedger();
  const applied = applyCaseLedgerEntryToLedger(ledger, normalizeCaseLedgerEntry({
    taskId: 999201,
    industryId: 'agriculture_fertilizer',
    workflowId: 'logo_brand',
    designReferenceId: 'refpack_agriculture_fertilizer_v1',
    outcome: 'redo_success',
    successPatterns: ['large barrel/bag proof before decoration'],
    rejectedPatterns: ['leaf-only generic organic mark'],
    buyerCorrections: ['make fertilizer bucket readability stronger'],
    source: 'selftest',
  }, { createdAt: '2026-06-21T00:00:00.000Z' }));
  ledger = applied.ledger;
  const guidance = caseLedgerGuidanceFor({ industryId: 'agriculture_fertilizer', workflowId: 'logo_brand', ledger });
  return {
    ok: guidance.successPatterns.some((item) => /barrel/.test(item))
      && guidance.rejectedPatterns.some((item) => /leaf-only/.test(item))
      && guidance.buyerCorrections.some((item) => /bucket/.test(item)),
    version: CASE_LEDGER_VERSION,
    caseCount: ledger.cases.length,
    bucketCount: Object.keys(ledger.buckets).length,
  };
}
