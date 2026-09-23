# Legacy semantic migration matrix

`legacy-semantic-migration-matrix.json` is the only source of verified legacy
semantic migration claims. An adapter directory, similarly named file, worker
receipt, or runtime backlog row is not migration evidence.

Every verified entry must bind the current legacy source file hash and symbols,
the current hepta target file hash and symbols, and a local behavior test whose
own hash is recorded in the matrix. The read-only retirement audit executes
each listed behavior test and reports any P0/P1 source lacking a valid entry.

The matrix contains 263/263 verified dispositions: 14 behavioral replacements
and 249 explicit retirements. Explicit retirement is not semantic migration,
so functional parity remains false. Capability matrix v3 further classifies
the 249 retirements as 88 permanent retirements, 40 superseded coverage
obligations and 121 capability reimplementations. Technical state, local-admin
delegation and independent external-owner acceptance are separate axes; current
counts are reported only in `paper-core/docs/CURRENT_STATUS.md`.
