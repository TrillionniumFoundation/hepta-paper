const RESULT_FIELDS = Object.freeze([
  'accepted',
  'adjustedPValue',
  'assumptionAccepted',
  'bootstrapLower',
  'bootstrapUpper',
  'count',
  'estimate',
  'holmRank',
  'holmThreshold',
  'minimumLeaveOneOutMean',
  'multiplicityAccepted',
  'pValue',
  'sensitivityAccepted',
  'skewness',
  'standardDeviation',
  'standardError',
  'standardizedEffect',
  'uncertaintyAccepted',
  'winsorizedMean',
]);
const BOOLEAN_FIELDS = Object.freeze([
  'accepted', 'assumptionAccepted', 'multiplicityAccepted', 'sensitivityAccepted', 'uncertaintyAccepted',
]);
const SCIENTIFIC_VERDICTS = new Set(['positive', 'negative', 'inconclusive']);
const UNCERTAINTY_REASON = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/;

export function finiteEmpiricalAssertionNumberText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('empirical_assertion_canonical_number_invalid');
  }
  return Object.is(value, -0) ? '0' : String(value);
}

export function empiricalAssertionResultFactsValid(result) {
  const expectedKeys = [...RESULT_FIELDS, 'scientificUncertaintyReasons', 'scientificVerdict'].sort();
  if (!result || Object.keys(result).sort().join('\0') !== expectedKeys.join('\0')
    || BOOLEAN_FIELDS.some((field) => typeof result[field] !== 'boolean')
    || RESULT_FIELDS.some((field) => !BOOLEAN_FIELDS.includes(field)
      && (typeof result[field] !== 'number' || !Number.isFinite(result[field])))
    || !Number.isSafeInteger(result.count) || result.count < 1
    || !Number.isSafeInteger(result.holmRank) || result.holmRank < 1
    || !SCIENTIFIC_VERDICTS.has(result.scientificVerdict)
    || !Array.isArray(result.scientificUncertaintyReasons)
    || result.scientificUncertaintyReasons.length > 16
    || new Set(result.scientificUncertaintyReasons).size !== result.scientificUncertaintyReasons.length
    || result.scientificUncertaintyReasons.some((reason) => !UNCERTAINTY_REASON.test(String(reason)))) return false;
  if (result.scientificVerdict === 'positive') return result.accepted && result.scientificUncertaintyReasons.length === 0;
  if (result.scientificVerdict === 'negative') return !result.accepted && result.scientificUncertaintyReasons.length === 0;
  return !result.accepted && result.scientificUncertaintyReasons.length > 0;
}

export function buildEmpiricalAssertionResultFacts(row) {
  const result = {
    accepted: row?.accepted === true,
    adjustedPValue: Number(row?.adjustedPValue),
    assumptionAccepted: row?.assumptionAccepted === true,
    bootstrapLower: Number(row?.bootstrap?.lower),
    bootstrapUpper: Number(row?.bootstrap?.upper),
    count: Number(row?.count),
    estimate: Number(row?.estimate),
    holmRank: Number(row?.holmRank),
    holmThreshold: Number(row?.holmThreshold),
    minimumLeaveOneOutMean: Number(row?.minimumLeaveOneOutMean),
    multiplicityAccepted: row?.multiplicityAccepted === true,
    pValue: Number(row?.pValue),
    sensitivityAccepted: row?.sensitivityAccepted === true,
    skewness: Number(row?.skewness),
    standardDeviation: Number(row?.standardDeviation),
    standardError: Number(row?.standardError),
    standardizedEffect: Number(row?.standardizedEffect),
    uncertaintyAccepted: row?.uncertaintyAccepted === true,
    winsorizedMean: Number(row?.winsorizedMean),
    scientificVerdict: String(row?.scientificVerdict || ''),
    scientificUncertaintyReasons: Object.freeze([...(Array.isArray(row?.scientificUncertaintyReasons)
      ? row.scientificUncertaintyReasons.map(String) : [])]),
  };
  if (!empiricalAssertionResultFactsValid(result)) {
    throw new Error('empirical_assertion_hypothesis_result_invalid');
  }
  return Object.freeze(result);
}

export function canonicalEmpiricalAssertionResultText(result) {
  if (!empiricalAssertionResultFactsValid(result)) {
    throw new Error('empirical_assertion_hypothesis_result_invalid');
  }
  const facts = RESULT_FIELDS.map((field) => {
    const value = result[field];
    if (typeof value === 'boolean') return `${field} ${value ? 'true' : 'false'}`;
    return `${field} ${finiteEmpiricalAssertionNumberText(value)}`;
  });
  const uncertaintyReasonsHex = result.scientificUncertaintyReasons.length
    ? result.scientificUncertaintyReasons.map((reason) => Buffer.from(reason, 'utf8').toString('hex')).join('+')
    : 'none';
  return `${facts.join(', ')}, scientificVerdict ${result.scientificVerdict}, scientificUncertaintyReasonsHex ${uncertaintyReasonsHex}`;
}
