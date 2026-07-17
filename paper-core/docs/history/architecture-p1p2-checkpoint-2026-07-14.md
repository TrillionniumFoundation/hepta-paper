# Architecture P1/P2 checkpoint — 2026-07-14

This is a review checkpoint, not a release or a claim that the working tree is
clean. It records the stable boundary before the second campaign-store split.

- Base commit: `4712472a9a6569fa476f1830fd76b110a435cf35`
- Working-tree entries: 381
- Tracked diff summary: 219 files, +11,222 / -12,348
- Production SQLite SHA-256:
  `e43668b36839fd59a3f97e83b63a71f408a5fea72df079b62c73b132597b4983`
- Production logical hash:
  `sha256:f2439a2cf4393461e9fb850a846967a8b529a3adf932424567c1c516e64a8d75`
- Full isolated verification: passed
- Static syntax check: 836 modules
- Safety suites: P0 130/130, P1 27/27, P2 46/46
- Retirement matrix: 263/263 dispositions verified
- Capability verification: 14/14; implementation verified 40/40

The checkpoint deliberately does not contain a raw patch or runtime data. The
pre-existing dirty working tree remains preserved and uncommitted.
