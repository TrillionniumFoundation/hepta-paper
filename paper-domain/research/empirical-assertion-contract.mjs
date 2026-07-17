import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { canonicalEmpiricalPresentationPdf } from './empirical-presentation-pdf.mjs';
import {
  buildEmpiricalAssertionResultFacts as resultFacts,
  canonicalEmpiricalAssertionResultText as canonicalResultText,
  empiricalAssertionResultFactsValid,
  finiteEmpiricalAssertionNumberText as finiteNumberText,
} from './empirical-assertion-result-facts.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const ASSERTION_KINDS = new Set(['confirmatory_hypothesis_result']);
const PRESENTATION_KINDS = new Set(['confirmatory_result_table', 'confirmatory_result_figure']);

function safeSegment(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 180) || 'unknown';
}

export function empiricalResultMaterializedPath(nodeId, artifactName = 'results.json') {
  if (!['results.json', 'results.csv'].includes(artifactName)) {
    throw new Error('empirical_assertion_result_artifact_name_invalid');
  }
  return `automation-results/${safeSegment(nodeId)}/${artifactName}`;
}

function samePredicate(left, right) {
  return ['hypothesisId', 'metric', 'comparator', 'alternative', 'minimumEffect', 'acceptanceRequired']
    .every((field) => left?.[field] === right?.[field]);
}

function identifierHex(value) {
  return Buffer.from(String(value), 'utf8').toString('hex');
}

export function canonicalEmpiricalAssertionManuscriptBody(entry) {
  const body = [
    `Registered empirical assertion ${String(entry?.assertionId || '')} reports claim hex ${identifierHex(entry?.claimId || '')} and hypothesis hex ${identifierHex(entry?.hypothesisId || '')} for experiment hex ${identifierHex(entry?.experimentId || '')}.`,
    `Predicate metric hex ${identifierHex(entry?.predicate?.metric || '')}, comparator ${String(entry?.predicate?.comparator || '')}, alternative ${String(entry?.predicate?.alternative || '')}, minimum effect ${finiteNumberText(entry?.predicate?.minimumEffect)}, acceptance required ${entry?.predicate?.acceptanceRequired === true ? 'true' : 'false'}.`,
    `Original registered result: ${canonicalResultText(entry?.original?.result)}.`,
    `Isolated deterministic rerun registered result: ${canonicalResultText(entry?.replay?.result)}.`,
    `The registry-bound scientific verdict is ${String(entry?.scientificVerdict || '')}. Scope is limited to this registered predicate, original run, and same-code-image-data-harness rerun, not independent scientific replication.`,
  ].join(' ');
  if (!/^[A-Za-z0-9 .,;:+-]+$/.test(body) || /[%\\\r\n]/.test(body)) {
    throw new Error('empirical_assertion_canonical_body_unsafe');
  }
  return body;
}

function canonicalManuscriptBodyValid(entry) {
  try {
    return entry?.canonicalManuscriptBody === canonicalEmpiricalAssertionManuscriptBody(entry)
      && entry?.canonicalManuscriptBodyHash === hashBytes(entry.canonicalManuscriptBody);
  } catch { return false; }
}

