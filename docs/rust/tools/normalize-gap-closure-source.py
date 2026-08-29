#!/usr/bin/env python3
"""Apply deterministic, idempotent source normalizations before Rust qualification.

This script is intentionally narrow. Every edit is bound to an exact old/new form;
an unexpected source shape fails rather than guessing.
"""

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
        "rust/crates/hepta-workspace/src/lib.rs",
        """    path::{Component, Path, PathBuf},
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
""",
        """    path::{Component, Path, PathBuf},
    str::FromStr,
};

#[cfg(test)]
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
""",
    )
    replace_once(
        "rust/crates/hepta-workspace/src/lib.rs",
        """const MAXIMUM_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const MAXIMUM_TREE_ENTRIES: usize = 1_000_000;
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
""",
        """const MAXIMUM_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const MAXIMUM_TREE_ENTRIES: usize = 1_000_000;
#[cfg(test)]
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
""",
    )

    replace_once(
        "rust/crates/hepta-readonly-store/src/lib.rs",
        """        let mut names = self
            .connection
            .prepare(
                \"SELECT name FROM sqlite_schema
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                 ORDER BY name COLLATE BINARY\",
            )?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
""",
        """        let mut table_statement = self.connection.prepare(
            \"SELECT name FROM sqlite_schema
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name COLLATE BINARY\",
        )?;
        let mut names = table_statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(table_statement);
""",
    )

    replace_once(
        "rust/crates/hepta-control-plane/src/lib.rs",
        """use std::{fs, path::{Path, PathBuf}};
""",
        """use std::path::Path;

#[cfg(test)]
use std::{fs, path::PathBuf};
""",
    )
    replace_once(
        "rust/crates/hepta-control-plane/src/lib.rs",
        """        let value = json!({
            \"attemptId\": attempt_id,
            \"campaignId\": campaign_id,
            \"claimOwner\": claim_owner,
            \"nodeId\": node_id,
            \"version\": 1,
        });
""",
        """        let value = json!({
            \"attemptId\": &attempt_id,
            \"campaignId\": &campaign_id,
            \"claimOwner\": &claim_owner,
            \"nodeId\": &node_id,
            \"version\": 1,
        });
""",
    )

    insert_before(
        "rust/crates/hepta-broker-service-v2/src/lib.rs",
        "pub use listener::{\n",
        "pub(crate) use listener::ListenerEventV2;\n",
    )
    replace_once(
        "rust/crates/hepta-broker-service-v2/src/listener.rs",
        """    path::{Path, PathBuf},
    str::FromStr,
    sync::{Arc, Mutex},
""",
        """    path::{Path, PathBuf},
    sync::{Arc, Mutex},
""",
    )
    replace_once(
        "rust/crates/hepta-broker-service-v2/src/listener.rs",
        """    let marker = load_marker(marker_path)?;
""",
        """    let marker = load_marker(marker_path, policy)?;
""",
    )
    replace_once(
        "rust/crates/hepta-broker-service-v2/src/listener.rs",
        """fn load_marker(path: &Path) -> Result<Option<ListenerMarkerV2>, BrokerServiceErrorV2> {
""",
        """fn load_marker(
    path: &Path,
    policy: &ListenerPolicyV2,
) -> Result<Option<ListenerMarkerV2>, BrokerServiceErrorV2> {
""",
    )
    replace_once(
        "rust/crates/hepta-broker-service-v2/src/listener.rs",
        """    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.mode() & 0o7777 != 0o600
""",
        """    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != policy.service_uid
        || metadata.gid() != policy.service_gid
        || metadata.mode() & 0o7777 != 0o600
""",
    )
    replace_once(
        "rust/crates/hepta-broker-service-v2/src/listener.rs",
        """fn hash_policy(policy: &ListenerPolicyV2) -> Result<String, BrokerServiceErrorV2> {
    let mode = match policy.access_mode {
        ListenerAccessModeV2::ServiceOnly => \"service_only\",
        ListenerAccessModeV2::SharedRoleGroup => \"shared_role_group\",
    };
    let peers = policy
        .allowed_peers
        .iter()
        .map(|peer| format!(\"{}:{}\", peer.uid, peer.gid))
        .collect::<Vec<_>>();
    hash_fields(&[
        b\"HeptaListenerPolicyV2\",
        policy.socket_path.as_os_str().as_bytes(),
        &policy.service_uid.to_be_bytes(),
        &policy.service_gid.to_be_bytes(),
        &policy.parent_mode.to_be_bytes(),
        &policy.socket_mode.to_be_bytes(),
        mode.as_bytes(),
        peers.join(\",\").as_bytes(),
    ])
}
""",
        """fn hash_policy(policy: &ListenerPolicyV2) -> Result<String, BrokerServiceErrorV2> {
    let mode = match policy.access_mode {
        ListenerAccessModeV2::ServiceOnly => \"service_only\",
        ListenerAccessModeV2::SharedRoleGroup => \"shared_role_group\",
    };
    let peers = policy
        .allowed_peers
        .iter()
        .map(|peer| format!(\"{}:{}\", peer.uid, peer.gid))
        .collect::<Vec<_>>()
        .join(\",\");
    let service_uid = policy.service_uid.to_be_bytes();
    let service_gid = policy.service_gid.to_be_bytes();
    let parent_mode = policy.parent_mode.to_be_bytes();
    let socket_mode = policy.socket_mode.to_be_bytes();
    hash_fields(&[
        b\"HeptaListenerPolicyV2\",
        policy.socket_path.as_os_str().as_bytes(),
        &service_uid,
        &service_gid,
        &parent_mode,
        &socket_mode,
        mode.as_bytes(),
        peers.as_bytes(),
    ])
}
""",
    )

    replace_once(
        "rust/crates/hepta-broker-service-v2/src/cgroup.rs",
        """    fs::{self, File, OpenOptions},
    io::{Read, Write},
""",
        """    fs::{self, File, OpenOptions},
    io::Write,
""",
    )

    replace_once(
        "rust/crates/hepta-campaign-writer/src/store.rs",
        """        let path = prepare_path(path.as_ref(), owner_uid)?;
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let connection = Connection::open_with_flags(&path, flags)?;
        connection.busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MS))?;
        connection.execute_batch(
            \"PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA trusted_schema = OFF;
             PRAGMA temp_store = MEMORY;\",
        )?;
        let application_id: i64 =
            connection.query_row(\"PRAGMA application_id\", [], |row| row.get(0))?;
        let user_version: i64 =
            connection.query_row(\"PRAGMA user_version\", [], |row| row.get(0))?;
        if application_id == 0 && user_version == 0 {
            let object_count: i64 = connection.query_row(
                \"SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'\",
                [],
                |row| row.get(0),
            )?;
            if object_count != 0 {
                return Err(CampaignWriterError::DatabaseIdentityMismatch {
                    application_id,
                    user_version,
                });
            }
            connection.execute_batch(SCHEMA_SQL)?;
        } else if application_id != APPLICATION_ID || user_version != USER_VERSION {
            return Err(CampaignWriterError::DatabaseIdentityMismatch {
                application_id,
                user_version,
            });
        }
""",
        """        let path = prepare_path(path.as_ref(), owner_uid)?;
        let disposition = preflight_database(&path, owner_uid)?;
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let connection = Connection::open_with_flags(&path, flags)?;
        connection.busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MS))?;
        connection.execute_batch(
            \"PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA trusted_schema = OFF;
             PRAGMA temp_store = MEMORY;\",
        )?;
        match disposition {
            DatabaseOpenDispositionV1::Initialize => connection.execute_batch(SCHEMA_SQL)?,
            DatabaseOpenDispositionV1::Existing => verify_database_identity(&connection)?,
        }
""",
    )
    insert_before(
        "rust/crates/hepta-campaign-writer/src/store.rs",
        "fn prepare_path(path: &Path, owner_uid: u32) -> Result<PathBuf, CampaignWriterError> {\n",
        """#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DatabaseOpenDispositionV1 {
    Initialize,
    Existing,
}

fn preflight_database(
    path: &Path,
    owner_uid: u32,
) -> Result<DatabaseOpenDispositionV1, CampaignWriterError> {
    inspect_database(path, owner_uid)?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| CampaignWriterError::Filesystem(\"database_preflight\", error.kind()))?;
    if metadata.size() == 0 {
        return Ok(DatabaseOpenDispositionV1::Initialize);
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    let connection = Connection::open_with_flags(path, flags)?;
    connection.busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MS))?;
    connection.execute_batch(
        \"PRAGMA query_only = ON;
         PRAGMA trusted_schema = OFF;
         PRAGMA temp_store = MEMORY;\",
    )?;
    verify_database_identity(&connection)?;
    let integrity: String = connection.query_row(\"PRAGMA integrity_check\", [], |row| row.get(0))?;
    if integrity != \"ok\" {
        return Err(CampaignWriterError::IntegrityFailure(integrity));
    }
    inspect_database(path, owner_uid)?;
    Ok(DatabaseOpenDispositionV1::Existing)
}

fn verify_database_identity(connection: &Connection) -> Result<(), CampaignWriterError> {
    let application_id: i64 =
        connection.query_row(\"PRAGMA application_id\", [], |row| row.get(0))?;
    let user_version: i64 =
        connection.query_row(\"PRAGMA user_version\", [], |row| row.get(0))?;
    if application_id != APPLICATION_ID || user_version != USER_VERSION {
        return Err(CampaignWriterError::DatabaseIdentityMismatch {
            application_id,
            user_version,
        });
    }
    let required = [\"campaign_events\", \"campaigns\", \"nodes\", \"writer_authority\"];
    for name in required {
        let count: i64 = connection.query_row(
            \"SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = ?1\",
            [name],
            |row| row.get(0),
        )?;
        if count != 1 {
            return Err(CampaignWriterError::DatabaseIdentityMismatch {
                application_id,
                user_version,
            });
        }
    }
    Ok(())
}

""",
    )
    replace_once(
        "rust/crates/hepta-campaign-writer/src/store.rs",
        """                    sum(CASE WHEN n.state = 'completed' THEN 1 ELSE 0 END),
                    sum(CASE WHEN n.state = 'ambiguous' THEN 1 ELSE 0 END)
""",
        """                    coalesce(sum(CASE WHEN n.state = 'completed' THEN 1 ELSE 0 END), 0),
                    coalesce(sum(CASE WHEN n.state = 'ambiguous' THEN 1 ELSE 0 END), 0)
""",
    )
    replace_once(
        "rust/crates/hepta-campaign-writer/src/store.rs",
        """        self.connection.execute(\"VACUUM INTO ?1\", [destination])?;
""",
        """        let destination_text = destination
            .to_str()
            .ok_or(CampaignWriterError::DatabasePathInvalid)?;
        self.connection
            .execute(\"VACUUM INTO ?1\", [destination_text])?;
""",
    )

    print("normalized Plan v3 gap-closure source")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"source normalization failed: {error}", file=sys.stderr)
        raise SystemExit(1)
