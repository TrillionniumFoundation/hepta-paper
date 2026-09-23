import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const DOCUMENT_KEYS = Object.freeze([
  'evidenceHash',
  'evidenceKind',
  'facts',
  'kind',
  'recordHashField',
  'recordHashTag',
  'recordPayload',
  'sourceDocumentHash',
  'version',
]);
const FACT_KEYS = Object.freeze([
  'denominator',
  'extraction',
  'factId',
  'fieldPath',
  'kind',
  'operator',
  'sourceFactHash',
  'unit',
  'value',
  'valueType',
  'version',
]);

const SOURCE_RECORD_TYPES = Object.freeze({
  empirical_assertion_authority: Object.freeze({
    EmpiricalAssertionAuthority: 'empiricalAssertionAuthorityHash',
  }),
  empirical_assertion_authority_entry: Object.freeze({
    EmpiricalAssertionAuthorityEntry: 'empiricalAssertionAuthorityEntryHash',
  }),
  empirical_claim_lineage: Object.freeze({
    AutonomousEmpiricalClaimLineage: 'autonomousEmpiricalClaimLineageHash',
  }),
  formal_kernel_replay: Object.freeze({
    FormalCertificateReplayReceipt: 'formalCertificateReplayReceiptHash',
  }),
  formal_support_authority: Object.freeze({
    AutonomousFormalSupportSurfaceAuthority: 'autonomousFormalSupportSurfaceAuthorityHash',
  }),
  formal_verification: Object.freeze({
    CampaignFormalVerificationReceipt: 'campaignFormalVerificationReceiptHash',
  }),
  policy_authorization: Object.freeze({
    AutonomousResearchPolicyAuthorization: 'autonomousResearchPolicyAuthorizationHash',
  }),
  prior_art: Object.freeze({
    PriorArtEvidenceReceipt: 'priorArtEvidenceReceiptHash',
    PriorArtEvidenceReceiptV2: 'priorArtEvidenceReceiptHash',
    PriorArtWorkRecord: 'priorArtWorkRecordHash',
    PriorArtWorkRecordV2: 'priorArtWorkRecordHash',
  }),
  proposal: Object.freeze({
    MachineProposedScientificClaimSet: 'machineProposedScientificClaimSetHash',
  }),
  proposal_claim_record: Object.freeze({
    AutonomousResearchClaimRecord: null,
  }),
  seed_bundle: Object.freeze({
    AutonomousResearchSeedContractBundle: 'autonomousResearchSeedContractBundleHash',
  }),
});

function safeId(value) {
  const candidate = String(value || '').trim();
  return SAFE_ID.test(candidate) ? candidate : null;
}

function sha(value) {
  const candidate = String(value || '').toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}

function pointerSegments(pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return null;
  return pointer.slice(1).split('/').map((segment) => (
    segment.replace(/~1/g, '/').replace(/~0/g, '~')
  ));
}

