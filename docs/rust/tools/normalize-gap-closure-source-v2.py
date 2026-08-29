#!/usr/bin/env python3
"""Second deterministic normalization pass for settlement and recovery semantics."""

from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]


def replace_once(path: str, old: str, new: str) -> None:
    selected = ROOT / path
    text = selected.read_text(encoding="utf-8")
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise ValueError(f"{path}: expected one source form, found {count}")
    selected.write_text(text.replace(old, new), encoding="utf-8")


def insert_before(path: str, marker: str, addition: str) -> None:
    selected = ROOT / path
    text = selected.read_text(encoding="utf-8")
    if addition in text:
        return
    count = text.count(marker)
    if count != 1:
        raise ValueError(f"{path}: expected one insertion marker, found {count}")
    selected.write_text(text.replace(marker, addition + marker), encoding="utf-8")


def main() -> int:
    replace_once(
        "rust/crates/hepta-campaign-writer/src/store.rs",
        """    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
""",
        """    path::{Path, PathBuf},
    time::Duration,
""",
    )
    replace_once(
        "rust/crates/hepta-campaign-writer/src/store.rs",
        """                tx.execute(
                    \"UPDATE writer_authority
                     SET generation = ?1, token = ?2, acquired_at_unix_ms = ?3
                     WHERE singleton = 1 AND generation = ?4 AND token = ?5\",
                    params![
                        to_i64(authority.generation)?,
                        authority.token,
                        to_i64(now_unix_ms)?,
                        to_i64(generation)?,
                        token,
                    ],
                )?;
""",
        """                let updated = tx.execute(
                    \"UPDATE writer_authority
                     SET generation = ?1, token = ?2, acquired_at_unix_ms = ?3
                     WHERE singleton = 1 AND generation = ?4 AND token = ?5\",
                    params![
                        to_i64(authority.generation)?,
                        authority.token,
                        to_i64(now_unix_ms)?,
                        to_i64(generation)?,
                        token,
                    ],
                )?;
                if updated != 1 {
                    return Err(CampaignWriterError::StaleWriter);
                }
""",
    )

    insert_before(
        "rust/crates/hepta-campaign-writer/src/store.rs",
        """        let updated = tx.execute(
            \"UPDATE nodes
             SET state = 'completed', integrated_result_hash = ?1,
""",
        """        let resources_updated = tx.execute(
            \"UPDATE campaigns
             SET cpu_jobs_remaining = cpu_jobs_remaining + ?1,
                 updated_at_unix_ms = ?2
             WHERE campaign_id = ?3 AND revision = ?4\",
            params![
                i64::from(prepared.claim.reserved_cpu_jobs),
                to_i64(now_unix_ms)?,
                prepared.claim.campaign_id,
                to_i64(revision)?,
            ],
        )?;
        if resources_updated != 1 {
            return Err(CampaignWriterError::StaleRevision {
                expected: revision,
                observed: campaign_revision(&tx, &prepared.claim.campaign_id)?,
            });
        }
        inject(fault, FaultPointV1::AfterCampaignResourceUpdate)?;
""",
    )

    replace_once(
        "rust/crates/hepta-campaign-writer/src/store.rs",
        """        if !provider_action_may_have_started {
            tx.execute(
                \"UPDATE campaigns
                 SET budget_remaining_microusd = budget_remaining_microusd + ?1,
                     cpu_jobs_remaining = cpu_jobs_remaining + ?2,
                     updated_at_unix_ms = ?3
                 WHERE campaign_id = ?4 AND revision = ?5\",
                params![
                    to_i64(claim.reserved_microusd)?,
                    i64::from(claim.reserved_cpu_jobs),
                    to_i64(now_unix_ms)?,
                    claim.campaign_id,
                    to_i64(revision)?,
                ],
            )?;
            inject(fault, FaultPointV1::AfterCampaignResourceUpdate)?;
        }
""",
        """        let resources_updated = if provider_action_may_have_started {
            tx.execute(
                \"UPDATE campaigns
                 SET cpu_jobs_remaining = cpu_jobs_remaining + ?1,
                     updated_at_unix_ms = ?2
                 WHERE campaign_id = ?3 AND revision = ?4\",
                params![
                    i64::from(claim.reserved_cpu_jobs),
                    to_i64(now_unix_ms)?,
                    claim.campaign_id,
                    to_i64(revision)?,
                ],
            )?
        } else {
            tx.execute(
                \"UPDATE campaigns
                 SET budget_remaining_microusd = budget_remaining_microusd + ?1,
                     cpu_jobs_remaining = cpu_jobs_remaining + ?2,
                     updated_at_unix_ms = ?3
                 WHERE campaign_id = ?4 AND revision = ?5\",
                params![
                    to_i64(claim.reserved_microusd)?,
                    i64::from(claim.reserved_cpu_jobs),
                    to_i64(now_unix_ms)?,
                    claim.campaign_id,
                    to_i64(revision)?,
                ],
            )?
        };
        if resources_updated != 1 {
            return Err(CampaignWriterError::StaleRevision {
                expected: revision,
                observed: campaign_revision(&tx, &claim.campaign_id)?,
            });
        }
        inject(fault, FaultPointV1::AfterCampaignResourceUpdate)?;
""",
    )

    replace_once(
        "rust/crates/hepta-campaign-writer/src/store.rs",
        """        let hash = hash_file(destination)?;
        let backup = Self::open(destination, self.owner_uid)?;
        backup.validate_integrity()?;
        Ok(hash)
""",
        """        if preflight_database(destination, self.owner_uid)?
            != DatabaseOpenDispositionV1::Existing
        {
            return Err(CampaignWriterError::DatabaseAuthorityInvalid);
        }
        hash_file(destination)
""",
    )
    replace_once(
        "rust/crates/hepta-campaign-writer/src/store.rs",
        """        let source = Self::open(backup, owner_uid)?;
        source.validate_integrity()?;
""",
        """        if preflight_database(backup, owner_uid)?
            != DatabaseOpenDispositionV1::Existing
        {
            return Err(CampaignWriterError::DatabaseAuthorityInvalid);
        }
""",
    )
    replace_once(
        "rust/crates/hepta-campaign-writer/src/store.rs",
        """            && (sidecar_metadata.file_type().is_symlink()
                || !sidecar_metadata.is_file()
                || sidecar_metadata.uid() != owner_uid
                || sidecar_metadata.nlink() != 1)
""",
        """            && (sidecar_metadata.file_type().is_symlink()
                || !sidecar_metadata.is_file()
                || sidecar_metadata.uid() != owner_uid
                || sidecar_metadata.mode() & 0o7777 != 0o600
                || sidecar_metadata.nlink() != 1
                || sidecar_metadata.size() > MAXIMUM_DATABASE_BYTES)
""",
    )
    replace_once(
        "rust/crates/hepta-campaign-writer/src/store.rs",
        """        assert_eq!(settled.cpu_jobs_remaining, 5);
""",
        """        assert_eq!(settled.cpu_jobs_remaining, 8);
""",
    )
    insert_before(
        "rust/crates/hepta-campaign-writer/src/store.rs",
        """        let duplicate = reopened
            .integrate_prepared_result(
""",
        """        assert_eq!(
            reopened
                .campaign_status(\"campaign-1\")
                .expect(\"completed campaign\")
                .cpu_jobs_remaining,
            8
        );
""",
    )

    insert_before(
        "rust/crates/hepta-broker-service-v2/src/service.rs",
        """        self.listener.shutdown()?;
""",
        """        while let Ok(message) = error_receiver.try_recv() {
            if fatal_error.is_none() {
                fatal_error = Some(BrokerServiceErrorV2::WorkerFailed(message));
            }
        }
""",
    )

    print("normalized settlement, backup and worker-failure semantics")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"source normalization v2 failed: {error}", file=sys.stderr)
        raise SystemExit(1)
