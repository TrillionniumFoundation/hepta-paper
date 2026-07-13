# Command surface

`npm run scripts:surface` groups all package commands into four explicit
surfaces:

- `operator`: active status, campaign, store, workspace and provider commands;
- `verification`: tests, coverage, CI and release gates;
- `retirement`: read-only legacy/migration verification and historical
  differential checks;
- `internal`: implementation details invoked by wrapper commands.

Historical retirement commands are not production paper modes. In particular,
there is no `paper:legacy-cleanup`, `store:migrate-legacy`, or
`store:snapshot-legacy-history` command. The only supported legacy surface is
immutable-reference verification and migration-matrix audit.
