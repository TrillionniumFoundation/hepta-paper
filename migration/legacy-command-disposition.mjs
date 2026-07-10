import crypto from 'node:crypto';

const NATIVE_REPLACEMENT_ROUTES = Object.freeze({
  'compile-source': 'paper-production-core batch-run --mode local-build',
  package: 'paper-production-core batch-run --mode local-package',
  'package-all': 'paper-production-core batch-run --mode local-package',
  'package-verify': 'paper-production-core batch-run --mode local-package',
  'paper-production-core-audit': 'paper-production-core batch-run --mode inventory',
  'paper-production-repair-loop': 'paper-production-core batch-run --mode referee-autopilot',
  'referee-revision-worker': 'paper-production-core batch-run --mode referee-revise',
  'referee-revision-worker-batch': 'paper-production-core batch-run --mode referee-revise',
  'referee-revision-round-runner': 'paper-production-core batch-run --mode referee-autopilot',
  'submission-preflight': 'paper-production-core batch-run --mode reviewed-submit',
});

const REPORT_ONLY_MARKERS = /(?:audit|status|readiness|capstone|matrix|roadmap|dashboard|report|doctor|hygiene|latest|freshness|checklist|ledger|index|manifest|receipt|preflight|gate|plan|packet|contract|verifier|validation|lint|smoke|fixture|snapshot)/;
const PAPER_SEMANTIC_FAMILY = /^(?:paper-production|research-compute|referee-revision|submission|source|venue|package|compile|artifact|proof|external-submission)/;
const DATA_EXPORT_FAMILY = /^(?:archive|export|import|registry|schema|template)/;

function sha256Text(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function extractLegacyParserCommands(sourceText) {
  const commands = [];
  const pattern = /\.add_parser\(\s*['"]([^'"]+)['"]/g;
  let match;
  let sourceLine = 1;
  let previousIndex = 0;
  while ((match = pattern.exec(sourceText)) !== null) {
    for (let index = previousIndex; index < match.index; index += 1) {
      if (sourceText.charCodeAt(index) === 10) sourceLine += 1;
    }
    previousIndex = match.index;
    commands.push({ command: match[1], sourceLine });
  }
  return commands;
}

function pendingTarget(command) {
  if (/^research-compute/.test(command)) return 'paper-adapters/research-verify';
  if (/referee/.test(command)) return 'paper-adapters/referee-review+referee-revise';
  if (/submission|external-submission/.test(command)) return 'paper-adapters/submission';
  if (/venue/.test(command)) return 'paper-adapters/venue-resolve+journal-manage';
  if (/source/.test(command)) return 'paper-adapters/source-adapt+build-package';
  if (/package|compile|artifact/.test(command)) return 'paper-adapters/build-package';
  return 'paper-core/src/paper-batch-runner.mjs+paper-core/src/contracts';
}

export function dispositionForLegacyCommand(command) {
  if (NATIVE_REPLACEMENT_ROUTES[command]) {
    return {
      disposition: 'native_hepta_replacement_route',
      target: NATIVE_REPLACEMENT_ROUTES[command],
      rationale: 'canonical local paper-production route exists in hepta-paper',
    };
  }
  if (REPORT_ONLY_MARKERS.test(command)) {
    return {
      disposition: 'quarantined_report_or_control_evidence',
      target: 'runtime/legacy-retirement audit archive',
      rationale: 'report/gate/capstone surface is retained only as non-authoritative audit evidence',
    };
  }
  if (PAPER_SEMANTIC_FAMILY.test(command)) {
    return {
      disposition: 'blocked_pending_p1_semantic_migration',
      target: pendingTarget(command),
      rationale: 'legacy command is unavailable from the canonical hepta entrypoint until its P1 symbol matrix row is complete',
    };
  }
  if (DATA_EXPORT_FAMILY.test(command)) {
    return {
      disposition: 'legacy_data_export_only',
      target: 'hepta-native SQLite/import-only migration tooling',
      rationale: 'legacy command may describe source data but is not an executable hepta control-plane route',
    };
  }
  return {
    disposition: 'retired_outside_hepta_paper_control_plane',
    target: null,
    rationale: 'command belongs to the legacy multi-product factory rather than the hepta-paper product surface',
  };
}

export function buildLegacyCommandDispositionManifest({
  sourceText,
  sourcePath = 'bin/paperctl',
} = {}) {
  const extracted = extractLegacyParserCommands(sourceText);
  const entries = extracted.map(({ command, sourceLine }) => ({
    command,
    sourceLine,
    ...dispositionForLegacyCommand(command),
    legacyExecutionAllowed: false,
    externalActionAllowed: false,
  }));
  const counts = Object.fromEntries(Object.entries(entries.reduce((result, entry) => {
    result[entry.disposition] = (result[entry.disposition] || 0) + 1;
    return result;
  }, {})).sort(([left], [right]) => left.localeCompare(right)));
  return {
    version: 1,
    kind: 'LegacyPaperctlCommandDispositionManifest',
    source: {
      path: sourcePath,
      sha256: sha256Text(sourceText),
      commandCount: entries.length,
    },
    policy: {
      canonicalEntrypoint: 'paper-production-core',
      legacyEntrypointAllowed: false,
      unlistedLegacyCommandAllowed: false,
      pendingP1CommandAllowed: false,
      reportOnlyCommandAuthoritative: false,
      liveExternalActionAllowed: false,
    },
    counts,
    entries,
  };
}
