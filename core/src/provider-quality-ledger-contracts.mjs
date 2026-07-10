export const PROVIDER_QUALITY_VERSION = 2;

export const PROVIDER_QUALITY_OUTCOMES = Object.freeze([
  'attempt',
  'generation_ok',
  'generation_failed',
  'qa_pass',
  'qa_fail',
  'package_pass',
  'package_fail',
  'submitted_success',
  'buyer_rejected',
  'redo_required',
  'text_error',
]);

const OUTCOMES = new Set(PROVIDER_QUALITY_OUTCOMES);

export function emptyProviderQualityLedger() {
  return { version: PROVIDER_QUALITY_VERSION, updatedAt: null, events: [], buckets: {} };
}

function numberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function increment(bucket, field, value = 1) {
  bucket[field] = Number(bucket[field] || 0) + value;
}

export function providerQualityBucketKey({ providerId, authProfileId = null, workflowId = null, industryId = null } = {}) {
  return [providerId || 'unknown_provider', authProfileId || 'any_auth', workflowId || 'any_workflow', industryId || 'any_industry'].join('::');
}

export function normalizeProviderQualityEvent(event = {}, { createdAt = null } = {}) {
  if (!event.providerId) throw new Error('providerId required');
  const outcome = OUTCOMES.has(event.outcome) ? event.outcome : 'attempt';
  return {
    version: 1,
    providerId: event.providerId,
    authProfileId: event.authProfileId || null,
    workflowId: event.workflowId || null,
    industryId: event.industryId || null,
    taskId: event.taskId || null,
    orderId: event.orderId || null,
    outcome,
    textError: !!event.textError || outcome === 'text_error',
    redoRequired: !!event.redoRequired || outcome === 'redo_required',
    artifactCount: numberOrNull(event.artifactCount ?? event.artifacts ?? event.count) ?? 1,
    durationMs: numberOrNull(event.durationMs ?? event.duration ?? event.latencyMs),
    costUsd: numberOrNull(event.costUsd ?? event.cost ?? event.estimatedCostUsd),
    notes: event.notes || null,
    createdAt: createdAt || event.createdAt || new Date().toISOString(),
  };
}

export function applyProviderQualityEventToLedger(ledger = null, event = {}, { maxEvents = 2000 } = {}) {
  const next = {
    ...emptyProviderQualityLedger(),
    ...(ledger || {}),
    events: [...(ledger?.events || [])],
    buckets: { ...(ledger?.buckets || {}) },
  };
  const clean = event.version === 1 ? event : normalizeProviderQualityEvent(event);
  next.events.push(clean);
  next.events = next.events.slice(-Math.max(1, Number(maxEvents || 2000)));
  const keys = [
    providerQualityBucketKey(clean),
    providerQualityBucketKey({ ...clean, authProfileId: null }),
    providerQualityBucketKey({ ...clean, industryId: null }),
    providerQualityBucketKey({ ...clean, workflowId: null }),
  ];
  for (const key of new Set(keys)) {
    const bucket = next.buckets[key] || {
      providerId: clean.providerId,
      authProfileId: key.split('::')[1] === 'any_auth' ? null : clean.authProfileId,
      workflowId: key.split('::')[2] === 'any_workflow' ? null : clean.workflowId,
      industryId: key.split('::')[3] === 'any_industry' ? null : clean.industryId,
      attempts: 0,
      generationOk: 0,
      generationFailed: 0,
      qaPass: 0,
      qaFail: 0,
      packagePass: 0,
      packageFail: 0,
      submittedSuccess: 0,
      buyerRejected: 0,
      redoRequired: 0,
      textErrors: 0,
      artifactCount: 0,
      totalDurationMs: 0,
      durationSamples: 0,
      totalCostUsd: 0,
      costSamples: 0,
      lastEventAt: null,
    };
    increment(bucket, 'attempts');
    if (clean.outcome === 'generation_ok') increment(bucket, 'generationOk');
    if (clean.outcome === 'generation_failed') increment(bucket, 'generationFailed');
    if (clean.outcome === 'qa_pass') increment(bucket, 'qaPass');
    if (clean.outcome === 'qa_fail') increment(bucket, 'qaFail');
    if (clean.outcome === 'package_pass') increment(bucket, 'packagePass');
    if (clean.outcome === 'package_fail') increment(bucket, 'packageFail');
    if (clean.outcome === 'submitted_success') increment(bucket, 'submittedSuccess');
    if (clean.outcome === 'buyer_rejected') increment(bucket, 'buyerRejected');
    if (clean.redoRequired) increment(bucket, 'redoRequired');
    if (clean.textError) increment(bucket, 'textErrors');
    increment(bucket, 'artifactCount', clean.artifactCount || 1);
    if (clean.durationMs !== null) {
      increment(bucket, 'totalDurationMs', clean.durationMs);
      increment(bucket, 'durationSamples');
    }
    if (clean.costUsd !== null) {
      increment(bucket, 'totalCostUsd', clean.costUsd);
      increment(bucket, 'costSamples');
    }
    bucket.lastEventAt = clean.createdAt;
    next.buckets[key] = bucket;
  }
  next.version = PROVIDER_QUALITY_VERSION;
  next.updatedAt = clean.createdAt;
  return { ledger: next, event: clean, keys: [...new Set(keys)] };
}