function valueAt(record, pointer) {
  const segments = pointerSegments(pointer);
  if (!segments) return undefined;
  let cursor = record;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object'
      || !Object.hasOwn(cursor, segment)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function scalarType(value) {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number' && Number.isSafeInteger(value)) return 'integer';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  return null;
}

function staticSpecs(recordHashTag) {
  const byTag = {
    AutonomousEmpiricalClaimLineage: [
      '/paperId', '/protocolFamily', '/claimAuthorityType', '/statementRenderingPolicy',
      ['/protocolHypotheses', 'array_length_equals'],
    ],
    AutonomousFormalSupportSurfaceAuthority: [
      '/status', '/protocolFamily', '/formalSupportMode', '/empiricalOutcomeClaimed',
      '/naturalLanguageToLeanEquivalenceMachineProven', '/leanTypeContractHash',
    ],
    AutonomousResearchClaimRecord: [
      '/id', '/claimKey', '/scientificClaimKey', '/statement', '/text',
      '/verificationMode', ['/assumptions', 'array_length_equals'],
      ['/quantifiers', 'array_length_equals'], ['/negativeBoundaries', 'array_length_equals'],
      ['/proofObligations', 'array_length_equals'],
      ['/empiricalObligations', 'array_length_equals'],
    ],
    AutonomousResearchPolicyAuthorization: [
      '/status', '/decision', '/claimAuthorityType', '/protocolFamily',
      '/requestedRevisionRounds', '/requestedRefereeCount',
      '/dataScope/humanSubjects', '/dataScope/privateData',
      '/dataScope/externalDatasetAuthorityVerified',
      '/safety/scientificNoveltyVerified', '/safety/scientificCorrectnessVerified',
      '/safety/universalResearchValidityClaimed',
      '/safety/naturalLanguageToLeanEquivalenceMachineProven',
      '/safety/externalSubmissionAuthorized',
      '/safety/externalReleaseAttestationRequired',
    ],
    AutonomousResearchSeedContractBundle: [
      '/status', '/protocolFamily', '/claimAuthorityType', '/formalSupportMode',
      ['/claims', 'array_length_equals'], ['/proof_obligations', 'array_length_equals'],
      ['/evidence', 'array_length_equals'], ['/reproducibility', 'array_length_equals'],
      '/safety/universalResearchValidityClaimed',
      '/safety/naturalLanguageToLeanEquivalenceMachineProven',
      '/safety/externalReleaseAttestationRequired',
    ],
    CampaignFormalVerificationReceipt: [
      '/status', ['/blockers', 'array_length_equals'],
      ['/formalWorkerReceiptHashes', 'array_length_equals'],
      ['/formalReplayReceiptHashes', 'array_length_equals'],
      '/externalActionPerformed',
    ],
    EmpiricalAssertionAuthority: [
      '/status', '/paperId', '/campaignId', '/entryCount', ['/entries', 'array_length_equals'],
    ],
    FormalCertificateReplayReceipt: [
      '/status', '/theoremName', '/expectedTypeHash', '/replayTypeHash',
      '/axiomAuditPassed', '/externalActionPerformed',
    ],
    MachineProposedScientificClaimSet: [
      '/status', '/paperId', '/objective', '/protocolFamily', '/claimAuthorityType',
      ['/claims', 'array_length_equals'],
      '/limitations/scientificNoveltyVerified',
      '/limitations/scientificCorrectnessVerified',
      '/limitations/formalProofVerified', '/limitations/empiricalResultVerified',
      '/limitations/universalResearchValidityClaimed',
      '/limitations/naturalLanguageToLeanEquivalenceMachineProven',
    ],
    PriorArtEvidenceReceipt: [
      '/status', '/evidenceMode', '/paperId', '/openWorldCompletenessClaimed',
      '/scientificNoveltyVerified', ['/queries', 'array_length_equals'],
      ['/works', 'array_length_equals'], ['/coverageLimitations', 'array_length_equals'],
    ],
    PriorArtEvidenceReceiptV2: [
      '/status', '/evidenceMode', '/paperId', '/openWorldCompletenessClaimed',
      '/scientificNoveltyVerified', ['/queries', 'array_length_equals'],
      ['/works', 'array_length_equals'], ['/coverageLimitations', 'array_length_equals'],
    ],
    PriorArtWorkRecord: [
      '/workId', '/title', '/year', '/venue', '/doi',
      ['/authors', 'array_length_equals'], ['/identifiers', 'array_length_equals'],
    ],
    PriorArtWorkRecordV2: [
      '/workId', '/title', '/year', '/venue', '/doi',
      ['/authors', 'array_length_equals'], ['/providerSources', 'array_length_equals'],
    ],
  };
  return byTag[recordHashTag] || [];
}

function empiricalEntrySpecs(record) {
  const specs = [
    '/paperId', '/campaignId', '/experimentId', '/claimId', '/hypothesisId',
    '/predicate/metric', '/predicate/metricUnit', '/predicate/pairedUnit',
    '/predicate/comparator', '/predicate/alternative',
    '/predicate/minimumEffect', '/predicate/acceptanceRequired',
    '/scientificVerdict', '/verdict',
  ];
  for (const role of ['original', 'replay']) {
    const result = record?.[role]?.result;
    for (const key of Object.keys(result || {}).sort()) {
      specs.push(Array.isArray(result[key])
        ? [`/${role}/result/${key}`, 'array_length_equals']
        : `/${role}/result/${key}`);
    }
  }
  return specs;
}

function factSpecs(recordHashTag, record) {
  if (recordHashTag === 'EmpiricalAssertionAuthorityEntry') {
    return empiricalEntrySpecs(record);
  }
  return staticSpecs(recordHashTag);
}

function empiricalFactContext(record, fieldPath) {
  if (fieldPath === '/predicate/minimumEffect') {
    return { unit: record?.predicate?.metricUnit || null, denominator: null };
  }
  const match = /^\/(original|replay)\/result\/([^/]+)$/.exec(fieldPath);
  if (!match) return { unit: null, denominator: null };
  const [, role, field] = match;
  const metricFields = new Set([
    'bootstrapLower', 'bootstrapUpper', 'estimate', 'minimumLeaveOneOutMean',
    'standardDeviation', 'standardError', 'winsorizedMean',
  ]);
  const probabilityFields = new Set(['adjustedPValue', 'holmThreshold', 'pValue']);
  const sampledStatisticFields = new Set([
    'adjustedPValue', 'bootstrapLower', 'bootstrapUpper', 'estimate', 'holmRank',
    'holmThreshold', 'minimumLeaveOneOutMean', 'pValue', 'skewness',
    'standardDeviation', 'standardError', 'standardizedEffect', 'winsorizedMean',
  ]);
  const unit = field === 'count' ? record?.predicate?.pairedUnit || null
    : metricFields.has(field) ? record?.predicate?.metricUnit || null
      : probabilityFields.has(field) ? 'probability' : null;
  const count = record?.[role]?.result?.count;
  const denominator = sampledStatisticFields.has(field)
    && Number.isSafeInteger(count) && count > 0
    ? Object.freeze({
      kind: 'observation_count',
      fieldPath: `/${role}/result/count`,
      value: count,
    }) : null;
  return { unit, denominator };
}

function canonicalFact({ evidenceKind, ordinal, record, recordHashTag, spec }) {
  const [fieldPath, extraction = 'identity'] = Array.isArray(spec) ? spec : [spec];
  const sourceValue = valueAt(record, fieldPath);
  const value = extraction === 'array_length_equals'
    ? (Array.isArray(sourceValue) ? sourceValue.length : undefined)
    : sourceValue;
  const valueType = scalarType(value);
  if (!valueType || (typeof value === 'string' && (!value.trim() || value.length > 8_192))) {
    return null;
  }
  const context = recordHashTag === 'EmpiricalAssertionAuthorityEntry'
    ? empiricalFactContext(record, fieldPath) : { unit: null, denominator: null };
  const payload = {
    version: 1,
    kind: 'EvidenceEntailmentSourceFact',
    factId: `${evidenceKind}:source-field:${ordinal + 1}`,
    fieldPath,
    extraction,
    operator: extraction === 'array_length_equals' ? 'array_length_equals' : 'equals',
    valueType,
    value,
    unit: context.unit,
    denominator: context.denominator,
  };
  return Object.freeze({
    ...payload,
    sourceFactHash: hashRecord('EvidenceEntailmentSourceFact', payload),
  });
}

function canonicalSourceInput({ evidenceKind, evidenceHash, recordHashTag, recordHashField, record }) {
  const kind = safeId(evidenceKind);
  const tag = safeId(recordHashTag);
  const allowedField = SOURCE_RECORD_TYPES[kind]?.[tag];
  const field = recordHashField === null || recordHashField === undefined
    ? null : safeId(recordHashField);
  if (!kind || !tag || allowedField === undefined || allowedField !== field
    || !record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('evidence_entailment_source_document_type_invalid');
  }
  const claimedHash = field ? sha(record[field]) : sha(evidenceHash);
  const recordPayload = { ...record };
  if (field) delete recordPayload[field];
  if (!claimedHash || (evidenceHash && claimedHash !== sha(evidenceHash))
    || hashRecord(tag, recordPayload) !== claimedHash
    || Buffer.byteLength(JSON.stringify(recordPayload), 'utf8') > 4 * 1024 * 1024) {
    throw new Error('evidence_entailment_source_document_hash_invalid');
  }
  return { kind, tag, field, claimedHash, recordPayload };
}

export function buildEvidenceEntailmentSourceDocument(input = {}) {
  const canonical = canonicalSourceInput(input);
  const facts = Object.freeze(factSpecs(canonical.tag, canonical.recordPayload)
    .map((spec, ordinal) => canonicalFact({
      evidenceKind: canonical.kind,
      ordinal,
      record: canonical.recordPayload,
      recordHashTag: canonical.tag,
      spec,
    })).filter(Boolean));
  if (!facts.length || new Set(facts.map((fact) => fact.fieldPath)).size !== facts.length) {
    throw new Error('evidence_entailment_source_document_facts_invalid');
  }
  const payload = {
    version: 1,
    kind: 'EvidenceEntailmentSourceDocument',
    evidenceKind: canonical.kind,
    evidenceHash: canonical.claimedHash,
    recordHashTag: canonical.tag,
    recordHashField: canonical.field,
    recordPayload: Object.freeze(canonical.recordPayload),
    facts,
  };
  return Object.freeze({
    ...payload,
    sourceDocumentHash: hashRecord('EvidenceEntailmentSourceDocument', payload),
  });
}

function factShapeValid(fact) {
  if (!hasExactObjectKeys(fact, FACT_KEYS)) return false;
  const { sourceFactHash: claimedHash, ...payload } = fact || {};
  return fact?.version === 1 && fact?.kind === 'EvidenceEntailmentSourceFact'
    && Boolean(safeId(fact.factId)) && typeof fact.fieldPath === 'string'
    && fact.fieldPath.startsWith('/')
    && ['identity', 'array_length_equals'].includes(fact.extraction)
    && ['equals', 'array_length_equals'].includes(fact.operator)
    && fact.operator === (fact.extraction === 'array_length_equals'
      ? 'array_length_equals' : 'equals')
    && scalarType(fact.value) === fact.valueType
    && (fact.unit === null || (typeof fact.unit === 'string' && fact.unit.length > 0
      && fact.unit.length <= 128))
    && (fact.denominator === null || (
      hasExactObjectKeys(fact.denominator, ['fieldPath', 'kind', 'value'])
      && fact.denominator.kind === 'observation_count'
      && typeof fact.denominator.fieldPath === 'string'
      && fact.denominator.fieldPath.startsWith('/')
      && Number.isSafeInteger(fact.denominator.value)
      && fact.denominator.value > 0
    ))
    && Boolean(sha(claimedHash))
    && hashRecord('EvidenceEntailmentSourceFact', payload) === claimedHash;
}

export function verifyEvidenceEntailmentSourceDocument(document) {
  if (!hasExactObjectKeys(document, DOCUMENT_KEYS)
    || !Array.isArray(document?.facts) || !document.facts.every(factShapeValid)) return false;
  let rebuilt;
  try {
    rebuilt = buildEvidenceEntailmentSourceDocument({
      evidenceKind: document.evidenceKind,
      evidenceHash: document.evidenceHash,
      recordHashTag: document.recordHashTag,
      recordHashField: document.recordHashField,
      record: document.recordHashField
        ? { ...document.recordPayload, [document.recordHashField]: document.evidenceHash }
        : document.recordPayload,
    });
  } catch { return false; }
  return JSON.stringify(rebuilt) === JSON.stringify(document);
}

export function evidenceEntailmentSourceFact(document, sourceFactHash) {
  if (!verifyEvidenceEntailmentSourceDocument(document)) return null;
  return document.facts.find((fact) => fact.sourceFactHash === sourceFactHash) || null;
}