function latexText(value) {
  return String(value || '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([#$%&_{}])/g, '\\$1');
}

function decimal(value, digits = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('empirical_presentation_number_invalid');
  return number.toFixed(digits).replace(/(?:\.0+|(?:(\.[0-9]*?)0+))$/, '$1') || '0';
}

function presentationTableBody(entries, labelSuffix) {
  const rows = entries.map((entry) => [
    latexText(entry.claimId), latexText(entry.experimentId),
    decimal(entry.original.result.estimate, 12), decimal(entry.replay.result.estimate, 12),
    latexText(entry.verdict),
  ].join(' & ') + ' \\\\');
  return [
    '\\begin{table}[htbp]',
    '\\centering',
    '\\caption{Registry-bound confirmatory results from the original execution and isolated deterministic rerun.}',
    `\\label{tab:hepta-empirical-results-${labelSuffix}}`,
    '\\begin{tabular}{lllll}',
    '\\hline',
    'Claim & Experiment & Original & Rerun & Verdict \\\\',
    '\\hline',
    ...rows,
    '\\hline',
    '\\end{tabular}',
    '\\end{table}',
  ].join('\n');
}

function presentationFigureBody(artifactPath, labelSuffix) {
  return [
    '\\begin{figure}[htbp]',
    '\\centering',
    `\\includegraphics[width=0.9\\linewidth]{${artifactPath}}`,
    '\\caption{Registry-bound original and isolated deterministic rerun estimates for each confirmatory claim.}',
    `\\label{fig:hepta-empirical-results-${labelSuffix}}`,
    '\\end{figure}',
  ].join('\n');
}

function presentationEntry({ authority, surfaceKind, body, artifact = null }) {
  const identity = {
    empiricalAssertionAuthorityHash: authority.empiricalAssertionAuthorityHash,
    surfaceKind,
  };
  const surfaceId = `empirical-presentation-${hashRecord('EmpiricalPresentationIdentity', identity).slice(7, 47)}`;
  const payload = {
    version: 1,
    kind: 'EmpiricalPresentationAuthorityEntry',
    surfaceId,
    surfaceKind,
    paperId: authority.paperId,
    campaignId: authority.campaignId,
    experimentRegistryHash: authority.experimentRegistryHash,
    empiricalAssertionAuthorityHash: authority.empiricalAssertionAuthorityHash,
    authorityEntryHashes: Object.freeze(authority.entries.map((entry) => entry.empiricalAssertionAuthorityEntryHash)),
    claimIds: Object.freeze(authority.entries.map((entry) => entry.claimId)),
    experimentIds: Object.freeze(authority.entries.map((entry) => entry.experimentId)),
    artifactPath: artifact?.path || null,
    artifactHash: artifact?.hash || null,
    artifactBytes: artifact?.bytes ?? null,
    canonicalManuscriptBody: body,
    canonicalManuscriptBodyHash: hashBytes(body),
  };
  return Object.freeze({
    ...payload,
    empiricalPresentationAuthorityEntryHash:
      hashRecord('EmpiricalPresentationAuthorityEntry', payload),
  });
}

function canonicalExperiment(experiment) {
  const requiredHashes = [
    'analysisProtocolHash',
    'empiricalClaimUniverseHash',
    'experimentReplayReceiptHash',
    'originalAnalysisEvaluationHash',
    'originalResultArtifactHash',
    'originalRunReceiptHash',
    'replayAnalysisEvaluationHash',
    'replayResultArtifactHash',
    'replayRunReceiptHash',
  ];
  if (!IDENTIFIER.test(String(experiment?.experimentId || ''))
    || !IDENTIFIER.test(String(experiment?.originalNodeId || ''))
    || !IDENTIFIER.test(String(experiment?.replayNodeId || ''))
    || !String(experiment?.originalAttemptId || '')
    || !String(experiment?.replayAttemptId || '')
    || requiredHashes.some((field) => !SHA256.test(String(experiment?.[field] || '')))
    || !String(experiment?.originalResultArtifactRole || '')
    || !String(experiment?.replayResultArtifactRole || '')
    || !Array.isArray(experiment?.claimBindings)
    || !Array.isArray(experiment?.originalEvaluation?.hypotheses)
    || !Array.isArray(experiment?.replayEvaluation?.hypotheses)) {
    throw new Error('empirical_assertion_experiment_authority_invalid');
  }
  return experiment;
}

function authorityEntry({ paperId, campaignId, experiment, binding, original, replay }) {
  if (!IDENTIFIER.test(String(binding?.claimId || ''))
    || !IDENTIFIER.test(String(binding?.hypothesisId || ''))
    || !SHA256.test(String(binding?.manuscriptClaimHash || ''))
    || (binding?.proposalClaimRecordHash !== null
      && !SHA256.test(String(binding?.proposalClaimRecordHash || '')))
    || original?.hypothesisId !== binding.hypothesisId
    || replay?.hypothesisId !== binding.hypothesisId
    || !samePredicate(original, replay)) {
    throw new Error('empirical_assertion_claim_evaluation_binding_invalid');
  }
  const originalResult = resultFacts(original);
  const replayResult = resultFacts(replay);
  if (originalResult.scientificVerdict !== replayResult.scientificVerdict
    || JSON.stringify(originalResult.scientificUncertaintyReasons)
      !== JSON.stringify(replayResult.scientificUncertaintyReasons)) {
    throw new Error('empirical_assertion_replay_verdict_mismatch');
  }
  const predicate = Object.freeze({
    metric: String(original.metric),
    comparator: String(original.comparator),
    alternative: String(original.alternative),
    minimumEffect: Number(original.minimumEffect),
    acceptanceRequired: original.acceptanceRequired === true,
  });
  if (!IDENTIFIER.test(predicate.metric)
    || !['baseline', 'ablation'].includes(predicate.comparator)
    || !['greater', 'less'].includes(predicate.alternative)
    || !Number.isFinite(predicate.minimumEffect) || predicate.minimumEffect < 0) {
    throw new Error('empirical_assertion_predicate_invalid');
  }
  const identity = {
    paperId,
    campaignId,
    experimentId: experiment.experimentId,
    claimId: binding.claimId,
    hypothesisId: binding.hypothesisId,
    analysisProtocolHash: experiment.analysisProtocolHash,
    originalRunReceiptHash: experiment.originalRunReceiptHash,
    replayRunReceiptHash: experiment.replayRunReceiptHash,
    originalResult,
    replayResult,
  };
  const assertionId = `empirical-assertion-${hashRecord('EmpiricalAssertionIdentity', identity).slice('sha256:'.length, 'sha256:'.length + 40)}`;
  const canonicalManuscriptBody = canonicalEmpiricalAssertionManuscriptBody({
    assertionId,
    experimentId: experiment.experimentId,
    claimId: binding.claimId,
    hypothesisId: binding.hypothesisId,
    predicate,
    scientificVerdict: originalResult.scientificVerdict,
    original: { result: originalResult },
    replay: { result: replayResult },
  });
  const payload = {
    version: 1,
    kind: 'EmpiricalAssertionAuthorityEntry',
    assertionId,
    assertionKind: 'confirmatory_hypothesis_result',
    paperId,
    campaignId,
    experimentId: experiment.experimentId,
    claimId: binding.claimId,
    hypothesisId: binding.hypothesisId,
    manuscriptClaimHash: binding.manuscriptClaimHash,
    proposalClaimRecordHash: binding.proposalClaimRecordHash ?? null,
    empiricalClaimUniverseHash: experiment.empiricalClaimUniverseHash,
    analysisProtocolHash: experiment.analysisProtocolHash,
    predicate,
    scientificVerdict: originalResult.scientificVerdict,
    verdict: originalResult.scientificVerdict,
    canonicalManuscriptBody,
    canonicalManuscriptBodyHash: hashBytes(canonicalManuscriptBody),
    original: Object.freeze({
      experimentRunReceiptHash: experiment.originalRunReceiptHash,
      analysisEvaluationHash: experiment.originalAnalysisEvaluationHash,
      artifactPath: empiricalResultMaterializedPath(experiment.originalNodeId),
      artifactName: 'results.json',
      artifactHash: experiment.originalResultArtifactHash,
      artifactRole: experiment.originalResultArtifactRole,
      jsonPointer: `/analysisProtocolEvaluation/hypotheses/${experiment.originalEvaluation.hypotheses.indexOf(original)}`,
      result: originalResult,
    }),
    replay: Object.freeze({
      experimentRunReceiptHash: experiment.replayRunReceiptHash,
      experimentReplayReceiptHash: experiment.experimentReplayReceiptHash,
      analysisEvaluationHash: experiment.replayAnalysisEvaluationHash,
      artifactPath: empiricalResultMaterializedPath(experiment.replayNodeId),
      artifactName: 'results.json',
      artifactHash: experiment.replayResultArtifactHash,
      artifactRole: experiment.replayResultArtifactRole,
      jsonPointer: `/analysisProtocolEvaluation/hypotheses/${experiment.replayEvaluation.hypotheses.indexOf(replay)}`,
      result: replayResult,
    }),
  };
  return Object.freeze({
    ...payload,
    empiricalAssertionAuthorityEntryHash: hashRecord('EmpiricalAssertionAuthorityEntry', payload),
  });
}

export function buildEmpiricalAssertionAuthority({
  paperId,
  campaignId,
  experimentRegistryHash = null,
  experiments = [],
} = {}) {
  if (!IDENTIFIER.test(String(paperId || '')) || !IDENTIFIER.test(String(campaignId || ''))
    || (experimentRegistryHash !== null && !SHA256.test(String(experimentRegistryHash || '')))
    || !Array.isArray(experiments) || !experiments.length) {
    throw new Error('empirical_assertion_authority_input_invalid');
  }
  const entries = [];
  for (const rawExperiment of experiments) {
    const experiment = canonicalExperiment(rawExperiment);
    for (const binding of experiment.claimBindings) {
      const original = experiment.originalEvaluation.hypotheses
        .find((candidate) => candidate?.hypothesisId === binding?.hypothesisId);
      const replay = experiment.replayEvaluation.hypotheses
        .find((candidate) => candidate?.hypothesisId === binding?.hypothesisId);
      entries.push(authorityEntry({ paperId, campaignId, experiment, binding, original, replay }));
    }
  }
  entries.sort((left, right) => left.assertionId.localeCompare(right.assertionId));
  if (!entries.length || new Set(entries.map((entry) => entry.assertionId)).size !== entries.length
    || new Set(entries.map((entry) => entry.claimId)).size !== entries.length) {
    throw new Error('empirical_assertion_authority_entry_bijection_invalid');
  }
  const payload = {
    version: 1,
    kind: 'EmpiricalAssertionAuthority',
    status: 'empirical_assertion_authority_verified',
    paperId,
    campaignId,
    experimentRegistryHash,
    entries: Object.freeze(entries),
    entryCount: entries.length,
    blockers: Object.freeze([]),
  };
  return Object.freeze({
    ...payload,
    empiricalAssertionAuthorityHash: hashRecord('EmpiricalAssertionAuthority', payload),
  });
}

export function verifyEmpiricalAssertionAuthority(authority, expected = {}) {
  const blockers = [];
  const { empiricalAssertionAuthorityHash: claimedHash, ...payload } = authority || {};
  if (authority?.version !== 1 || authority?.kind !== 'EmpiricalAssertionAuthority'
    || authority?.status !== 'empirical_assertion_authority_verified'
    || !SHA256.test(String(claimedHash || ''))
    || hashRecord('EmpiricalAssertionAuthority', payload) !== claimedHash
    || !Array.isArray(authority?.entries) || authority.entries.length < 1
    || authority?.entryCount !== authority.entries.length
    || !Array.isArray(authority?.blockers) || authority.blockers.length) {
    blockers.push('empirical_assertion_authority_record_invalid');
  }
  const ids = new Set();
  for (const entry of authority?.entries || []) {
    const { empiricalAssertionAuthorityEntryHash: entryHash, ...entryPayload } = entry || {};
    if (entry?.version !== 1 || entry?.kind !== 'EmpiricalAssertionAuthorityEntry'
      || !ASSERTION_KINDS.has(entry?.assertionKind)
      || !IDENTIFIER.test(String(entry?.assertionId || '')) || ids.has(entry.assertionId)
      || !SHA256.test(String(entryHash || ''))
      || hashRecord('EmpiricalAssertionAuthorityEntry', entryPayload) !== entryHash
      || !empiricalAssertionResultFactsValid(entry?.original?.result)
      || !empiricalAssertionResultFactsValid(entry?.replay?.result)
      || entry?.scientificVerdict !== entry?.original?.result?.scientificVerdict
      || entry?.scientificVerdict !== entry?.replay?.result?.scientificVerdict
      || entry?.verdict !== entry?.scientificVerdict
      || JSON.stringify(entry?.original?.result?.scientificUncertaintyReasons)
        !== JSON.stringify(entry?.replay?.result?.scientificUncertaintyReasons)
      || !canonicalManuscriptBodyValid(entry)
      || entry?.paperId !== authority?.paperId || entry?.campaignId !== authority?.campaignId) {
      blockers.push(`empirical_assertion_authority_entry_invalid:${entry?.assertionId || 'missing'}`);
    }
    ids.add(entry?.assertionId);
  }
  for (const field of ['paperId', 'campaignId', 'experimentRegistryHash']) {
    if (expected[field] !== undefined && authority?.[field] !== expected[field]) {
      blockers.push(`empirical_assertion_authority_${field}_mismatch`);
    }
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze([...new Set(blockers)]) });
}

