# PR 16 real-SIGKILL qualification trigger

This human-authored commit follows the source commit that adds an independent
writer-process crash probe for the broker SQLite journal.

The probe holds a real uncommitted page-one mutation under `BEGIN IMMEDIATE`, is
terminated with `SIGKILL`, and verifies that normal broker startup still accepts
and audits the journal. A separately committed header mutation followed by
`SIGKILL` must instead be rejected during startup preflight.

This is portable source evidence. Host reboot, disk-full, remount, filesystem
corruption and installed service-manager drills remain controlled-environment
qualification and are not inferred from this test.
