# Ordinary local batch report persistence v1

The normal `operator batch -- ARGV` frontend calls
`persist_native_local_batch_report_v1` only when `--write-report` is present,
after the held inventory proof and bounded report serialization. It writes a
result detail JSON, timestamped report JSON and Markdown, and latest pointer
JSON and Markdown. Each artifact has its actual CAS object, manifest and ledger
receipt. The complete original report remains stdout; persistence failures keep
the existing error/exit behavior. Preview without the flag has no write effects.

This is local research persistence. It does not acquire a provider, writer
lease, business-store mutation handle, scientific acceptance, release or
submission authority. `--execute` remains a separately refused implementation
domain until the existing coordinator/workflow chain is composed.

## Writer and recovery ownership

The existing held-directory traversal, ObjectStore CAS, Flock, nofollow opens,
rename and synchronization primitives are reused. `LocalReportDirectoryV1`
admits ordinary owned group data directories, creates them with the fixed 0775
mode subject to umask, and never chmods existing directories. The receipt ledger
uses the original fixed 0700 creation policy. Private `Directory` retains its
original authority UID and permission guards; local data cannot construct
private authority. Alias, world-write, identity or permission replacement is
refused. Ancestor identities deliberately allow legitimate sibling activity;
this is not hostile-UID namespace isolation or kernel inode compare-and-swap.

`runtime/local-report-publication-v1` is private 0700 with a 0600 nonblocking
Flock, an actual runtime RootBinding with authority false, isolated staging and
bounded prepared records. Torn unprepared attempts stay present; a fresh attempt
uses a new isolated directory. Only exact known pre/postimages reconcile.
Foreign targets or displaced bytes and unknown records stay in place, retain
their original evidence and refuse; there is no blind inverse EXCHANGE.
Known done records permit owned duplicate-copy compaction. At 256 retained
entries, this profile refuses rather than deleting unknown or torn material.

## Original Node effects and explicit differences

The original writer produces five report artifacts, five CAS objects, five
manifests, five ledger receipts and ten vault records. Native persistence
absorbs the first twenty semantic/provenance effects and supersedes the ten
Node vault records with its versioned recovery namespace. Complete existing
Node vault records are observed and retained unchanged. Prepared, partial,
changed, foreign or unknown Node vault material is not adopted or removed.

The ordered production JSON codec supplies bounded two-space pretty output
using the original Number and UTF-16 rules while retaining existing compact and
stable hash modes. Pure tests pass actual original Node report wire and compare
all five output byte buffers. The ordinary native report can have different
nested object-key order; its normal suite verifies complete Values and actual
receipt bytes rather than claiming byte-identical Node serialization.

Each detail/output is at most 16 MiB; the four outputs after the independently
admitted detail share a 40 MiB preallocation bound. Encoding also bounds one
million values and eight MiB UTF-16 units. Dates use canonical 24-byte ASCII
four-digit-year ISO values. Extended dates and larger Node inputs are outside
this native profile. Existing 300s cooperative admission and normal child
budgets are unchanged; uninterruptible kernel work is not preempted.

## Executable verification owners

`batch_local_reports::tests` verifies original Node five-artifact byte output and
Pretty2 plus compact hash behavior. `batch_local_reports::persistence::tests`
verifies original Node receipt sources, 18 durable phases under actual SIGTERM
and SIGKILL with fresh recovery, torn staging, cancellation/deadline, foreign
targets/displaced bytes, and retained original Node vault refusals. The ignored
`local_report_process_child_entry` is a fixture child, not behavior acceptance.

`paper-core/tests/native-batch-local-reports-normal.test.mjs` builds its own
current executable and copies the fixed physical ROOT/bin and original Node
module/SQL/package graph. Its four normal owners compare original Node then
native in the same namespace, original receipt verification, fresh retry,
umask 0002/0022 and existing group data modes, unknown/alias/world-write refusal,
and actual prepared visibility followed by SIGTERM/SIGKILL and same-argv fresh
recovery. Prior-attempt recovered receipts are verified separately from the
five current receipts. Prepared-name visibility is not claimed to prove the
parent fsync completed. The original database, source graph, Node vault bytes,
normal preview namespace and qualified tools are guarded before/after.

These source tests do not qualify an installed cutover, live provider billing,
independent accounts, exact-head or prospective-merge subject. The canonical
57-route operator/batch ledger remains partial; final composed H/M checks must
use fresh source subjects. Historical failed tests remain evidence of their
actual earlier source/harness scope.