export function buildEmpiricalPresentationAuthority(authority) {
  const verification = verifyEmpiricalAssertionAuthority(authority, {
    paperId: authority?.paperId,
    campaignId: authority?.campaignId,
    experimentRegistryHash: authority?.experimentRegistryHash,
  });
  if (!verification.valid) throw new Error('empirical_presentation_assertion_authority_invalid');
  const entries = [...authority.entries].sort((left, right) => left.assertionId.localeCompare(right.assertionId));
  const labelSuffix = authority.empiricalAssertionAuthorityHash.slice(7, 19);
  const figureBytes = canonicalEmpiricalPresentationPdf(entries);
  const figureArtifact = Object.freeze({
    path: `figures/hepta-empirical-results-${labelSuffix}.pdf`,
    hash: hashBytes(figureBytes),
    bytes: figureBytes.length,
  });
  const presentationEntries = Object.freeze([
    presentationEntry({
      authority,
      surfaceKind: 'confirmatory_result_table',
      body: presentationTableBody(entries, labelSuffix),
    }),
    presentationEntry({
      authority,
      surfaceKind: 'confirmatory_result_figure',
      body: presentationFigureBody(figureArtifact.path, labelSuffix),
      artifact: figureArtifact,
    }),
  ]);
  const payload = {
    version: 1,
    kind: 'EmpiricalPresentationAuthority',
    status: 'empirical_presentation_authority_verified',
    paperId: authority.paperId,
    campaignId: authority.campaignId,
    experimentRegistryHash: authority.experimentRegistryHash,
    empiricalAssertionAuthorityHash: authority.empiricalAssertionAuthorityHash,
    entries: presentationEntries,
    entryCount: presentationEntries.length,
    artifacts: Object.freeze([figureArtifact]),
    blockers: Object.freeze([]),
  };
  return Object.freeze({
    ...payload,
    empiricalPresentationAuthorityHash: hashRecord('EmpiricalPresentationAuthority', payload),
  });
}

