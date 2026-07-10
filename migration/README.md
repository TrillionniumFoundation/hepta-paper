# Legacy semantic migration matrix

`legacy-semantic-migration-matrix.json` is the only source of verified legacy
semantic migration claims. An adapter directory, similarly named file, worker
receipt, or runtime backlog row is not migration evidence.

Every verified entry must bind the current legacy source file hash and symbols,
the current hepta target file hash and symbols, and a local behavior test whose
own hash is recorded in the matrix. The legacy-cleanup audit executes each
listed behavior test and blocks retirement when any P0/P1 source lacks a valid
entry.

The matrix intentionally starts empty. This retracts the previous automatic
`263 claims complete` result; entries are added only as equivalence work is
implemented and reviewed.
