// Domain-owned command vocabulary. Execution topology belongs exclusively to
// the campaign plan factory; this registry must not grow a second stage graph.
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

const definitions = Object.values(PAPER_BATCH_MODES).map((mode) => (
  mode === PAPER_BATCH_MODES.REFEREE_AUTOPILOT
    ? { mode, aliasFor: PAPER_BATCH_MODES.LOCAL_REVIEW_LOOP }
    : { mode }
));

export const PAPER_MODE_REGISTRY = Object.freeze(Object.fromEntries(definitions.map((definition) => [
  definition.mode,
  Object.freeze({ ...definition }),
])));

export function paperModeDefinition(mode) {
  return PAPER_MODE_REGISTRY[mode] || null;
}

export function assertPaperMode(mode) {
  const definition = paperModeDefinition(mode);
  if (!definition) throw new Error(`Unknown paper batch mode: ${mode}`);
  return definition;
}
