# v0.6 recoverability and external-governance checkpoint

This checkpoint closes the internally actionable P0/P1/P2 items from the v0.5
audit without fabricating owner, academic, referee, operator or executor
authority.

## Completed engineering controls

- The 15 unavailable NDU cold-data links are bound to a versioned mount
  contract. The exact logical path and target of every link is checked. A
  mounted volume must additionally provide a hash-bound content manifest and
  every declared target before operational replay can become ready.
- The 249 legacy dispositions are grouped into 13 exact capability-owner
  families. A version-2 acceptance document must bind the current family
  manifest and carry an externally trusted `capability_owner` signature.
- Operational receipts are accepted per each of the 14 capabilities only when
  they bind production subjects and inputs, execution/result/replay hashes,
  replay equality, the current release commit, current target hashes and an
  external owner signature.
- The last production legacy merge command string is removed. The replacement
  is a plan-only `hepta-paper://repair.safe-apply/v1` contract with no execute
  authority.
- Every production module participates in the repository-wide coverage gate.
  The separate architecture coverage gate remains stricter for critical ports,
  stores, CAS, claims and submission contracts.
- Differential replay uses a three-file, hash-bound compressed legacy fixture.
  The complete legacy tree is no longer needed by the two Python-to-JavaScript
  differential tests.
- The full cold reference archive is protected with an ext4 immutable inode
  flag, and immutable state is required by deletion/restore and release
  evidence. This is an immutable content object, not a claim that the entire
  filesystem is WORM.

## External and operational state

- Owner acceptance: 0/249.
- Operational proof: 0/161.
- Required real trust roles: 0/4.
- Cold volume operational replay: blocked while the declared volume is absent.
- Production provider executor: absent.
- Live external actions: 0.

The old active control plane remains retired. The full old source/database
archive remains a cold reference because deletion still requires external owner
acceptance, production-bound operational proof and a later destructive-action
approval. Functional parity is not claimed.
