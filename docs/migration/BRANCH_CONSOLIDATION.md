# Two persistent source trees

The repository retains two long-lived integration/baseline branches; temporary
review heads may coexist while their exact differences are resolved:

- `main`: original Node baseline at `7176fdad2d5fd8ae42b6e0b89c78783f938d8bc2`.
- `codex/full-rust-replacement-progress-20260916`: the consolidated Rust rewrite.

This is source and repository organization. It does not enable a Rust writer,
qualify a provider, accept parity, or retire Node. Existing exact-subject CI and
independent evidence requirements remain in force. New local compatibility
contracts preserve earlier public data formats without replacing current
operational owners or silently redirecting command routes.

## Review and recovery record

The pre-cleanup inventory contained 228 remote heads, 49 ancestors, one matching
Rust candidate tree and 178 divergent histories. The source audit was bound to
`fa52364166e5fb308ae9795e11e2556de9f82f38`; the subsequent topic-status checkpoint
is `104999b51a36ca3bbf2d09658cae64577d13c084`. Preserve these observations as
historical evidence. A new inventory containing only two names is not evidence
that removed branches had no differences.

All refs and detached worktree commits were saved in a verified Git bundle
before retirement; its SHA-256 is
`1b1cda676082057e892531d8c467de59568fb322a23d158003db30fb93591d61`.
Eight worktrees' modified/untracked files were separately archived with exact
byte hashes. Six superseded worktrees and a duplicate clean Node clone were
retired after verification; original `main` and the Rust worktree remain.
Fifty pending/draft files and four earlier local finalization files were moved
to the recovery archive. Build target caches are reproducible and were not
included in source backups.

The remaining task scratch directory is preserved under `retired-task-work`
in the same recovery root, with every regular file and symlink checked before
and after the move. Its eight source-copy directories have no Git metadata.
Among 6,001 production-source candidates, 5,269 match current bytes and 696
are already in candidate history. Exact diffs for the other 36 files (20 unique
blobs) show intermediate snapshots or formatting changes; no additional
implementation was selected. Scratch inventory and dispositions remain in the
task output record. Current repository dependencies do not point into those
scratch directories.

The local recovery root is `outputs/hepta-consolidation-20260922` in the task
workspace. Its manifests bind source bundle, original refs, working-file tar
archives, per-file decisions and final remote inventory. Recover named refs
into a separate repository with `git clone /absolute/path/all-refs-before.bundle`;
recover an old detached worktree from its recorded commit, then apply its
saved binary patches and owned working-file archive. These archives contain
source/history, not a production state backup or external authority evidence.

## Source decisions

Current source wins where it includes the old behavior with later fixes or
stricter ownership. Divergent contracts with different public wire/hash formats
are kept under explicit compatibility namespaces; current routes retain their
existing contracts. Obsolete source transports, probes and prototype runtime
wrappers are retained in the historical archive, not installed as current
runtime entry points.

The broker/runtime/protocol review compares 51 exact path/blob variants with
the current source. It retains current peer/schema/trust/time/gate semantics.
A separate 50-variant review plus the absent hierarchical wrapper review
identifies distinct legacy contracts to preserve. Earlier seven exact-file
reviews cover the other absent source paths. Source lineage and per-branch
decisions remain distinct from independently accepted parity.

Imported families include prepared submission packages, hierarchical supplied
resource ledgers, predictor calibration/selection, retained telemetry,
module-version calibration and matched-workload planner comparisons. Legacy
read-only projections and bounded computational profiles retain their own
formats and limits. Their handoffs describe known constraints; supplied hashes,
booleans, reports or prepared data never become execution authority.

The existing Node baseline remains available for differential tests. Full Rust
replacement still depends on actual production call-chain integration and the
existing external acceptance gates; branch consolidation does not close them.