function recencyWeight(createdAt, { nowMs = Date.now(), halfLifeDays = 45 } = {}) {
  const when = Date.parse(createdAt || '');
  if (!Number.isFinite(when)) return 0.5;
  const ageDays = Math.max(0, (nowMs - when) / 86400000);
  return Math.pow(0.5, ageDays / Math.max(1, halfLifeDays));
}

function eventMatches(event, { providerId, authProfileId = null, workflowId = null, industryId = null } = {}) {
  if (providerId && event.providerId !== providerId) return false;
  if (authProfileId && event.authProfileId !== authProfileId) return false;
  if (workflowId && event.workflowId !== workflowId) return false;
  if (industryId && event.industryId !== industryId) return false;
  return true;
}

function outcomeWeights(outcome, event) {
  const textError = !!event.textError || outcome === 'text_error';
  const redoRequired = !!event.redoRequired || outcome === 'redo_required';
  const positive = outcome === 'generation_ok' ? 0.7
    : outcome === 'qa_pass' ? 1.4
      : outcome === 'package_pass' ? 1.8
        : outcome === 'submitted_success' ? 2.6
          : 0;
  const negative = outcome === 'generation_failed' ? 1.0
    : outcome === 'qa_fail' ? 1.8
      : outcome === 'package_fail' ? 2.0
        : outcome === 'buyer_rejected' ? 3.0
          : 0;
  return {
    positive,
    negative: negative + (textError ? 2.6 : 0) + (redoRequired ? 1.4 : 0),
    textError,
    redoRequired,
  };
}