export function empiricalPresentationArtifactContents(authority) {
  const presentation = buildEmpiricalPresentationAuthority(authority);
  const entries = [...authority.entries].sort((left, right) => left.assertionId.localeCompare(right.assertionId));
  const content = canonicalEmpiricalPresentationPdf(entries);
  const artifact = presentation.artifacts[0];
  if (hashBytes(content) !== artifact.hash || content.length !== artifact.bytes) {
    throw new Error('empirical_presentation_artifact_derivation_invalid');
  }
  return Object.freeze([Object.freeze({ ...artifact, content })]);
}

export function empiricalPresentationMarkerDeclaration(entry) {
  if (entry?.kind !== 'EmpiricalPresentationAuthorityEntry'
    || !PRESENTATION_KINDS.has(entry?.surfaceKind)
    || !IDENTIFIER.test(String(entry?.surfaceId || ''))
    || !SHA256.test(String(entry?.empiricalPresentationAuthorityEntryHash || ''))) {
    throw new Error('empirical_presentation_authority_entry_invalid');
  }
  return Object.freeze({
    version: 1,
    surfaceId: entry.surfaceId,
    surfaceKind: entry.surfaceKind,
    surfaceAuthorityEntryHash: entry.empiricalPresentationAuthorityEntryHash,
    artifactPath: entry.artifactPath,
    artifactHash: entry.artifactHash,
  });
}

