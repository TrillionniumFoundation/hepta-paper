export const RUNTIME_PERMISSION_SCAN_LIMITS = Object.freeze({
  defaultMaximumEntries: 1_000_000,
  hardMaximumEntries: 10_000_000,
  defaultMaximumDirectoryEntries: 250_000,
  hardMaximumDirectoryEntries: 1_000_000,
  defaultMaximumDepth: 256,
  hardMaximumDepth: 1_024,
  defaultReportLimit: 2_000,
  hardReportLimit: 10_000,
  defaultMaximumExecutePlanEntries: 100_000,
  hardMaximumExecutePlanEntries: 1_000_000,
});

export function resolveRuntimePermissionLimits({
  maximumEntries,
  maximumDirectoryEntries,
  maximumDepth,
  reportLimit,
  maximumExecutePlanEntries,
} = {}) {
  const configured = (value, suffix, minimum = 1) => {
    const selected = value === undefined
      ? RUNTIME_PERMISSION_SCAN_LIMITS[`default${suffix}`]
      : value;
    if (!Number.isSafeInteger(selected)
      || selected < minimum
      || selected > RUNTIME_PERMISSION_SCAN_LIMITS[`hard${suffix}`]) {
      const label = suffix.replace(/[A-Z]/g, (part) => `_${part.toLowerCase()}`).slice(1);
      throw new Error(`runtime_permission_${label}_invalid`);
    }
    return selected;
  };
  return Object.freeze({
    maximumEntries: configured(maximumEntries, 'MaximumEntries'),
    maximumDirectoryEntries: configured(maximumDirectoryEntries, 'MaximumDirectoryEntries'),
    maximumDepth: configured(maximumDepth, 'MaximumDepth', 0),
    reportLimit: configured(reportLimit, 'ReportLimit'),
    maximumExecutePlanEntries: configured(maximumExecutePlanEntries, 'MaximumExecutePlanEntries'),
  });
}
