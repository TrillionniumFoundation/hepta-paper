import { normalizeText } from '../../workflow-kernel/runtime/text-utils.mjs';

function blockerFamilyFor(code) {
  const text = normalizeText(code).toLowerCase();
  if (/source|main_tex|tex/.test(text)) return 'source';
  if (/venue/.test(text)) return 'venue';
  if (/latex|compile|build/.test(text)) return 'build';
  if (/evidence|claim|proof|research|reproduc/.test(text)) return 'research_verify';
  if (/artifact|package|zip|pdf|checksum|sha256/.test(text)) return 'package';
  if (/runner|receipt|handoff|manifest|dry_run|replay/.test(text)) return 'runner_handoff';
  if (/approval|authorize|authorization|live_submit/.test(text)) return 'authorization';
  if (/submit|submission|portal|external/.test(text)) return 'submission';
  return 'other';
}

export function blockerFamilySummary(results = []) {
  const families = {};
  for (const result of results) {
    const blockers = result.state?.blockers || [];
    const seenFamiliesForPaper = new Set();
    for (const blocker of blockers) {
      const family = blockerFamilyFor(blocker);
      if (!families[family]) {
        families[family] = {
          family,
          paperCount: 0,
          blockerCount: 0,
          blockers: {},
          paperIds: [],
        };
      }
      families[family].blockerCount += 1;
      families[family].blockers[blocker] = (families[family].blockers[blocker] || 0) + 1;
      if (!seenFamiliesForPaper.has(family)) {
        families[family].paperCount += 1;
        families[family].paperIds.push(result.paperId);
        seenFamiliesForPaper.add(family);
      }
    }
  }
  return Object.fromEntries(
    Object.values(families)
      .sort((left, right) => right.paperCount - left.paperCount || left.family.localeCompare(right.family))
      .map((item) => [item.family, {
        ...item,
        paperIds: item.paperIds.slice(0, 32),
        topBlockers: Object.entries(item.blockers)
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .slice(0, 12)
          .map(([code, count]) => ({ code, count })),
      }]),
  );
}

export function makeBlockerFamilyMarkdown(families = {}) {
  const values = Object.values(families);
  if (!values.length) return '| family | papers | blockers | top_blockers |\n| --- | --- | --- | --- |\n';
  const lines = ['| family | papers | blockers | top_blockers |', '| --- | --- | --- | --- |'];
  for (const family of values) {
    const top = (family.topBlockers || [])
      .map((item) => `${item.code}:${item.count}`)
      .join(', ');
    lines.push(`| ${family.family} | ${family.paperCount} | ${family.blockerCount} | ${top.replace(/\|/g, '/')} |`);
  }
  return lines.join('\n') + '\n';
}