export function empiricalPresentationMarkerDeclarationValid(value) {
  if (!hasExactObjectKeys(value, [
    'version', 'surfaceId', 'surfaceKind', 'surfaceAuthorityEntryHash', 'artifactPath', 'artifactHash',
  ])
    || value?.version !== 1
    || !IDENTIFIER.test(String(value?.surfaceId || ''))
    || !PRESENTATION_KINDS.has(value?.surfaceKind)
    || !SHA256.test(String(value?.surfaceAuthorityEntryHash || ''))) return false;
  if (value.surfaceKind === 'confirmatory_result_table') {
    return value.artifactPath === null && value.artifactHash === null;
  }
  return /^figures\/[A-Za-z0-9._-]+\.pdf$/.test(String(value.artifactPath || ''))
    && SHA256.test(String(value.artifactHash || ''));
}

function bodySemanticsBlockers(assertion, entry) {
  if (assertion?.text !== entry?.canonicalManuscriptBody
    || assertion?.manuscriptContentHash !== entry?.canonicalManuscriptBodyHash) {
    return [`empirical_assertion_canonical_body_mismatch:${entry?.assertionId || 'missing'}`];
  }
  return [];
}

function presentationSemanticsBlockers(presentation, entry) {
  const blockers = [];
  let expectedDeclaration = null;
  try { expectedDeclaration = empiricalPresentationMarkerDeclaration(entry); }
  catch { blockers.push(`empirical_presentation_authority_entry_invalid:${entry?.surfaceId || 'missing'}`); }
  if (!expectedDeclaration
    || JSON.stringify(presentation?.declaration) !== JSON.stringify(expectedDeclaration)) {
    blockers.push(`empirical_presentation_authority_reference_invalid:${presentation?.declaration?.surfaceId || 'missing'}`);
  }
  if (presentation?.text !== entry?.canonicalManuscriptBody
    || presentation?.manuscriptContentHash !== entry?.canonicalManuscriptBodyHash) {
    blockers.push(`empirical_presentation_canonical_body_mismatch:${entry?.surfaceId || 'missing'}`);
  }
  if (entry?.artifactPath === null) {
    if (presentation?.artifact !== null) {
      blockers.push(`empirical_presentation_unexpected_artifact:${entry?.surfaceId || 'missing'}`);
    }
  } else if (presentation?.artifact?.status !== 'empirical_presentation_artifact_verified'
    || presentation.artifact.path !== entry.artifactPath
    || presentation.artifact.hash !== entry.artifactHash
    || presentation.artifact.bytes !== entry.artifactBytes) {
    blockers.push(`empirical_presentation_artifact_binding_invalid:${entry?.surfaceId || 'missing'}`);
  }
  return blockers;
}

