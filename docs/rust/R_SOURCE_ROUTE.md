# R source route and acceptance boundary

The repository records an inaccessible external gitlink at
`runtime-images/r-scientific/source-cas` with commit
`d13d857909525f4173063dbd6a7f1f48a089ae93`. Repository-local tooling has not
fetched and verified that commit, and no equivalence to another source is
claimed.

A separately identifiable public historical route exists in this repository:

```text
commit:       18b20af983e32575a2faab7dd8fa721a61d2e68c
path:         runtime-images/r-scientific/source-cas
subtree:      d6b31b7145b97ae01c71e76b34ef7c5cb1a3e082
manifest blob:0053ff8c14a375874bc5c0ea4f0f6071d648b1eb
files:        107
packages:     104
```

`docs/rust/qualification/r-source-route.v1.json` declares this route with a
closed schema. Its authority fields are all false. The static record cannot
assert that bytes have been verified, that the original gitlink is equivalent,
or that production use is authorized.

`docs/rust/tools/verify-r-source-route.py` performs a read-only verification:

1. validates the route record against the committed closed schema;
2. checks that the current tree still records the exact original gitlink;
3. resolves the exact historical commit/path to the declared subtree;
4. checks that the existing materializer binds the same subtree, manifest blob,
   and target path;
5. invokes the materializer's bounded read-only capture to verify every Git blob,
   package size and SHA-256 in the 107-file/104-package set;
6. confirms that verification did not mutate the worktree;
7. emits a nonactivating content-verification record.

The output continues to state:

```text
original gitlink commit object verified: false
equivalence claimed: false
current build closure verified: false
independent acceptance: false
target host qualified: false
production authorized: false
```

The current build-input closure must be checked separately against the exact
candidate source and runtime definition. Exact head/base/prospective-merge CI,
independent source-route review and target-host qualification are also required.
Content recovery and current-definition compatibility together still do not prove
that the unavailable external gitlink commit is the same source.

This route provides a reviewable alternative to silently repinning or inventing
package archives. Acceptance may select it only through an explicit independent
decision that names the exact route identity and invalidates on any route,
materializer, build-definition, candidate-source or qualification change.
