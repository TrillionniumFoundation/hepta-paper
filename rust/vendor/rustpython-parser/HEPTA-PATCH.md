This directory preserves the MIT rustpython-parser 0.4.0 registry source and
its generated grammar, from upstream commit
8dd2aea26778d8d6917770f8e32bea1b9cdc0ae8. The original registry archive SHA-256
is recorded in Cargo's original lockfile and the dependency review receipt.
The original parser and grammar files are unchanged except src/lexer.rs.

The local patch replaces unmaintained unic identifier and emoji classifiers
with exactly pinned unicode-ident 1.0.24 XID classifications and regex-syntax
0.8.11 Emoji_Presentation ranges. The latter parses one fixed property string
once and searches the resulting ranges; it never executes a source or accepts
caller regex patterns. If that fixed property cannot be decoded, emoji input
is rejected. Unicode table versions have changed, so general equivalence to
all historical Python or UNIC inputs is not claimed. The actual 75-case,
245-source and five-profile differential tests are required after this patch.

Both direct RustPython dependencies select location and num-bigint explicitly
with default features disabled. This removes the default Malachite dependency
chain. This is a local maintenance patch, not an upstream RustPython fix. The
full original source, test snapshots, grammar and upstream MIT license remain
available for review; no advisory or license-policy exception is added.

The original eat_single_char unreachable_unchecked branch is replaced with a
safe invariant assertion. No generated grammar or other parser source changes.
Registry archive SHA-256:
868f724daac0caf9bd36d38caf45819905193a901e8f1c983345a68e18fb2abb.