export function bindEmpiricalAssertionUniverse({
  authority,
  universe,
  expectedPaperId = null,
  expectedCampaignId = null,
  expectedExperimentRegistryHash = null,
} = {}) {
  const blockers = [];
  const authorityVerification = verifyEmpiricalAssertionAuthority(authority, {
    paperId: expectedPaperId,
    campaignId: expectedCampaignId,
    experimentRegistryHash: expectedExperimentRegistryHash,
  });
  blockers.push(...authorityVerification.blockers);
  let presentationAuthority = null;
  if (authorityVerification.valid) {
    try { presentationAuthority = buildEmpiricalPresentationAuthority(authority); }
    catch { blockers.push('empirical_presentation_authority_derivation_failed'); }
  }
  const { empiricalAssertionUniverseHash: universeHash, ...universePayload } = universe || {};
  if (universe?.version !== 1 || universe?.kind !== 'EmpiricalAssertionUniverse'
    || universe?.status !== 'empirical_assertion_universe_verified'
    || !SHA256.test(String(universeHash || ''))
    || hashRecord('EmpiricalAssertionUniverse', universePayload) !== universeHash
    || !Array.isArray(universe?.assertions) || !universe.assertions.length
    || !Array.isArray(universe?.presentations)
    || !Array.isArray(universe?.presentationArtifacts)
    || !Array.isArray(universe?.blockers) || universe.blockers.length) {
    blockers.push('empirical_assertion_universe_invalid');
  }
  const byHash = new Map((authority?.entries || [])
    .map((entry) => [entry.empiricalAssertionAuthorityEntryHash, entry]));
  const consumed = new Set();
  const bindings = [];
  for (const assertion of universe?.assertions || []) {
    const entry = byHash.get(assertion?.declaration?.authorityEntryHash);
    if (!entry || assertion?.declaration?.assertionId !== entry.assertionId) {
      blockers.push(`empirical_assertion_authority_reference_invalid:${assertion?.declaration?.assertionId || 'missing'}`);
      continue;
    }
    if (consumed.has(entry.assertionId)) {
      blockers.push(`empirical_assertion_authority_reused:${entry.assertionId}`);
      continue;
    }
    consumed.add(entry.assertionId);
    blockers.push(...bodySemanticsBlockers(assertion, entry));
    bindings.push(Object.freeze({
      assertionId: entry.assertionId,
      authorityEntryHash: entry.empiricalAssertionAuthorityEntryHash,
      claimId: entry.claimId,
      hypothesisId: entry.hypothesisId,
      scientificVerdict: entry.scientificVerdict,
      verdict: entry.verdict,
      manuscriptPath: assertion.manuscriptPath,
      manuscriptByteStart: assertion.manuscriptByteStart,
      manuscriptByteEnd: assertion.manuscriptByteEnd,
      manuscriptContentHash: assertion.manuscriptContentHash,
    }));
  }
  for (const entry of authority?.entries || []) {
    if (!consumed.has(entry.assertionId)) {
      blockers.push(`empirical_assertion_authority_entry_unreported:${entry.assertionId}`);
    }
  }
  const presentationByHash = new Map((presentationAuthority?.entries || [])
    .map((entry) => [entry.empiricalPresentationAuthorityEntryHash, entry]));
  const consumedPresentations = new Set();
  const presentationBindings = [];
  for (const presentation of universe?.presentations || []) {
    const entry = presentationByHash.get(presentation?.declaration?.surfaceAuthorityEntryHash);
    if (!entry || presentation?.declaration?.surfaceId !== entry.surfaceId) {
      blockers.push(`empirical_presentation_authority_reference_invalid:${presentation?.declaration?.surfaceId || 'missing'}`);
      continue;
    }
    if (consumedPresentations.has(entry.surfaceId)) {
      blockers.push(`empirical_presentation_authority_reused:${entry.surfaceId}`);
      continue;
    }
    consumedPresentations.add(entry.surfaceId);
    blockers.push(...presentationSemanticsBlockers(presentation, entry));
    presentationBindings.push(Object.freeze({
      surfaceId: entry.surfaceId,
      surfaceKind: entry.surfaceKind,
      surfaceAuthorityEntryHash: entry.empiricalPresentationAuthorityEntryHash,
      authorityEntryHashes: entry.authorityEntryHashes,
      claimIds: entry.claimIds,
      experimentIds: entry.experimentIds,
      artifactPath: entry.artifactPath,
      artifactHash: entry.artifactHash,
      artifactBytes: entry.artifactBytes,
      manuscriptPath: presentation.manuscriptPath,
      manuscriptByteStart: presentation.manuscriptByteStart,
      manuscriptByteEnd: presentation.manuscriptByteEnd,
      manuscriptContentHash: presentation.manuscriptContentHash,
    }));
  }
  if ((universe?.presentations || []).length) {
    for (const entry of presentationAuthority?.entries || []) {
      if (!consumedPresentations.has(entry.surfaceId)) {
        blockers.push(`empirical_presentation_authority_entry_unreported:${entry.surfaceId}`);
      }
    }
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const payload = {
    version: 1,
    kind: 'EmpiricalAssertionUniverseBinding',
    status: uniqueBlockers.length
      ? 'empirical_assertion_universe_binding_blocked'
      : 'empirical_assertion_universe_binding_verified',
    paperId: expectedPaperId,
    campaignId: expectedCampaignId,
    experimentRegistryHash: expectedExperimentRegistryHash,
    empiricalAssertionAuthorityHash: authority?.empiricalAssertionAuthorityHash || null,
    empiricalPresentationAuthorityHash:
      presentationAuthority?.empiricalPresentationAuthorityHash || null,
    empiricalAssertionUniverseHash: universe?.empiricalAssertionUniverseHash || null,
    manuscriptCorpusHash: universe?.manuscriptCorpusHash || null,
    bindings: Object.freeze(bindings),
    presentationBindings: Object.freeze(presentationBindings),
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    empiricalAssertionUniverseBindingHash: hashRecord('EmpiricalAssertionUniverseBinding', payload),
  });
}

export function assertionMarkerDeclarationValid(value) {
  return hasExactObjectKeys(value, ['version', 'assertionId', 'authorityEntryHash'])
    && value?.version === 1
    && IDENTIFIER.test(String(value?.assertionId || ''))
    && SHA256.test(String(value?.authorityEntryHash || ''));
}
