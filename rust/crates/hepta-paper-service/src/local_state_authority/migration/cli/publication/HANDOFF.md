# Offline journal artifact bundle publication

`publish_image(output, image, source_report, protected_paths)` and
`publish_legacy_archive(output, archive, source_report, protected_paths)` are
private to the journal CLI. Their only production caller first explicitly
rolls back and closes the source SQLite connection. The two wrappers dispatch
through a private, closed `ArtifactRef` enum containing only references to the
opaque `OfflineNativeAuthorityImageV1` or `OfflineLegacyAuthorityArchiveV1`
objects built by the independently pinned, signed-history owner. No caller can
supply a byte vector/report JSON as a substitute artifact. This operation exports an artifact;
it neither replaces the configured journal nor proves that Node stopped, that
an installation is native, or that a live migration is authorized.

The output must be a fresh directory beneath an existing canonical private
`0700` parent owned by the effective user or root. Complete ancestor identities
are retained; ancestors must be user/root owned and not group/other writable,
except sticky directories protecting a user/root-owned child. Every actual
protected input path supplied by the closed-source owner is checked in both
containment directions, including the source parent. An output inside a
protected namespace, or containing a protected input, is refused. Symlinks in
the output parent route and every existing final object are refused.

A random create-new `0700` sibling staging directory for the existing native
image command contains exactly:

- `authority.sqlite`, mode `0600`, with the opaque image's exact bytes.
- `report.json`, mode `0600`, with `version: 1`, kind
  `HeptaLocalStateAuthorityOfflineNativeImageBundleV1`, scope
  `offline_artifact_no_migration_or_publication_authority`, `image` equal to the
  image's full report, and `sourceNamespaceObservation` equal to the CLI's named
  namespace observation. That observation is explicitly not source provenance
  or a process-retirement certificate.

For the explicit legacy archive command the two fixed files are instead:

- `legacy-authority.sqlite`, mode `0600`, with the verified original-format
  archive's exact bytes, unchanged journal header and Node schema/version 0.
- `report.json`, mode `0600`, with version 1, kind
  `HeptaLocalStateAuthorityOfflineLegacyArchiveBundleV1`, scope
  `offline_original_format_archive_no_migration_or_restore_authority`, `archive`
  equal to the archive's full verified report and the same
  `sourceNamespaceObservation` field. The nested report binds actual
  source/archive logical hashes, schema/history, page size/count/header mode
  and archive byte hash/length.

Both variants validate the opaque report's byte hash and length against actual
bytes before staging. Filenames, report kind, report field and output shape are
chosen exhaustively by the enum. There is no generic file list, arbitrary byte
publisher, format conversion or automatic restore.

Held file descriptors, named identities, owner/mode, single link, complete
membership, byte length, and actual content hashes are checked before and after
publication. Directory membership inspection is bounded to three entries. File
contents and the staging directory are fsynced before a same-parent
`renameat2(RENAME_NOREPLACE)` publishes the entire bundle; the parent is fsynced
and all final identities/content rechecked afterward. No existing final object
is overwritten or removed.

Successful JSON uses kind
`HeptaLocalStateAuthorityOfflineNativeImagePublicationV1` and scope
`offline_artifact_no_live_migration_authority`, with `publicationCommitted: true`,
`outputPath`, `imagePath`, `reportPath`, `imageSha256`, `reportSha256`,
`imageByteLength`, and `reportByteLength`. The report hash covers the exact bytes
written to `report.json`. This existing native-image contract is unchanged.

Legacy archive success uses kind
`HeptaLocalStateAuthorityOfflineLegacyArchivePublicationV1` and scope
`offline_original_format_archive_no_live_migration_authority`, with
`publicationCommitted: true`, `outputPath`, `archivePath`, `reportPath`,
`archiveSha256`, `reportSha256`, `archiveByteLength`, and `reportByteLength`.
The source's SQLite connection is already closed for both variants. Publication
does not freeze another writer or authorize a later use of the archive as a
replacement journal. A WAL-header backup image reopens as a normal SQLite file
without the original WAL; it is not directly memory-deserializable unchanged.

Errors retain `details.publicationCommitted`, `outputPath`, and
`inspectionRequired`, and are never marked retryable. Failures before rename and
an explicit no-replace conflict report `false`. A successful rename followed by
fsync/identity/content failure reports `true`. Other rename errors report `null`
because a filesystem's outcome can be uncertain; they require inspection too.
Neither case deletes the final name or automatically retries. Cleanup removes
only an entirely unchanged owned staging namespace. Replaced ancestors, foreign
members, replaced files, and hardlinks cause staging to be retained. Same-user
filesystem lifecycle operations must be serialized externally: these identity
checks do not claim an atomic conditional-unlink or prevent later same-user
modifications. A crash can leave a staging directory for explicit inspection.

The dedicated tests use a real pinned Node signed multi-database history with an
aborted tail and the actual public native-image and original-format archive
builders for their respective publication paths. Archive tests verify the
distinct fixed names/reports, original schema/version, integrity, and the same
protected-path/output-collision refusals without changing an existing bundle.
Filesystem-only tests exercise no-replace races, retained ancestor drift,
hardlinks/replacement, unknown members, post-rename error reporting, and unsafe
ancestry; their arbitrary bytes test only the private filesystem primitive and
are never presented as qualified SQLite images or native deployment evidence.

Run the dedicated suite with the pinned Node profile using `cargo test -p
hepta-paper-service --lib local_state_authority::migration::cli::publication::tests
-- --nocapture`; the CLI integration target also retains the original
inspect/native-image regression coverage.