export function providerQualityScore({
  providerId,
  authProfileId = null,
  workflowId = null,
  industryId = null,
  ledger = null,
  nowMs = Date.now(),
  halfLifeDays = 45,
} = {}) {
  const source = { ...emptyProviderQualityLedger(), ...(ledger || {}) };
  const bucketCandidates = [
    providerQualityBucketKey({ providerId, authProfileId, workflowId, industryId }),
    providerQualityBucketKey({ providerId, authProfileId: null, workflowId, industryId }),
    providerQualityBucketKey({ providerId, authProfileId: null, workflowId, industryId: null }),
    providerQualityBucketKey({ providerId, authProfileId: null, workflowId: null, industryId: null }),
  ].map((key) => ({ key, bucket: source.buckets?.[key] })).filter((item) => item.bucket);
  const eventCandidates = [
    { scope: 'exact', events: (source.events || []).filter((event) => eventMatches(event, { providerId, authProfileId, workflowId, industryId })) },
    { scope: 'workflow_industry', events: (source.events || []).filter((event) => eventMatches(event, { providerId, workflowId, industryId })) },
    { scope: 'workflow', events: (source.events || []).filter((event) => eventMatches(event, { providerId, workflowId })) },
    { scope: 'provider', events: (source.events || []).filter((event) => eventMatches(event, { providerId })) },
  ].filter((item) => item.events.length);
  if (!bucketCandidates.length && !eventCandidates.length) {
    return { score: 0, confidence: 0, sampleSize: 0, decayedSampleSize: 0, bucket: null, scope: 'none' };
  }
  const selectedEvents = eventCandidates[0]?.events || [];
  const bucket = bucketCandidates[0]?.bucket || null;
  let decayedSampleSize = 0;
  let positive = 0;
  let negative = 0;
  let textErrorWeight = 0;
  let redoWeight = 0;
  let durationWeighted = 0;
  let durationSamples = 0;
  let costWeighted = 0;
  let costSamples = 0;
  for (const event of selectedEvents) {
    const weight = recencyWeight(event.createdAt, { nowMs, halfLifeDays });
    const weights = outcomeWeights(event.outcome, event);
    decayedSampleSize += weight;
    positive += weights.positive * weight;
    negative += weights.negative * weight;
    if (weights.textError) textErrorWeight += weight;
    if (weights.redoRequired) redoWeight += weight;
    if (Number.isFinite(Number(event.durationMs))) {
      durationWeighted += Number(event.durationMs) * weight;
      durationSamples += weight;
    }
    if (Number.isFinite(Number(event.costUsd))) {
      costWeighted += Number(event.costUsd) * weight;
      costSamples += weight;
    }
  }
  if (!selectedEvents.length && bucket) {
    const attempts = Math.max(0, Number(bucket.attempts || 0));
    decayedSampleSize = attempts;
    positive = Number(bucket.qaPass || 0) * 1.4 + Number(bucket.packagePass || 0) * 1.8 + Number(bucket.submittedSuccess || 0) * 2.6 + Number(bucket.generationOk || 0) * 0.7;
    negative = Number(bucket.generationFailed || 0) + Number(bucket.qaFail || 0) * 1.8 + Number(bucket.packageFail || 0) * 2 + Number(bucket.buyerRejected || 0) * 3 + Number(bucket.redoRequired || 0) * 1.4 + Number(bucket.textErrors || 0) * 2.6;
    durationWeighted = Number(bucket.totalDurationMs || 0);
    durationSamples = Number(bucket.durationSamples || 0);
    costWeighted = Number(bucket.totalCostUsd || 0);
    costSamples = Number(bucket.costSamples || 0);
  }
  const sampleSize = selectedEvents.length || Number(bucket?.attempts || 0);
  const confidence = Number((1 - Math.exp(-decayedSampleSize / 8)).toFixed(3));
  const avgDurationMs = durationSamples ? durationWeighted / durationSamples : null;
  const avgCostUsd = costSamples ? costWeighted / costSamples : null;
  const costPenalty = avgCostUsd === null ? 0 : Math.min(12, avgCostUsd * 20);
  const latencyPenalty = avgDurationMs === null ? 0 : Math.min(8, avgDurationMs / 120000);
  const rawScore = positive * 9 - negative * 11 + Math.min(10, decayedSampleSize) - costPenalty - latencyPenalty;
  const score = Math.round(rawScore * (0.55 + confidence * 0.45) * 10) / 10;
  return {
    score,
    confidence,
    sampleSize,
    decayedSampleSize: Number(decayedSampleSize.toFixed(3)),
    scope: eventCandidates[0]?.scope || bucketCandidates[0]?.key || 'bucket',
    passSignal: Number(positive.toFixed(3)),
    failSignal: Number(negative.toFixed(3)),
    textErrorRate: decayedSampleSize ? Number((textErrorWeight / decayedSampleSize).toFixed(3)) : 0,
    redoRate: decayedSampleSize ? Number((redoWeight / decayedSampleSize).toFixed(3)) : 0,
    avgDurationMs: avgDurationMs === null ? null : Math.round(avgDurationMs),
    avgCostUsd: avgCostUsd === null ? null : Number(avgCostUsd.toFixed(4)),
    bucket,
  };
}

export function providerQualityContractsSelftest() {
  let ledger = emptyProviderQualityLedger();
  const baseTime = '2026-06-21T00:00:00.000Z';
  ledger = applyProviderQualityEventToLedger(ledger, normalizeProviderQualityEvent({
    providerId: 'openclaw-image',
    workflowId: 'logo_brand',
    industryId: 'semiconductor_electronics',
    outcome: 'qa_pass',
  }, { createdAt: baseTime })).ledger;
  ledger = applyProviderQualityEventToLedger(ledger, normalizeProviderQualityEvent({
    providerId: 'openclaw-image',
    workflowId: 'logo_brand',
    industryId: 'semiconductor_electronics',
    outcome: 'package_pass',
    durationMs: 90000,
    costUsd: 0.08,
  }, { createdAt: baseTime })).ledger;
  ledger = applyProviderQualityEventToLedger(ledger, normalizeProviderQualityEvent({
    providerId: 'vertex-web',
    workflowId: 'logo_brand',
    industryId: 'semiconductor_electronics',
    outcome: 'text_error',
    durationMs: 300000,
    costUsd: 0.2,
  }, { createdAt: baseTime })).ledger;
  const good = providerQualityScore({ providerId: 'openclaw-image', workflowId: 'logo_brand', industryId: 'semiconductor_electronics', ledger, nowMs: Date.parse(baseTime) });
  const bad = providerQualityScore({ providerId: 'vertex-web', workflowId: 'logo_brand', industryId: 'semiconductor_electronics', ledger, nowMs: Date.parse(baseTime) });
  return {
    ok: good.score > bad.score,
    version: PROVIDER_QUALITY_VERSION,
    eventCount: ledger.events.length,
    bucketCount: Object.keys(ledger.buckets).length,
    goodScore: good.score,
    badScore: bad.score,
  };
}
