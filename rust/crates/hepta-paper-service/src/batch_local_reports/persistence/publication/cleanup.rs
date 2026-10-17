use super::*;
use nix::unistd::{UnlinkatFlags, unlinkat};
use std::collections::BTreeSet;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    relative: String,
    witness: Witness,
    hash: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Compaction {
    version: u32,
    kind: String,
    operation: String,
    root_binding: String,
    files: Vec<Entry>,
    authority_granted: bool,
}
fn allowed_names(prepared: &Prepared) -> BTreeSet<String> {
    let mut names = BTreeSet::from([format!("objects/{}", &prepared.intent.hash[7..])]);
    if let Some(previous) = &prepared.intent.previous {
        names.insert(format!("objects/{}", &previous.hash[7..]));
        names.insert("replacement".into());
    }
    names
}
fn load(prepared: &Prepared) -> Result<Option<(Compaction, Vec<u8>)>, String> {
    let Some(wire) = prepared.read_record("compaction.json")? else {
        return Ok(None);
    };
    let value: Compaction = serde_json::from_slice(&wire).map_err(|_| error())?;
    let names = allowed_names(prepared);
    if value.version != 1
        || value.kind != "NativeLocalReportKnownCompaction"
        || value.operation != prepared.intent.operation
        || value.root_binding != prepared.intent.root_binding
        || value.authority_granted
        || value.files.len() > 3
        || value
            .files
            .iter()
            .map(|v| v.relative.clone())
            .collect::<BTreeSet<_>>()
            != names
        || value.files.iter().any(|v| !digest(&v.hash))
    {
        return Err(error());
    }
    Ok(Some((value, wire)))
}
pub(super) fn permits_public_content(prepared: &Prepared) -> Result<bool, String> {
    Ok(load(prepared)?.is_some())
}
fn inventory(prepared: &Prepared, planned: &BTreeSet<String>) -> Result<(), String> {
    prepared.directory.assert_current().map_err(|_| error())?;
    let expected_root = BTreeSet::from([
        "intent.json",
        "records.json",
        "done.json",
        "compaction.json",
        "compacted.json",
        "state-access-v1.lock",
        "objects",
        "attempts",
    ]);
    retained_unprepared(prepared)?;
    for entry in fs::read_dir(&prepared.directory.path).map_err(|_| error())? {
        let entry = entry.map_err(|_| error())?;
        let name = entry.file_name().into_string().map_err(|_| error())?;
        if !expected_root.contains(name.as_str())
            && !(name == "replacement" && planned.contains("replacement"))
            && !unprepared_copy_name(&name)
        {
            return Err(error());
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|_| error())?;
        if metadata.file_type().is_symlink()
            || metadata.uid() != nix::unistd::getuid().as_raw()
            || !metadata.is_file() && !metadata.is_dir()
        {
            return Err(error());
        }
    }
    let objects = Directory::open_or_create(&prepared.directory.path.join("objects"), false)
        .map_err(|_| error())?;
    for entry in fs::read_dir(&objects.path).map_err(|_| error())? {
        let entry = entry.map_err(|_| error())?;
        let name = entry.file_name().into_string().map_err(|_| error())?;
        if !planned.contains(&format!("objects/{name}")) {
            return Err(error());
        }
    }
    let attempts = Directory::open_or_create(&prepared.directory.path.join("attempts"), false)
        .map_err(|_| error())?;
    if fs::read_dir(&attempts.path)
        .map_err(|_| error())?
        .next()
        .is_some()
    {
        return Err(error());
    }
    prepared
        .directory
        .observe_empty_lock("state-access-v1.lock")
        .map_err(|_| error())?
        .assert_current()
        .map_err(|_| error())?;
    prepared.directory.assert_current().map_err(|_| error())?;
    objects.assert_current().map_err(|_| error())?;
    attempts.assert_current().map_err(|_| error())?;
    Ok(())
}
pub(super) fn compact(
    prepared: &Prepared,
    cancelled: &AtomicBool,
    deadline: Instant,
    hook: &dyn Fn(&str) -> Result<(), String>,
) -> Result<(), String> {
    active(cancelled, deadline)?;
    let names = allowed_names(prepared);
    inventory(prepared, &names)?;
    let (value, wire) = if let Some(value) = load(prepared)? {
        value
    } else {
        let mut files = vec![];
        for relative in &names {
            let file = observed(&prepared.directory.path.join(relative), 16 * 1024 * 1024)?;
            let content = bytes(&file, 16 * 1024 * 1024)?;
            let hash = hash_bytes(&content);
            let expected = if relative == "replacement" {
                prepared
                    .intent
                    .previous
                    .as_ref()
                    .ok_or_else(error)?
                    .hash
                    .clone()
            } else {
                format!(
                    "sha256:{}",
                    relative.strip_prefix("objects/").ok_or_else(error)?
                )
            };
            if hash != expected {
                return Err(error());
            }
            if relative == "replacement"
                && !prepared
                    .intent
                    .previous
                    .as_ref()
                    .ok_or_else(error)?
                    .witness
                    .exchanged(&file.file.metadata().map_err(|_| error())?)
            {
                return Err(error());
            }
            files.push(Entry {
                relative: relative.clone(),
                witness: Witness::of(&file.file.metadata().map_err(|_| error())?),
                hash,
            });
        }
        let value = Compaction {
            version: 1,
            kind: "NativeLocalReportKnownCompaction".into(),
            operation: prepared.intent.operation.clone(),
            root_binding: prepared.intent.root_binding.clone(),
            files,
            authority_granted: false,
        };
        let wire = serde_json::to_vec(&value).map_err(|_| error())?;
        prepared.record("compaction.json", &wire, hook)?;
        (value, wire)
    };
    hook("compaction_prepared")?;
    if let Some(done) = prepared.read_record("compacted.json")?
        && done != wire
    {
        return Err(error());
    }
    for entry in &value.files {
        active(cancelled, deadline)?;
        let path = prepared.directory.path.join(&entry.relative);
        let file = match observed(&path, 16 * 1024 * 1024) {
            Ok(file) => file,
            Err(_) if matches!(fs::symlink_metadata(&path),Err(e) if e.kind()==std::io::ErrorKind::NotFound) =>
            {
                continue;
            }
            Err(e) => return Err(e),
        };
        if Witness::of(&file.file.metadata().map_err(|_| error())?) != entry.witness
            || hash_bytes(&bytes(&file, 16 * 1024 * 1024)?) != entry.hash
        {
            return Err(error());
        }
        let parent = Directory::open_or_create(path.parent().ok_or_else(error)?, false)
            .map_err(|_| error())?;
        file.assert_current().map_err(|_| error())?;
        parent.assert_current().map_err(|_| error())?;
        // This is a cooperative same-UID namespace, not an adversarial inode-CAS.
        // Held/name proof immediately precedes the one owned unlink; no foreign file
        // or unprepared leftover is enumerated as disposable material.
        unlinkat(
            parent.held.as_fd(),
            path.file_name().ok_or_else(error)?,
            UnlinkatFlags::NoRemoveDir,
        )
        .map_err(|_| error())?;
        parent.held.sync_all().map_err(|_| error())?;
        parent.assert_current().map_err(|_| error())?;
        hook("compaction_unlinked")?;
    }
    prepared.record("compacted.json", &wire, hook)?;
    inventory(prepared, &names)?;
    active(cancelled, deadline)?;
    hook("compacted")?;
    Ok(())
}

