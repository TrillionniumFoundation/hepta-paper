//! Descriptor-relative snapshots for current source and imported owner authority.
use super::{Result, error};
use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
};
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fmt,
    fs::{self, File, Metadata},
    io::Read,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Debug)]
pub(crate) struct Snapshot {
    pub(crate) document: Value,
    pub(crate) content_hash: String,
    paths: Vec<(PathBuf, Metadata)>,
    private: bool,
}
fn same(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.mode() == b.mode()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
        && a.nlink() == b.nlink()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
impl Snapshot {
    pub(crate) fn selected_uid(&self) -> u32 {
        self.paths.last().map_or(0, |(_, metadata)| metadata.uid())
    }

    pub fn assert_current(&self) -> Result<()> {
        for (index, (path, expected)) in self.paths.iter().enumerate() {
            let current =
                fs::symlink_metadata(path).map_err(|_| error("owner_acceptance_file_changed"))?;
            if current.is_symlink()
                || current.dev() != expected.dev()
                || current.ino() != expected.ino()
                || current.file_type() != expected.file_type()
            {
                return Err(error("owner_acceptance_file_changed"));
            }
            if index + 1 == self.paths.len()
                && (!same(expected, &current) || (self.private && current.mode() & 0o022 != 0))
            {
                return Err(error("owner_acceptance_file_changed"));
            }
        }
        Ok(())
    }
}
pub(crate) fn read(path: &Path, private: bool) -> Result<Snapshot> {
    if !path.is_absolute() || path.components().any(|v| matches!(v, Component::ParentDir)) {
        return Err(error("owner_acceptance_path_invalid"));
    }
    let mut directory = File::from(
        open(
            Path::new("/"),
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| error("owner_acceptance_read_failed"))?,
    );
    let mut cursor = PathBuf::from("/");
    let mut paths = vec![(
        cursor.clone(),
        directory
            .metadata()
            .map_err(|_| error("owner_acceptance_read_failed"))?,
    )];
    let mut components = path
        .components()
        .filter_map(|v| {
            if let Component::Normal(v) = v {
                Some(v)
            } else {
                None
            }
        })
        .peekable();
    let mut selected = None;
    while let Some(part) = components.next() {
        let last = components.peek().is_none();
        let flags = OFlag::O_RDONLY
            | OFlag::O_NOFOLLOW
            | OFlag::O_CLOEXEC
            | OFlag::O_NONBLOCK
            | if last {
                OFlag::empty()
            } else {
                OFlag::O_DIRECTORY
            };
        let file = File::from(
            openat(directory.as_fd(), Path::new(part), flags, Mode::empty())
                .map_err(|_| error("owner_acceptance_path_invalid"))?,
        );
        cursor.push(part);
        paths.push((
            cursor.clone(),
            file.metadata()
                .map_err(|_| error("owner_acceptance_read_failed"))?,
        ));
        if last {
            selected = Some(file);
        } else {
            directory = file;
        }
    }
    let mut file = selected.ok_or_else(|| error("owner_acceptance_file_invalid"))?;
    let before = file
        .metadata()
        .map_err(|_| error("owner_acceptance_read_failed"))?;
    if !before.is_file()
        || before.nlink() != 1
        || before.len() > 16 * 1024 * 1024
        || (private && before.mode() & 0o022 != 0)
    {
        return Err(error("owner_acceptance_file_invalid"));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("owner_acceptance_read_failed"))?;
    if bytes.len() as u64 != before.len()
        || !same(
            &before,
            &file
                .metadata()
                .map_err(|_| error("owner_acceptance_read_failed"))?,
        )
    {
        return Err(error("owner_acceptance_file_changed"));
    }
    let Strict(document) =
        serde_json::from_slice(&bytes).map_err(|_| error("owner_acceptance_json_invalid"))?;
    let snapshot = Snapshot {
        document,
        content_hash: format!("sha256:{:x}", Sha256::digest(&bytes)),
        paths,
        private,
    };
    snapshot.assert_current()?;
    Ok(snapshot)
}
struct Strict(Value);
impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        deserializer.deserialize_any(StrictVisitor)
    }
}
struct StrictVisitor;
impl<'de> Visitor<'de> for StrictVisitor {
    type Value = Strict;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JSON without duplicate object keys")
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Strict, E> {
        Ok(Strict(Value::Null))
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Strict, E> {
        Ok(Strict(v.into()))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Strict, E> {
        Ok(Strict(v.into()))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Strict, E> {
        Ok(Strict(v.into()))
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Strict, E> {
        serde_json::Number::from_f64(v)
            .map(|v| Strict(Value::Number(v)))
            .ok_or_else(|| E::custom("nonfinite number"))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Strict, E> {
        Ok(Strict(v.into()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<Strict, E> {
        Ok(Strict(v.into()))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Strict, A::Error> {
        let mut values = Vec::new();
        while let Some(Strict(value)) = seq.next_element()? {
            values.push(value);
        }
        Ok(Strict(values.into()))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Strict, A::Error> {
        let mut values = serde_json::Map::new();
        while let Some((key, Strict(value))) = map.next_entry::<String, Strict>()? {
            if values.insert(key, value).is_some() {
                return Err(de::Error::custom("duplicate object key"));
            }
        }
        Ok(Strict(Value::Object(values)))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn owner_snapshot_detects_file_and_parent_replacement_after_read() {
        let root =
            std::env::temp_dir().join(format!("hepta-owner-snapshot-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let parent = root.join("intake");
        fs::create_dir(&parent).unwrap();
        let file = parent.join("document.json");
        fs::write(&file, b"{}").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        let snapshot = read(&file, true).unwrap();
        let replacement = parent.join("replacement.json");
        fs::write(&replacement, b"{}").unwrap();
        fs::rename(&replacement, &file).unwrap();
        assert!(snapshot.assert_current().is_err());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        let snapshot = read(&file, true).unwrap();
        fs::rename(&parent, root.join("old-intake")).unwrap();
        fs::create_dir(&parent).unwrap();
        fs::write(&file, b"{}").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(snapshot.assert_current().is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
