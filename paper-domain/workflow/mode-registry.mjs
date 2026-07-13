// Domain-owned workflow vocabulary and stage graph.
export const PAPER_BATCH_MODES = Object.freeze({
  INVENTORY: 'inventory',
  LOCAL_BUILD: 'local-build',
  LOCAL_PACKAGE: 'local-package',
  REFEREE_REVIEW: 'referee-review',
  REFEREE_REVISE: 'referee-revise',
  LOCAL_REVIEW_LOOP: 'local-review-loop',
  REFEREE_AUTOPILOT: 'referee-autopilot',
  EMPIRICAL_ANALYSIS: 'empirical-analysis',
  RESEARCH_VERIFY: 'research-verify',
  JOURNAL_MANAGE: 'journal-manage',
  VENUE_RESOLVE: 'venue-resolve',
  SOURCE_ADAPT: 'source-adapt',
  LOCAL_DRY_RUN: 'local-dry-run',
  REVIEWED_SUBMIT: 'reviewed-submit',
});

const definitions = [
  { mode: PAPER_BATCH_MODES.INVENTORY, stages: [] },
  { mode: PAPER_BATCH_MODES.LOCAL_BUILD, stages: ['build'] },
  { mode: PAPER_BATCH_MODES.LOCAL_PACKAGE, stages: ['build', 'research-verify', 'package'] },
  { mode: PAPER_BATCH_MODES.REFEREE_REVIEW, stages: ['referee-review'] },
  { mode: PAPER_BATCH_MODES.REFEREE_REVISE, stages: ['referee-revise'] },
  { mode: PAPER_BATCH_MODES.LOCAL_REVIEW_LOOP, stages: ['local-review-loop'] },
  { mode: PAPER_BATCH_MODES.REFEREE_AUTOPILOT, aliasFor: PAPER_BATCH_MODES.LOCAL_REVIEW_LOOP, stages: ['local-review-loop'] },
  { mode: PAPER_BATCH_MODES.EMPIRICAL_ANALYSIS, stages: ['empirical-analysis'] },
  { mode: PAPER_BATCH_MODES.RESEARCH_VERIFY, stages: ['research-verify'] },
  { mode: PAPER_BATCH_MODES.JOURNAL_MANAGE, stages: ['journal-manage'] },
  { mode: PAPER_BATCH_MODES.VENUE_RESOLVE, stages: ['build', 'package', 'venue-resolve'] },
  { mode: PAPER_BATCH_MODES.SOURCE_ADAPT, stages: ['source-adapt'] },
  { mode: PAPER_BATCH_MODES.LOCAL_DRY_RUN, stages: ['build', 'research-verify', 'package', 'submission'] },
  { mode: PAPER_BATCH_MODES.REVIEWED_SUBMIT, stages: ['build', 'research-verify', 'package', 'submission'] },
];

export const PAPER_MODE_REGISTRY = Object.freeze(Object.fromEntries(definitions.map((definition) => [
  definition.mode,
  Object.freeze({ ...definition, stages: Object.freeze([...definition.stages]) }),
])));

export function paperModeDefinition(mode) {
  return PAPER_MODE_REGISTRY[mode] || null;
}

export function assertPaperMode(mode) {
  const definition = paperModeDefinition(mode);
  if (!definition) throw new Error(`Unknown paper batch mode: ${mode}`);
  return definition;
}
