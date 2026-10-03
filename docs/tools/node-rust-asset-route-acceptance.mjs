// Fixed incumbent Date.parse/coercion domains. A descriptor is fixture data;
// authority and current-subject acceptance remain in the original consumer.
import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
export const ASSET_DOMAIN_PROFILES_V1 = deepFreezeJsonValue([
  {
    "profile": "domain/date-rfc",
    "kind": "date",
    "value": "Thu, 01 Jan 2026 00:00:00 GMT",
    "expectedState": "ready"
  },
  {
    "profile": "domain/date-only",
    "kind": "date",
    "value": "2026-01-01",
    "expectedState": "ready"
  },
  {
    "profile": "domain/date-offset",
    "kind": "date",
    "value": "2026-01-01T00:00:00+05:30",
    "expectedState": "ready"
  },
  {
    "profile": "domain/date-month-invalid",
    "kind": "date",
    "value": "2026-13-01T00:00:00Z",
    "expectedState": "blocked"
  },
  {
    "profile": "domain/date-day-invalid",
    "kind": "date",
    "value": "2026-01-32T00:00:00Z",
    "expectedState": "blocked"
  },
  {
    "profile": "domain/date-rollover",
    "kind": "date",
    "value": "2026-02-31T00:00:00Z",
    "expectedState": "ready"
  },
  {
    "profile": "domain/date-hour-invalid",
    "kind": "date",
    "value": "2026-01-01T25:00:00Z",
    "expectedState": "blocked"
  },
  {
    "profile": "domain/date-midnight-next",
    "kind": "date",
    "value": "2026-01-01T24:00:00Z",
    "expectedState": "ready"
  },
  {
    "profile": "domain/date-midnight-fraction-invalid",
    "kind": "date",
    "value": "2026-01-01T24:00:00.001Z",
    "expectedState": "blocked"
  },
  {
    "profile": "domain/date-second-invalid",
    "kind": "date",
    "value": "2026-01-01T00:00:61Z",
    "expectedState": "blocked"
  },
  {
    "profile": "domain/date-z-suffix-invalid",
    "kind": "date",
    "value": "2026-01-01T00:00:00Zjunk",
    "expectedState": "blocked"
  },
  {
    "profile": "domain/date-fraction-truncated",
    "kind": "date",
    "value": "2026-01-01T00:00:00.",
    "expectedState": "blocked"
  },
  {
    "profile": "domain/date-offset-truncated",
    "kind": "date",
    "value": "2026-01-01T00:00:00+",
    "expectedState": "blocked"
  },
  {
    "profile": "domain/date-offset-invalid",
    "kind": "date",
    "value": "2026-01-01T00:00:00+99:00",
    "expectedState": "blocked"
  },
  {
    "profile": "domain/date-offset-compact",
    "kind": "date",
    "value": "2026-01-01T00:00:00+0530",
    "expectedState": "ready"
  },
  {
    "profile": "domain/date-fraction",
    "kind": "date",
    "value": "2026-01-01T00:00:00.1Z",
    "expectedState": "ready"
  },
  {
    "profile": "domain/date-submillisecond",
    "kind": "date",
    "value": "2026-01-01T00:00:00.0001Z",
    "expectedState": "ready"
  },
  {
    "profile": "domain/date-impossible-iso",
    "kind": "date",
    "value": "2026-99-99T99:99:99Z",
    "expectedState": "blocked"
  },
  {
    "profile": "domain/date-number",
    "kind": "date",
    "value": 1,
    "expectedState": "ready"
  },
  {
    "profile": "domain/date-zero",
    "kind": "date",
    "value": 0,
    "expectedState": "blocked"
  },
  {
    "profile": "domain/date-false",
    "kind": "date",
    "value": false,
    "expectedState": "blocked"
  },
  {
    "profile": "domain/date-null",
    "kind": "date",
    "value": null,
    "expectedState": "blocked"
  },
  {
    "profile": "domain/date-array-iso",
    "kind": "date",
    "value": [
      "2026-01-01T00:00:00.000Z"
    ],
    "expectedState": "ready"
  },
  {
    "profile": "domain/date-array-rfc",
    "kind": "date",
    "value": [
      "Thu, 01 Jan 2026 00:00:00 GMT"
    ],
    "expectedState": "ready"
  },
  {
    "profile": "domain/source-array",
    "kind": "field",
    "field": "sourcePath",
    "value": [
      "asset"
    ],
    "expectedState": "ready"
  },
  {
    "profile": "domain/identity-array",
    "kind": "field",
    "field": "identityFile",
    "value": [
      "asset/identity.txt"
    ],
    "expectedState": "ready"
  },
  {
    "profile": "domain/storage-array",
    "kind": "field",
    "field": "currentStorage",
    "value": [
      "repository"
    ],
    "expectedState": "ready"
  },
  {
    "profile": "domain/target-array",
    "kind": "field",
    "field": "targetStorage",
    "value": [
      "immutable-registry"
    ],
    "expectedState": "ready"
  },
  {
    "profile": "domain/storage-false",
    "kind": "field",
    "field": "currentStorage",
    "value": false,
    "expectedState": "blocked"
  },
  {
    "profile": "domain/target-zero",
    "kind": "field",
    "field": "targetStorage",
    "value": 0,
    "expectedState": "blocked"
  },
  {
    "profile": "domain/id-array",
    "kind": "field",
    "field": "assetId",
    "value": [
      "fixture"
    ],
    "expectedState": "blocked"
  },
  {
    "profile": "domain/expected-array",
    "kind": "field",
    "field": "expectedIdentitySha256",
    "value": [
      "$IDENTITY_SHA256"
    ],
    "expectedState": "blocked",
    "usesIdentityHash": true
  },
  {
    "profile": "domain/migration-array",
    "kind": "field",
    "field": "migrationStatus",
    "value": [
      "externalized"
    ],
    "expectedState": "blocked"
  },
  {
    "profile": "domain/source-outside",
    "kind": "field",
    "field": "sourcePath",
    "value": "../outside",
    "expectedState": "blocked"
  },
  {
    "profile": "domain/identity-outside",
    "kind": "field",
    "field": "identityFile",
    "value": "../outside",
    "expectedState": "blocked"
  },
  {
    "profile": "domain/storage-rounded-number",
    "kind": "field",
    "field": "currentStorage",
    "value": "controlled-rounded-number-input",
    "expectedState": "ready",
    "rawJsonValue": "9007199254740993"
  },
  {
    "profile": "domain/id-rounded-object",
    "kind": "field",
    "field": "assetId",
    "value": {
      "id": "controlled-rounded-number-input"
    },
    "expectedState": "blocked",
    "rawJsonValue": "{\"id\":9007199254740993}"
  },
  {
    "profile": "domain/migration-inherited-function",
    "kind": "field",
    "field": "migrationStatus",
    "value": "toString",
    "expectedState": "pending"
  },
  {
    "profile": "domain/migration-inherited-object",
    "kind": "field",
    "field": "migrationStatus",
    "value": "__proto__",
    "expectedState": "pending"
  },
  {
    "profile": "domain/retention-object",
    "kind": "field",
    "field": "retentionPolicy",
    "value": {
      "policy": "retain"
    },
    "expectedState": "ready"
  },
  {
    "profile": "domain/kind-array",
    "kind": "field",
    "field": "requiredExternalReferenceKind",
    "value": [
      "content-addressed-artifact"
    ],
    "expectedState": "blocked"
  }
]);

// Retain the complete semantic refusal, including spaces and all blockers.
// Only incumbent Error/stack framing and the native executable prefix differ.
export function assetHandoffDiagnosticV1(stderr) {
  if (typeof stderr !== 'string') throw new Error('asset_handoff_diagnostic_invalid');
  const message = 'repository_asset_externalization_handoff_blocked:';
  const native = 'hepta-paper-rust: ';
  if (stderr.startsWith(native + message)) {
    if (!stderr.endsWith('\n')) throw new Error('asset_handoff_diagnostic_invalid');
    return stderr.slice(native.length, -1);
  }
  const lines = stderr.split('\n');
  const starts = lines.flatMap((line, index) => line.startsWith('Error: ' + message) ? [index] : []);
  if (starts.length === 0) return null;
  if (starts.length !== 1) throw new Error('asset_handoff_diagnostic_ambiguous');
  const start = starts[0];
  const end = lines.findIndex((line, index) => index > start && /^    at /u.test(line));
  if (end <= start) throw new Error('asset_handoff_diagnostic_invalid');
  return lines.slice(start, end).join('\n').slice('Error: '.length);
}
