use super::*;
use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
};
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use sha2::{Digest, Sha256};
use std::{
    fmt,
    fs::File,
    io::Read,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, Path},
};

pub(super) fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub(super) fn sha(v: &Value) -> bool {
    s(v).strip_prefix("sha256:").is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub(super) fn id(v: &Value) -> bool {
    let s = s(v);
    (3..=160).contains(&s.len())
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:@/-".contains(&b))
}
pub(super) fn exact(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}
pub(super) fn ensure(b: bool, code: &str) -> Result<()> {
    if b { Ok(()) } else { Err(code.into()) }
}
pub(super) fn hash(kind: &str, v: &Value) -> Result<String> {
    hepta_legacy_compatibility::production_hash_record_v1(kind, v)
        .map(|x| x.as_str().to_owned())
        .map_err(|_| Error("runtime_reproducibility_hash_invalid".into()))
}
pub(super) fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
pub(super) fn without(v: &Value, keys: &[&str]) -> Value {
    let mut v = v.clone();
    if let Some(o) = v.as_object_mut() {
        for k in keys {
            o.remove(*k);
        }
    }
    v
}
pub(super) fn rehash(kind: &str, v: &Value, field: &str) -> bool {
    sha(&v[field]) && hash(kind, &without(v, &[field])).is_ok_and(|h| v[field] == h)
}
pub(super) fn seal(kind: &str, mut v: Value, field: &str) -> Result<Value> {
    v[field] = hash(kind, &v)?.into();
    Ok(v)
}
pub(super) fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub(super) fn parse(bytes: &[u8]) -> Result<Value> {
    serde_json::from_slice::<StrictJson>(bytes)
        .map(|x| x.0)
        .map_err(|_| Error("runtime_reproducibility_json_invalid".into()))
}
// Open every component through a pinned directory descriptor. Links, hardlinks,
// unsafe permissions, oversized files, and files changed while reading fail closed.
pub(super) fn read(path: &Path, max: u64) -> Result<Vec<u8>> {
    read_with_policy(path, max, true)
}
pub(super) fn read_source(path: &Path, max: u64) -> Result<Vec<u8>> {
    read_with_policy(path, max, false)
}
fn read_with_policy(path: &Path, max: u64, strict_permissions: bool) -> Result<Vec<u8>> {
    ensure(
        path.is_absolute()
            && path
                .components()
                .all(|c| matches!(c, Component::RootDir | Component::Normal(_))),
        "runtime_reproducibility_path_not_canonical",
    )?;
    let mut parts = path
        .components()
        .filter_map(|c| {
            if let Component::Normal(x) = c {
                Some(x)
            } else {
                None
            }
        })
        .peekable();
    let mut dir = open(
        Path::new("/"),
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| Error("runtime_reproducibility_file_unavailable".into()))?;
    let mut selected = None;
    while let Some(part) = parts.next() {
        let flags = OFlag::O_RDONLY
            | OFlag::O_NOFOLLOW
            | OFlag::O_NONBLOCK
            | OFlag::O_CLOEXEC
            | if parts.peek().is_some() {
                OFlag::O_DIRECTORY
            } else {
                OFlag::empty()
            };
        let fd = openat(dir.as_fd(), Path::new(part), flags, Mode::empty())
            .map_err(|_| Error("runtime_reproducibility_file_unavailable".into()))?;
        if parts.peek().is_some() {
            dir = fd
        } else {
            selected = Some(fd)
        }
    }
    let mut f =
        File::from(selected.ok_or_else(|| Error("runtime_reproducibility_file_invalid".into()))?);
    let before = f.metadata()?;
    ensure(
        before.is_file()
            && before.nlink() == 1
            && (!strict_permissions || before.mode() & 0o022 == 0)
            && before.len() <= max,
        "runtime_reproducibility_file_invalid",
    )?;
    let mut bytes = Vec::new();
    (&mut f).take(max + 1).read_to_end(&mut bytes)?;
    let after = f.metadata()?;
    ensure(
        bytes.len() as u64 == before.len()
            && before.len() == after.len()
            && before.ino() == after.ino()
            && before.dev() == after.dev()
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec()
            && before.ctime() == after.ctime()
            && before.ctime_nsec() == after.ctime_nsec(),
        "runtime_reproducibility_file_changed",
    )?;
    Ok(bytes)
}
pub(super) fn instant(v: &Value) -> Option<i64> {
    let t = s(v).as_bytes();
    if t.len() != 24
        || t[4] != b'-'
        || t[7] != b'-'
        || t[10] != b'T'
        || t[13] != b':'
        || t[16] != b':'
        || t[19] != b'.'
        || t[23] != b'Z'
    {
        return None;
    }
    let number = |a: usize, b: usize| {
        let x = &t[a..b];
        if x.iter().all(u8::is_ascii_digit) {
            Some(x.iter().fold(0i64, |n, c| n * 10 + i64::from(c - b'0')))
        } else {
            None
        }
    };
    let (y, m, d, h, min, sec, ms) = (
        number(0, 4)?,
        number(5, 7)?,
        number(8, 10)?,
        number(11, 13)?,
        number(14, 16)?,
        number(17, 19)?,
        number(20, 23)?,
    );
    let maxday = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    };
    if d < 1 || d > maxday || h > 23 || min > 59 || sec > 59 {
        return None;
    }
    let adj = y - i64::from(m <= 2);
    let era = if adj >= 0 { adj } else { adj - 399 } / 400;
    let yoe = adj - era * 400;
    let mp = m + if m > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    Some(((days * 24 + h) * 60 + min) * 60000 + sec * 1000 + ms)
}
struct StrictJson(Value);
impl<'de> Deserialize<'de> for StrictJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        deserializer.deserialize_any(JsonVisitor)
    }
}
struct JsonVisitor;
impl<'de> Visitor<'de> for JsonVisitor {
    type Value = StrictJson;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("bounded duplicate-free JSON")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Self::Value, E> {
        Ok(StrictJson(v.into()))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Self::Value, E> {
        Ok(StrictJson(v.into()))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Self::Value, E> {
        Ok(StrictJson(v.into()))
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Self::Value, E> {
        serde_json::Number::from_f64(v)
            .map(|n| StrictJson(Value::Number(n)))
            .ok_or_else(|| E::custom("nonfinite number"))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Self::Value, E> {
        if v.len() > 65536 {
            Err(E::custom("string too long"))
        } else {
            Ok(StrictJson(v.into()))
        }
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Self::Value, E> {
        Ok(StrictJson(Value::Null))
    }
    fn visit_seq<A: SeqAccess<'de>>(
        self,
        mut seq: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let mut values = Vec::new();
        while let Some(v) = seq.next_element::<StrictJson>()? {
            if values.len() >= 100_000 {
                return Err(de::Error::custom("array too long"));
            }
            values.push(v.0);
        }
        Ok(StrictJson(values.into()))
    }
    fn visit_map<A: MapAccess<'de>>(
        self,
        mut map: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let mut values = serde_json::Map::new();
        while let Some((k, v)) = map.next_entry::<String, StrictJson>()? {
            if k.len() > 192 || values.len() >= 256 || values.contains_key(&k) {
                return Err(de::Error::custom("invalid object key"));
            }
            values.insert(k, v.0);
        }
        let value = Value::Object(values);
        Ok(StrictJson(value))
    }
}

pub(super) fn iso(milliseconds: i64) -> Result<String> {
    let days = milliseconds.div_euclid(86_400_000);
    let within = milliseconds.rem_euclid(86_400_000);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = year + i64::from(month <= 2);
    ensure(
        (0..=9999).contains(&year),
        "runtime_reproducibility_clock_invalid",
    )?;
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        within / 3_600_000,
        within / 60_000 % 60,
        within / 1000 % 60,
        within % 1000
    ))
}
pub(super) fn clock() -> Result<String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| Error("runtime_reproducibility_clock_invalid".into()))?;
    iso(i64::try_from(now.as_millis())
        .map_err(|_| Error("runtime_reproducibility_clock_invalid".into()))?)
}
pub(super) fn nonce() -> Result<String> {
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex = hex::encode(bytes);
    Ok(format!(
        "runtime-repro:{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}
