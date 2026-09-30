# Native development verification

`hepta-paper-rust verify-full` executes strict Rust formatting, Clippy for all
workspace targets and production libraries/binaries, the workspace tests, and
Rust documentation with all features and warnings denied. Production Clippy also
rejects unwrap, expect, panic, todo and unimplemented calls. It uses the existing bounded process
group owner; it does not create another supervisor or obtain product authority.
The command stops after the first failed stage and reports actual exit/signal,
cleanup, byte counts, output hashes and bounded tails. SIGINT/SIGTERM cancellation
and the whole command deadline use that same process owner. Failed, cancelled and timed-out
stages retain their real command receipts even when a deadline prevents the
final source observation; that report stays unsuccessful.

The development profile requires qualified Cargo/Rust 1.98 and a clean source
commit. An explicit `--cargo ABSOLUTE_PATH` selects the actual tool, not a caller
success claim. The adjacent actual rustc version and tool hashes are checked.
The owner binds Git head/tree and all bounded tracked source bytes before and
after execution. Hidden index flags are refused, the actual index must match the
selected tree entry for entry, and a bounded no-filter Git batch verifies every
regular file's actual blob and executable mode. Git replacement objects are
disabled. Gitlinks and tracked symlinks are outside this source profile and
refuse execution. `--expected-head SHA --expected-tree SHA` optionally pins the
independently selected subject. These are cooperative before/after consistency
observations; no immutable filesystem snapshot or hostile same-UID containment
is claimed.

`--preflight` retains separate read-only source/tooling diagnostics and executes
no verification commands. The default whole-process timeout is 1200000 ms;
`--timeout-ms` accepts a positive integer up to 21600000. The strict argument
parser validates duplicate/unknown options before source access. JSON usage is
available through `--help`; current syntax comes from the compiled usage owner.

An explicitly requested Node development differential uses
`--require-parity --node ABSOLUTE_PATH --npm-cli ABSOLUTE_PATH`. The actual Node
22.23.1 and npm 10.9.8 versions and pinned tool bytes are checked, then the
existing npm test command executes after the native stages. This optional
comparison is development evidence. Suite success does not accept all registered
routes, qualify an installed host, transfer a writer, or authorize release,
submission or Node retirement. The separate current-subject route consumer owns
command behavior acceptance.

The child environment uses a closed development allowlist and fixed compiler
warning flags. Provider credentials, publication tokens and product permissions
are not inherited. Source changes during execution, changed tools, a wrong
subject, missing optional tool selection, command failure or failed process-group
cleanup fail closed.

Implementation is `full_suite_verification` and its `execution` owner in
`hepta-paper-service`. Actual ordinary-CLI tests live in
`tests/full_suite_verification_route.rs`: they create a real committed Rust
workspace, run all five development commands, check stripped credential
inheritance, retry the same subject, refuse dirty/wrong source subjects, and
interrupt a real sleeping Rust test with both SIGTERM and a deadline. The
same tests refuse hidden index flags, ignored executable-mode changes and actual
changed bytes that a deliberately weakened Git stat cache reports as clean. The
process group must be reaped and the actual failure receipt retained.
Results belong to exact-head/prospective-merge receipts for the current bytes.