The resolved integration retains all 169 divergent Rust-bearing branch tips
and both detached startup commits in Rust history. Of these branches, 45 add
Rust-changing commits outside the prior candidate history; the other 124 add
ancillary changes over an existing Rust tree. Redundant ancestor tips reduce
to 88 merge parents, including the prior candidate. This is an explicit manual
resolution: the current tree plus the reviewed compatibility ports wins;
obsolete transports, prototype writers and old receipt subjects do not become
active source. Nine divergent branches with no Rust tree remain in the verified
recovery bundle. History reachability does not imply behavioral equivalence.

## Evidence retained with this source

The [evidence index](consolidation-20260922/evidence-index.json) records stored
and decompressed SHA-256 hashes, so compressed historical records can be
checked against their original review inputs.

The compressed [pre-cleanup exact two-tree audit](consolidation-20260922/pre-cleanup-branch-audit.json.gz)
and [Rust lineage inventory](consolidation-20260922/hepta-rust-branch-lineage-audit-20260922.json.gz)
retain the full old branch/ref memberships. The
[broker/runtime review](consolidation-20260922/hepta-broker-runtime-consolidation-review-20260922.json.gz)
and [remaining source review](consolidation-20260922/hepta-remaining-source-consolidation-review-20260922.json.gz)
record exact old/current blobs and explicit differences. Original review
recommendations describe their pre-integration baseline; source port manifests
and validation in this change record the later implementation decisions.

The [final source decision ledger](consolidation-20260922/final-source-decision-ledger.json.gz)
maps all 240 old path/blob variants to current source or explicit historical
retention. The [branch disposition plan](consolidation-20260922/branch-disposition-plan.json.gz)
binds all 178 divergent tips and their complete original two-tree diffs;
its [binding check](consolidation-20260922/branch-disposition-binding.json)
does not assert independent review or acceptance.

The broker/runtime review's exact original lineage input is separately retained
as `lineage-review-original-input.json.gz`; the later lineage inventory adds
follow-up artifact references. Neither original review bytes nor source hashes
are rewritten to fit the integration.

## Continuing development

Use the Rust branch as the single integration surface and keep Node `main`
unchanged during this migration. Temporary reviewed work should converge back
and its temporary refs should be retired with recovery evidence. Never use a
mirror push for this repository. Current-candidate pointers and manual workflow
defaults select the retained Rust branch; immutable old receipt subjects keep
their original commit/tree identities. No old transport may self-commit into
this branch.

The default branch remains original `main`. It does not contain
`functional-evidence-prep.yml` or `legacy-matrix-reference-verification.yml`;
their retained manual definitions are therefore not currently dispatchable
hosted validation lanes. GitHub requires a `workflow_dispatch` definition on
the default branch. This cleanup does not modify Node `main` to install them.

Fifteen existing draft PR heads are retired with their branches; eleven also
use a retired base. Their original identities and before/after GitHub states
are retained in the recovery record. They are superseded by source
consolidation, not recorded as merged, qualified or accepted. No old PR review
or check result transfers to this integration commit.

## Current PR convergence: 2026-09-23

The active review lane is #139, `codex/full-rust-final-closure-20260923`,
targeting the retained Rust integration branch. `main` remains the Node baseline.
This is a review routing decision, not a claim that the candidate is qualified.

PR #137 head `aa1749db011af350a1245a12ea168b82ce169e35` is an ancestor of
#139's reviewed starting head `655d3265cd3fd9b2c1d2958969a515cead02226b`.
It was closed as superseded; no branch or historical evidence was deleted.

PR #140 head `528e0fe0f341947d7fe379b717776f4ffba61198` was compared by all
seven changed paths, not assumed merged from commit counts. Its scientific
verifier implementation/test subtree already matches #139. Keep #139's narrowed
evidence wording and existing autonomous entry: nonmutating prepare, live-clock
admission, definition/revision-bound continuation, amendment and signal
cancellation. Do not replace these with #140's alternate flags, caller-supplied
`--now`, prepare-time state creation or unobserved external-effect assertions.
The existing real CLI/workflow/replay/interruption tests cover the retained path.
#140 was closed as superseded; its source branch remains review history.

Remaining temporary transport and divergent heads retain their exact source
objects. Their existence is not another active product completion claim. No
history deletion, mirror push, imported green check or automatic Node retirement
is authorized by this review routing update.
