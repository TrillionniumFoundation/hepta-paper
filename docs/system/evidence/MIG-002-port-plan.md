# MIG-002 content reconciliation

This record binds the content-level replay of the useful `hepta-paper#117` Node Module Protocol adapter onto the true descendant chain rooted at approved public PR #116 and stacked PR #119.

## Source objects retained

```text
rust/crates/hepta-module-platform/src/legacy_adapter.rs
  e560460538440cf429e208d15d26bedfef1fba35
rust/crates/hepta-module-platform/src/legacy_adapter/model.rs
  7e8b3c121d67de74fe0a9effa7100ca81d651e7f
rust/crates/hepta-module-platform/src/legacy_adapter/engine.rs
  e4809b4587186a38658066c63f3455897e8d342f
rust/crates/hepta-module-platform/src/legacy_adapter/support.rs
  cb8023c3808e0539b73a82ad5370759e442bf224
rust/crates/hepta-module-platform/src/legacy_adapter/tests.rs
  3a54d2234222596beae9f6b1eefc5dd717657453
rust/crates/hepta-module-platform/src/lib.rs
  787641e8adf4999e279c6f0202ae5aa5c39fbf64
```

At the original #116/#119 content-replay decision, source tip
`85a7b3364f3bcfbe452c10bac836654189202599` was not history-merged and its global
truth/document files were not copied: the recorded GitHub comparison was
`ahead_by=9`, `behind_by=4`, merge base `3ad568f...` relative to approved #116.

That replay retained only the reviewed Rust content objects above on the #119
descendant, with the then-current #116 documentation, issue bindings, private
replay subject, R-source route and technical-companion closure unchanged. The
later [branch consolidation record](../../migration/BRANCH_CONSOLIDATION.md)
separately records source-history and branch-name disposition. It does not
rewrite this original replay subject or transfer its qualification evidence.

## Authority ceiling

The adapter plans candidates, reserves and begins bounded invocations, translates terminal observations, fences idempotent replay and handles cancellation conservatively. It never launches Node, owns no durable production journal, receives no central writer, grants no irreversible effect, proves no production shadow/canary, transfers no writer authority and retires no Node path.
