# Scientific CI AppArmor policy

## Provenance and exact change

`bwrap-userns-restrict` remains the unmodified AppArmor v4.0.1
[upstream profile](https://gitlab.com/apparmor/apparmor/-/blob/v4.0.1/profiles/apparmor/profiles/extras/bwrap-userns-restrict).
Its SHA-256 is
`11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9`.
The upstream tree's [license](https://gitlab.com/apparmor/apparmor/-/blob/v4.0.1/LICENSE)
is GPL version 2; a copy is retained in `LICENSE.GPL-2`. Original profile
comments remain intact. The modified profile identifies its change date and
is distributed under those terms, without warranty.

`bwrap-userns-restrict-abi4-v1` is an explicitly versioned derivative. Apart
from its comment header, it removes exactly the two unrestricted
`allow io_uring,` grants. It changes no capability denial, profile name,
executable attachment, transition, stacking rule, or ABI declaration.
Preparation pins both source files and checks this exact transformation
before any policy write. Changes to provenance, occurrence count or other
policy bytes fail closed. The derivative digest and byte count are pinned
in the preparation script and its source tests.

## Why this is an ABI compatibility change

The upstream [ABI 4.0 declaration](https://gitlab.com/apparmor/apparmor/-/blob/v4.0.1/profiles/apparmor.d/abi/4.0)
does not advertise io_uring. The parser's
[feature selection](https://gitlab.com/apparmor/apparmor/-/blob/v4.0.1/parser/parser_main.c)
intersects the policy ABI and actual kernel features. Its
[io_uring rule implementation](https://gitlab.com/apparmor/apparmor/-/blob/v4.0.1/parser/io_uring.cc)
uses all io_uring permissions for a rule without a permission list, and
reports unsupported mediation before emitting that rule when the feature
intersection is absent.

These two rules grant unrestricted access; they do not provide a restriction
that would be lost by removing them. Their removal cannot add a grant, and
leaves the child capability denial and executable transitions intact. This
profile claims no io_uring confinement. If a future ABI/kernel combination
requires an additional grant for a real scientific workload, that is a new
reviewed version and validation task, never an automatic fallback.

The preparation log records policy-ABI bytes/digest and actual kernel feature
leaves separately. An unsupported-rule error alone does not establish which
side of the intersection is missing. The parser still uses the real kernel,
with `--warn=rule-not-enforced --Werror=rule-not-enforced`; there is no fabricated
feature set, ABI override, warning suppression or generic rule stripping.
Any other unsupported rule remains fatal before policy installation.

## Validation and remaining host obligations

Run the deterministic, unprivileged source contract tests with:

```sh
python3 -B .github/scripts/test_scientific_host_source.py
bash -n .github/scripts/prepare-scientific-test-host.sh
```

These tests inspect source and compile embedded Python without executing the
host setup. They do not demonstrate AppArmor enforcement or scientific behavior.
The Rust foundation workflow obtains formatting, Clippy and documentation
feedback before the host gate; its original complete workspace test command
remains after that gate. No behavior test is removed or counted as passing
when the gate fails.

On the exact candidate and applicable prospective-merge subjects, CI must
still compile the derivative against the actual kernel with fatal warnings,
load only the two expected enforced profiles without replacing other policy,
preserve the global user-namespace restriction, and establish the complete
live child label and real same-process sys_admin denial with matching kernel
audit. Original process-ownership cleanup and all nonroot scientific probes
must pass under their original deadlines. Then the original foundation,
functional-source and migration tests must actually run and pass. A source
test, mock, parser-only check or old-head result cannot replace those results.
