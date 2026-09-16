//! Incumbent-compatible v4/v5/v6 immutable owner records and canonical lock.
//! Unknown/still-live owners fail closed; only bound temporary inodes are removed.
use super::*;
use files::{Directory, FileEntry};
use std::{fs, os::unix::fs::MetadataExt};
const LOCK: &str = ".current.json.hepta-materialization.lock";
fn random() -> Result<String> {
    let mut b = [0_u8; 16];
    getrandom::fill(&mut b).map_err(|_| failure("randomness_unavailable"))?;
    Ok(hex::encode(b))
}
fn process_start(pid: u32) -> std::io::Result<String> {
    let raw = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let start = raw
        .rsplit_once(')')
        .and_then(|(_, r)| r.split_whitespace().nth(19))
        .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
        .ok_or_else(|| std::io::Error::other("process identity unavailable"))?;
    Ok(start.to_owned())
}
fn stale(owner: &Value) -> bool {
    let Some(pid) = owner["pid"]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n > 0)
    else {
        return false;
    };
    match process_start(pid) {
        Ok(current) => owner["pidStartTime"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s != current),
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    }
}
fn safe_owner_name(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| {
        s.starts_with(".current.json.hepta-lock-owner-")
            && s.ends_with(".json")
            && !s.contains(['/', '\\', '\0'])
    })
}
fn reclaim(dir: &Directory) -> Result<bool> {
    let Some(first) = dir.read(LOCK, 4096, 0o600, 2)? else {
        return Ok(false);
    };
    let record = first.json()?;
    if !stale(&record["owner"]) {
        return Ok(false);
    }
    let owner =
        safe_owner_name(&record["ownerEntryName"]).ok_or_else(|| failure("destination_locked"))?;
    let Some(owned) = dir.read(owner, 4096, 0o600, 2)? else {
        return Ok(false);
    };
    if !first.same(&owned) {
        return Ok(false);
    }
    let Some(confirmed) = dir.read(LOCK, 4096, 0o600, 2)? else {
        return Ok(false);
    };
    if !first.same(&confirmed) || !stale(&record["owner"]) {
        return Ok(false);
    }
    cleanup_bound_stage(dir, &record);
    dir.remove_owned(LOCK, &confirmed);
    dir.sync()?;
    dir.remove_owned(owner, &owned);
    dir.sync()?;
    Ok(true)
}
fn cleanup_bound_stage(dir: &Directory, record: &Value) {
    // Like the incumbent, cleanup binds the exact one-link inode, including a
    // v5 empty 0600 stage or one whose write was interrupted after binding.
    if let (Some(stage), Some(identity)) = (
        record["stageEntryName"].as_str().filter(|s| {
            s.starts_with(".current.json.hepta-")
                && s.ends_with(".tmp")
                && !s.contains(['/', '\\', '\0'])
        }),
        record["temporaryEntryIdentity"].as_object(),
    ) {
        let expected = Value::Object(identity.clone());
        if let Ok(Some(candidate)) = dir.read_stage_for_cleanup(stage) {
            let m = &candidate.metadata;
            let dev = m.dev().to_string();
            let ino = m.ino().to_string();
            let matches = expected["device"].as_str() == Some(dev.as_str())
                && expected["inode"].as_str() == Some(ino.as_str());
            if matches {
                dir.remove_owned(stage, &candidate);
            }
        }
    }
}
fn cleanup_orphans(dir: &Directory) -> Result<()> {
    let names = dir.entries(4096)?;
    for prefix in [
        ".current.json.hepta-lock-owner-",
        ".current.json.hepta-lock-publish-",
    ] {
        for name in names.iter().filter(|n| n.starts_with(prefix)) {
            let loaded = dir
                .read(name, 4096, 0o600, 1)
                .or_else(|_| dir.read(name, 4096, 0o600, 2));
            let Ok(Some(owner)) = loaded else { continue };
            let Ok(record) = owner.json() else { continue };
            if !stale(&record["owner"]) {
                continue;
            }
            let canonical = dir.stat(LOCK)?;
            if canonical
                .is_some_and(|m| m.dev() == owner.metadata.dev() && m.ino() == owner.metadata.ino())
            {
                continue;
            }
            owner.assert_current(dir, name)?;
            if prefix.contains("lock-owner") {
                cleanup_bound_stage(dir, &record);
            }
            dir.remove_owned(name, &owner);
        }
    }
    dir.sync()
}
pub(super) struct TargetLock<'a> {
    directory: &'a Directory,
    record: FileEntry,
    owner_name: String,
    pub stage_name: String,
    released: bool,
}
impl<'a> TargetLock<'a> {
    pub fn bind_temporary(&mut self, stage: &FileEntry, complete: bool) -> Result<()> {
        let dir = self.directory;
        self.assert_current(dir)?;
        stage.assert_current(dir, &self.stage_name)?;
        let mut payload = self.record.json()?;
        let m = &stage.metadata;
        let identity = json!({"device":m.dev().to_string(),"inode":m.ino().to_string(),"mode":m.mode().to_string(),"size":m.len(),"mtimeNs":(i128::from(m.mtime())*1_000_000_000+i128::from(m.mtime_nsec())).to_string(),"linkCount":m.nlink()});
        if complete
            && (payload["temporaryEntryIdentity"]["device"] != identity["device"]
                || payload["temporaryEntryIdentity"]["inode"] != identity["inode"])
        {
            return Err(failure("target_changed"));
        }
        let token = text(&payload, "token")?.to_owned();
        let pid = std::process::id();
        let start = process_start(pid).map_err(|_| failure("process_identity_unavailable"))?;
        let owner_name = format!(
            ".current.json.hepta-lock-owner-{pid}-{start}-{token}-{}.json",
            random()?
        );
        let pending = format!(".current.json.hepta-lock-publish-{token}-{}", random()?);
        payload["version"] = json!(if complete { 6 } else { 5 });
        payload["ownerEntryName"] = owner_name.clone().into();
        if !complete {
            payload["temporaryEntryIdentity"] = identity.clone();
        }
        payload["temporaryIdentity"] = if complete { identity } else { Value::Null };
        let mut bytes = serde_json::to_vec(&payload).map_err(|_| failure("json_invalid"))?;
        bytes.push(b'\n');
        let candidate = dir.create(&owner_name, &bytes, 0o600)?;
        let publish = (|| {
            dir.link(&owner_name, &pending)?;
            self.assert_current(dir)?;
            dir.replace(&pending, LOCK)
        })();
        // A directory-sync error after rename does not imply the old canonical
        // entry survived. Keep the newly published owner recoverable.
        let canonical = match dir.stat(LOCK) {
            Ok(value) => value,
            Err(e) => {
                dir.remove_owned(LOCK, &candidate);
                dir.remove_owned(&pending, &candidate);
                dir.remove_owned(&owner_name, &candidate);
                return Err(e);
            }
        };
        let published = canonical.is_some_and(|m| {
            m.dev() == candidate.metadata.dev() && m.ino() == candidate.metadata.ino()
        });
        if published {
            // Adopt the new inode before any fallible re-read or sync. Drop can
            // then release this process's canonical owner even on that error.
            let old = std::mem::replace(&mut self.record, candidate);
            let old_name = std::mem::replace(&mut self.owner_name, owner_name);
            dir.remove_owned(&old_name, &old);
            dir.sync()?;
            self.record = dir
                .read(&self.owner_name, 4096, 0o600, 2)?
                .ok_or_else(|| failure("lock_changed"))?;
        } else {
            dir.remove_owned(&pending, &candidate);
            dir.remove_owned(&owner_name, &candidate);
        }
        publish?;
        self.assert_current(dir)
    }
    pub fn acquire(directory: &'a Directory, document: &Value) -> Result<Self> {
        cleanup_orphans(directory)?;
        for _ in 0..2 {
            let pid = std::process::id();
            let start = process_start(pid).map_err(|_| failure("process_identity_unavailable"))?;
            let operation = format!(
                "online-authority-evidence-cache:{}:{}",
                text(document, "cacheHash")?,
                random()?
            );
            let token = crate::sqlite_mutation_coordinator::hash_bytes(operation.as_bytes())
                .trim_start_matches("sha256:")
                .to_owned();
            let owner_name = format!(
                ".current.json.hepta-lock-owner-{pid}-{start}-{token}-{}.json",
                random()?
            );
            let stage_name = format!(".current.json.hepta-{token}.tmp");
            let payload = json!({"version":4,"token":token,"operationId":operation,"owner":{"pid":pid,"pidStartTime":start},"ownerEntryName":owner_name,"stageEntryName":stage_name,"temporaryEntryIdentity":null,"temporaryIdentity":null});
            let mut bytes = serde_json::to_vec(&payload).map_err(|_| failure("json_invalid"))?;
            bytes.push(b'\n');
            let candidate = directory.create(&owner_name, &bytes, 0o600)?;
            if directory.link(&owner_name, LOCK).is_err() {
                directory.remove_owned(LOCK, &candidate);
                directory.remove_owned(&owner_name, &candidate);
                if reclaim(directory)? {
                    continue;
                }
                return Err(failure("destination_locked"));
            }
            let observed = directory.read(&owner_name, 4096, 0o600, 2);
            let record = match observed {
                Ok(Some(v)) => v,
                _ => {
                    directory.remove_owned(LOCK, &candidate);
                    directory.remove_owned(&owner_name, &candidate);
                    return Err(failure("lock_changed"));
                }
            };
            let acquired = Self {
                directory,
                record,
                owner_name,
                stage_name,
                released: false,
            };
            acquired.assert_current(directory)?;
            return Ok(acquired);
        }
        Err(failure("destination_locked"))
    }
    pub fn assert_current(&self, dir: &Directory) -> Result<()> {
        dir.assert_current()?;
        self.record
            .assert_current(dir, LOCK)
            .map_err(|_| failure("lock_changed"))?;
        self.record
            .assert_current(dir, &self.owner_name)
            .map_err(|_| failure("lock_changed"))
    }
    pub fn release(mut self, dir: &Directory) -> Result<()> {
        self.assert_current(dir)?;
        dir.remove_owned(LOCK, &self.record);
        dir.remove_owned(&self.owner_name, &self.record);
        dir.sync()?;
        self.released = true;
        Ok(())
    }
}
impl Drop for TargetLock<'_> {
    fn drop(&mut self) {
        if !self.released {
            self.directory.remove_owned(LOCK, &self.record);
            self.directory.remove_owned(&self.owner_name, &self.record);
            let _ = self.directory.sync();
        }
    }
}

#[cfg(test)]
mod tests;
