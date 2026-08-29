# Qualification CLI exact-head trigger

This human-authored commit follows the verified reconciliation that keeps the
journal preflight CLI on the public fail-closed `open` contract and makes the
corruption-on-copy drill deterministically invalidate the SQLite header.

Protected source and qualification workflows must run on this exact head before
any issue state is changed.
