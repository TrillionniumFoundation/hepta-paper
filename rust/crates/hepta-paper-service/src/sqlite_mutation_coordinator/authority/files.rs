use super::*;
use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
};
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use std::{
    fmt,
    fs::{self, File, Metadata},
    io::Read,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, PathBuf},
};
pub(crate) struct Snapshot {
    pub path: PathBuf,
    pub file: File,
    bytes: Vec<u8>,
    metadata: Metadata,
    ancestors: Vec<(PathBuf, Metadata)>,
}
fn same(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.mode() == b.mode()
        && a.nlink() == b.nlink()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
impl Snapshot {
    pub fn load(path: &Path, pin: &str, maximum: u64, code: &str) -> Result<Self> {
        if !path.is_absolute()
            || !sha(&json!(pin))
            || path.components().any(|p| matches!(p, Component::ParentDir))
        {
            return Err(error(code));
        }
        let mut directory = File::from(
            open(
                Path::new("/"),
                OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_DIRECTORY,
                Mode::empty(),
            )
            .map_err(|_| error(code))?,
        );
        let mut cursor = PathBuf::from("/");
        let mut ancestors = vec![(
            cursor.clone(),
            directory.metadata().map_err(|_| error(code))?,
        )];
        let mut parts = path
            .components()
            .filter_map(|p| {
                if let Component::Normal(v) = p {
                    Some(v)
                } else {
                    None
                }
            })
            .peekable();
        let mut selected = None;
        while let Some(part) = parts.next() {
            let last = parts.peek().is_none();
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
                    .map_err(|_| error(code))?,
            );
            cursor.push(part);
            if last {
                selected = Some(file);
            } else {
                ancestors.push((cursor.clone(), file.metadata().map_err(|_| error(code))?));
                directory = file;
            }
        }
        let mut file = selected.ok_or_else(|| error(code))?;
        let metadata = file.metadata().map_err(|_| error(code))?;
        let uid = nix::unistd::getuid().as_raw();
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.mode() & 0o022 != 0
            || (metadata.uid() != 0 && metadata.uid() != uid)
            || metadata.len() == 0
            || metadata.len() > maximum
        {
            return Err(error(code));
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(maximum + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| error(code))?;
        if bytes.len() as u64 != metadata.len()
            || hash_bytes(&bytes) != pin
            || !same(&metadata, &file.metadata().map_err(|_| error(code))?)
        {
            return Err(error(code));
        }
        let snapshot = Self {
            path: path.to_owned(),
            file,
            bytes,
            metadata,
            ancestors,
        };
        snapshot.assert_current().map_err(|_| error(code))?;
        Ok(snapshot)
    }
    pub fn assert_current(&self) -> Result<()> {
        let failed =
            || error("autonomous_research_online_mutation_authority_process_identity_changed");
        for (path, before) in &self.ancestors {
            let current = fs::symlink_metadata(path).map_err(|_| failed())?;
            if !current.is_dir()
                || current.is_symlink()
                || current.dev() != before.dev()
                || current.ino() != before.ino()
            {
                return Err(failed());
            }
        }
        if !same(&self.metadata, &self.file.metadata().map_err(|_| failed())?)
            || !same(
                &self.metadata,
                &fs::symlink_metadata(&self.path).map_err(|_| failed())?,
            )
        {
            return Err(failed());
        }
        Ok(())
    }
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn json(&self, code: &str) -> Result<Value> {
        parse(&self.bytes, code)
    }
    pub fn executable(&self) -> bool {
        self.metadata.mode() & 0o111 != 0
    }
}
pub(crate) fn parse(bytes: &[u8], code: &str) -> Result<Value> {
    let Strict(value) = serde_json::from_slice(bytes).map_err(|_| error(code))?;
    Ok(value)
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
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("JSON without duplicate object keys")
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Strict, E> {
        Ok(Strict(Value::Null))
    }
    fn visit_bool<E: de::Error>(self, value: bool) -> std::result::Result<Strict, E> {
        Ok(Strict(value.into()))
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> std::result::Result<Strict, E> {
        Ok(Strict(value.into()))
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> std::result::Result<Strict, E> {
        Ok(Strict(value.into()))
    }
    fn visit_f64<E: de::Error>(self, value: f64) -> std::result::Result<Strict, E> {
        if value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
            return Ok(Strict(Value::from(value as i64)));
        }
        serde_json::Number::from_f64(value)
            .map(|n| Strict(Value::Number(n)))
            .ok_or_else(|| E::custom("nonfinite number"))
    }
    fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Strict, E> {
        Ok(Strict(value.into()))
    }
    fn visit_string<E: de::Error>(self, value: String) -> std::result::Result<Strict, E> {
        Ok(Strict(value.into()))
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
                return Err(de::Error::custom("duplicate JSON object key"));
            }
        }
        Ok(Strict(Value::Object(values)))
    }
}
