# Current machine-intake V1 health

This is a read-only native consumer of the incumbent configuration, static
intake documents, machine-intake database and resident status. It does not enqueue
work, create a lease, run a provider, verify deployment acceptance or transfer a
writer. A report or record hash cannot be used as an opaque authority capability.

## Actual entry points

`inspect_machine_intake_status_v1(runtime_root, environment, working_directory,
now_millis)` observes intake readiness. The explicit environment is an allowlist
of configuration/plugin selectors and the two provider principals' declared
strings. `inspect_supervisor_health_current_intake_v1` combines this observation
with the resident database. The real `hepta-autonomous-supervisor-health
--require-current-machine-intake` command invokes that composition and exits 0
only when its current intake identity matches the ready resident.

`autonomous_provider_configuration.rs` ports the original precedence rules:
CLI overrides, role environment values and the documented author-home fallback
for the formal reviewer. `auto` normalizes to `codex`; unsupported providers
fail. Relative binary paths containing `/` and homes resolve lexically against
the supplied working directory. JavaScript whitespace is handled explicitly,
including U+FEFF and excluding U+0085. No credential home or executable is opened.
The verifier reconstructs the normalized record and recomputes the production
Node record digest; the optional expected digest is checked separately.

## Input validation and supported scope

Configuration schema V1 is implemented, containing at most 256 static files and
16 recurring golden templates. The actual static files must contain normalized
production-run intake records, with exact hashes matching the configuration.
Templates and intake rows validate exact keys, identifiers, campaign/paper
relationships, canonical times, objectives, one dataset mount, provider identity,
revisions/referees, complete resource budgets and their original hash domains.
Intake records are version 2; that is distinct from configuration schema V1 and
admission records version 1.

The five builtin empirical families use the original campaign resource closure,
including retry multiplicity, referee and revision counts, seed schedule and
minimum repetitions. Golden budgets must both satisfy that closure and remain
inside their hard ceilings. The configuration enforces daily aggregate campaign,
cost, agent, CPU, GPU, token and wall-time exposure. Declared hashes alone do not
satisfy these checks. Objectives require the original canonical NFKC form, text
limits and placeholder rejection. `unicode-normalization` is pinned to 0.1.25,
whose tables use Unicode 17.0, matching the qualified Node runtime.

This slice supports ordinary normalized dataset mounts with the incumbent SPDX
allowlist or LicenseRef authorization-hash fields. It explicitly blocks local
golden authority scopes, configuration V2, admission V2 and externally supplied
empirical plugin registries. V2 production requires actual topic profile,
implementation, dataset and liveness observations plus external genesis/rotation
authority; these must not be replaced by supplied JSON `ready` fields. Strict
reconciliation now has a separate [native diagnostic reader](../strict_machine_intake_reconciliation/HANDOFF.md); fully autonomous health remains unsupported.

## Files, SQLite and resources

Each configuration/static JSON file is bounded to 1 MiB, regular, non-group/other
writable and opened no-follow/nonblocking. Directory descriptors retain the
actual path walk; leaf identity, mode, size and modification/change timestamps
are checked before and after reads and before returning the observation.
Canonical input roots and their full ancestor path may not contain symlinks;
this is stricter than the incumbent's leaf-only file check. The native parser
also refuses JSON strings containing unpaired UTF-16 surrogates. Those input
restrictions remain explicit compatibility differences.

The configuration owner derives the report and closes all file descriptors
before any database snapshot opens. This prevents unrelated regular-file closes
from interfering with POSIX process-scoped SQLite locks. A private snapshot
uses the existing `state_database_inventory` source/sidecar observation and
post-read identity checks. The intake reader uses the effective-state snapshot,
including the actual observed WAL and an owned private SHM inode; only those
private files enter SQLite. It does not recover or mutate live WAL/journal state.
The pre-existing resident health reader retains its separate main-file semantics.

Database status supports legacy generation-one authority with no producer,
genesis or rotation evidence. It verifies metadata, migration-required columns,
ordinary table types and the empty authority history; V2 authority is explicitly
blocked. Pending rows use the original order and limit of 100, with exact intake
and admission hash/identity/source bindings and lease projection. Individual
text fields are bounded to 1 MiB and the projected pending result to 16 MiB.
Persisted retry timestamps accept canonical instants and common full-second
ISO/SQLite strings, with optional fractions and `Z` or signed HH:MM/HHMM offsets.
The original string remains unchanged and SQL retains its original lexical
comparison; unzoned values are validated for parseability, not converted to UTC.
Retry input is bounded to 128 ASCII bytes. Locale text, date-only strings,
calendar rollover and 24:00 normalization remain unsupported Node `Date.parse`
spellings. Malformed SQLite diagnostics may
be normalized to the native state-invalid code.

Observations across configuration files, the intake database and the resident
snapshot are not an atomic snapshot of all three. They report checked data at
inspection time and cannot authorize a later dispatch. The source private-file
and size policy can refuse an input the incumbent would attempt to read.

## Output and failure behavior

The intake projection retains the incumbent fields, blocker ordering, nullable
identities, pending order and counts for the supported profile. Missing or invalid
configuration, provider mismatch, unbound/mismatched persisted configuration,
invalid intake/admission and unsupported evidence all prevent readiness. An
unavailable state yields no projected rows. Configured work is never loaded into
the repository by this observer.

The health composition retains the base report and adds the incumbent current
configuration/dataset comparison fields. Without selecting fully autonomous or
strict mode, their inspection values are null and their readiness values false,
as in the incumbent current-intake mode. Exit 2 means a valid diagnostic report
that is not ready; parser/unsupported-mode errors retain exit 1.

## Verification

The executable oracle imports the original Node provider resolver, intake and
template builders, configuration loader, repository and health inspection. Its
private fixtures use actual original SQLite provisioning and append/lease calls.
Negative fixtures deliberately alter real documents/rows, including recomputing
hashes around insufficient budgets, so hash mismatch is not the only failure
mechanism. Every oracle result verifies the qualified Node/ICU/CLDR/Unicode and
actual record-hash source profile. Child execution, output capture and cleanup
are bounded; no fixture grants independent host or production acceptance.

Provider differential tests cover precedence, whitespace, paths, normalization,
unsupported values, altered records and expected-hash mismatch. NFKC tests compare
all 1,112,064 Unicode scalars with actual Node and separately exercise composing
sequences. The intake, resident health and actual CLI tests cover the supported
positive path and refusal cases. See the enclosing validation manifest for the
exact executed test commands and results; this handoff is not a test receipt.