fn unprepared_copy_name(name: &str) -> bool {
    name.strip_prefix(".unprepared-copy-").is_some_and(|v| {
        v.len() == 32
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
/// These incomplete copy leaves are diagnostic retained material. They are never
/// replayed, used as an immutable record, or deleted. A fresh copy uses a new name.
pub(super) fn retained_unprepared(prepared: &Prepared) -> Result<Vec<PathBuf>, String> {
    prepared.directory.assert_current().map_err(|_| error())?;
    let before = Witness::of(&prepared.directory.held.metadata().map_err(|_| error())?);
    let mut retained = vec![];
    let mut entries = 0usize;
    for entry in fs::read_dir(&prepared.directory.path).map_err(|_| error())? {
        entries += 1;
        if entries > 256 {
            return Err(error());
        }
        let entry = entry.map_err(|_| error())?;
        let name = entry.file_name().into_string().map_err(|_| error())?;
        if !unprepared_copy_name(&name) {
            continue;
        }
        let named = fs::symlink_metadata(entry.path()).map_err(|_| error())?;
        let file = File::from(
            openat(
                prepared.directory.held.as_fd(),
                name.as_str(),
                OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| error())?,
        );
        let held = file.metadata().map_err(|_| error())?;
        if !held.is_file()
            || held.nlink() != 1
            || held.uid() != nix::unistd::getuid().as_raw()
            || ![0o600, 0o444].contains(&(held.mode() & 0o7777))
            || held.len() > 16 * 1024 * 1024
            || Witness::of(&named) != Witness::of(&held)
            || Witness::of(&fs::symlink_metadata(entry.path()).map_err(|_| error())?)
                != Witness::of(&held)
        {
            return Err(error());
        }
        retained.push(entry.path());
    }
    if before != Witness::of(&prepared.directory.held.metadata().map_err(|_| error())?) {
        return Err(error());
    }
    prepared.directory.assert_current().map_err(|_| error())?;
    retained.sort();
    Ok(retained)
}
