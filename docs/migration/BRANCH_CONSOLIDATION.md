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

## Current candidate and callable entrypoints

The sole current continuation is PR #142,
`codex/native-product-recovery-20260924`, targeting
`codex/full-rust-replacement-progress-20260916`. The #139/#141 source and the
comparisons below are historical inputs, not competing completion candidates.
Read the current PR head/base and exact workflow subject before integration;
never copy a predecessor's green checks into the current candidate's status.

`hepta-paper-rust autonomous-research` remains the bounded local workflow entry.
`hepta-codex-broker <absolute-config.json>` is the separate installed
broker entry, using the existing configuration loader, dispatcher and journal.
A running broker is not a complete author/reviewer/revision workflow, and a
local workflow receipt is not a provider execution receipt. Their remaining
composition and command-mode gaps stay in the existing migration ledger.

The independent `rust-product-targets` workflow compiles every Rust workspace
library, binary, example and test target on both exact-head and deterministic
prospective-merge subjects. It runs independently of formatting and service-only
migration selection. Its evidence is compilation evidence, not executed tests,
provider qualification, production activation or Node retirement. Existing
runtime, recovery, source-evidence and strict-lint checks remain required.

## Signed delivery and current-source verification

Delivery continues on the same #142 head, not a new full-Rust branch. Preserve
all worktree changes before fetching; query the actual PR head/base and live
protection rather than treating a historical SHA or this document as current.

```sh
git fetch origin
gh pr view 142 --repo TrillionniumFoundation/hepta-paper --json headRefName,headRefOid,baseRefName,baseRefOid,state
gh api repos/TrillionniumFoundation/hepta-paper/branches/codex%2Ffull-rust-replacement-progress-20260916/protection
```

The delivery operation must bind the exact expected predecessor. GitHub's signed
`createCommitOnBranch` path is suitable when its returned commit has a verified
signature and its tree equals the locally reviewed tree. A failed/uncertain API
response requires reading the actual ref before retrying; it never permits a
force update, unsigned fallback or disabling required checks/signatures. Local
uncommitted changes and reference-only forks must not be reset to achieve a
nominally clean submission.

Every delivered head gets new exact-head and deterministic prospective-merge
verification against the freshly fetched integration base. These are different
subjects even when their trees match. Passing historical checks, source inventory
bindings or a signed delivery commit do not establish executed tests, independent
scientific review, installed cutover or release/submission authority. The
existing branch-convergence auditor records complete two-tree content comparisons
and explicit dispositions; its binding check is not independent acceptance.

## Archived content revalidation

`docs/tools/revalidate-history-dispositions.py` reads the archived **complete**
remote-head snapshot and original source-decision ledger from the selected commit,
not from mutable working files. The existing branch-inventory workflow publishes
its `history-content.json` beside the live inventory. It compares every recorded
tip directly to the current tree, deduplicates unique-tip comparisons, and binds
all old source blobs to the current selected paths. Historical ancestors are not
automatically classified as absorbed. Byte-identical content can be selected;
changed successors, unverified compatibility ports and missing objects remain
explicit references. Rejected prototypes are not resurrected by merge ancestry.

The report's `completeContentObservation` is separate from job execution success.
A runner without an archived object reports its exact missing OID and cannot
certify that content. All runtime, independent-review and activation fields stay
false. Existing source/call-chain tests and both current validation subjects remain
required; this inventory is not a new acceptance authority or duplicate test run.

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

## Historical PR convergence: 2026-09-23

On 2026-09-23 the review lane was #139,
`codex/full-rust-final-closure-20260923`, targeting the retained Rust integration
branch. PR #142 now continues that source. `main` remains the Node baseline.
This historical routing decision does not qualify a later candidate.

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

## Remaining temporary source dispositions: 2026-09-23

The following decisions compare the source reachable from the live tips with
`d55e7adc178e239266a3ed6617b8dea67352e3b1`, not just commit counts. They select
source for #139; they are not independent review approval or transferable CI.
References and encoded transport bytes remain intact for recovery. No second
product PR or execution owner is maintained by these retained names.

| Temporary head | Exact tip | Source disposition |
|---|---|---|
| `clock-validation-8f8be6d5` | `eb15218ed82159af8889f12d7a0577fd179b5e11` | Retain reference. Branch-only paths are encoded `.ci-transfer`/validation inputs and transient workflows, not active Rust owner code. Keep the current explicit live-clock, persisted amendment and cancellation product path. |
| `converge-rust-product-20260923` | `528e0fe0f341947d7fe379b717776f4ffba61198` | Supersede under the seven-path #140 decision above; keep the identical scientific verifier and stronger current CLI. |
| `dispatch-admission-transfer-20260923` | `cd827b2f1bac7b3d9be69ccc770131af3d232655` | Retain reference. Branch-only changes are scientific source-transfer parts and a transport workflow; do not install transport as product or qualification. |
| `dispatch-admission-upload-1f208a1c` | `d4997b8af4747ee0b98007d46567e4ab579082bd` | Retain reference. Only the development-input export workflow is branch-only; no native product implementation needs merging. |
| `full-rust-closure-20260923` | `f7678044d7e56725f74de13edad11116cad553d8` | Supersede. Actual scientific runtime, scientific test and gap-generator files already match the selected source. Preserve current narrowed verifier claims and advanced status implementation instead of replacing the whole tree. |
| `renewal-candidate-35741395233` | `5bebb5fde1a44a6a664b9f9955876b88959f9e00` | Supersede. Current amendment retains exact replay plus persisted-root/current-definition continuation and signal cancellation. The older local adapter removes these and resurrects a separate campaign-mode map; do not import it. |
| `rust-convergence-20260923` | `ae0f263d82028f88811ee0812252e8ba0e6ca746` | Supersede. Product control-plane manifest and public exports already match its prototype removal. Retain current autonomous owner, owned scientific outputs, installed-tool evidence and exact current source bindings rather than older replacements. |
| `scientific-tools-upload-45065ffb` | `3793c382c17a1ab4a5ab01a8f27af062f4bd99fd` | Supersede active source; retain transport reference. Current scientific tests include the real-tool cases plus private input ownership. Do not restore ambient-permission dependence, prototype re-export or volatile human-report hashes from its older tree. |

These records describe their original comparison subjects; current ancestry and
changed paths must be rechecked against the current PR head. No whole-tree merge,
force push, branch deletion or administrative review bypass is needed to preserve
these decisions. Any future code recovered from a transport archive still requires
ordinary source review and new exact-head tests; an archive's name or predecessor
validation does not authorize it.
