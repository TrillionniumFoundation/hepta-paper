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
    os::fd::AsFd,
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
};

pub(super) fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub(super) fn sha(v: &Value) -> bool {
    s(v).strip_prefix("sha256:").is_some_and(|h| {
        h.len() == 64
            && h.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub(super) fn no_placeholder(v: &str) -> bool {
    let upper = v.to_ascii_uppercase();
    !["REPLACE_WITH", "PLACEHOLDER", "CHANGEME", "INSERT_", "TODO"]
        .iter()
        .any(|p| upper.contains(p))
}
pub(super) fn id(v: &Value) -> bool {
    let t = s(v);
    (3..=192).contains(&t.len())
        && t.as_bytes()[0].is_ascii_alphanumeric()
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:@/-".contains(&b))
        && no_placeholder(t)
}
pub(super) fn key_id(v: &Value) -> bool {
    let t = s(v);
    (1..=192).contains(&t.len())
        && t.as_bytes()[0].is_ascii_alphanumeric()
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}
pub(super) fn org(v: &Value) -> bool {
    let t = s(v);
    (3..=192).contains(&t.len())
        && t.as_bytes()[0].is_ascii_alphanumeric()
        && t.trim() == t
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b" .,&_:@/'()-".contains(&b))
        && no_placeholder(t)
}
pub(super) fn org_identity(v: &Value) -> String {
    s(v).split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}
pub(super) fn exact(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}
pub(super) fn positive(v: &Value) -> bool {
    v.as_u64()
        .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
}
// The Node entrypoint applies Number(...) before its safe-integer check.
// Preserve that wire boundary without admitting infinities or rounded integers.
pub(super) fn request_integer(value: &Value) -> Option<u64> {
    fn whitespace(c: char) -> bool {
        matches!(c, '\u{0009}'..='\u{000D}' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
    }
    fn array_string(value: &Value) -> Option<String> {
        match value {
            Value::Null => Some(String::new()),
            Value::String(v) => Some(v.clone()),
            Value::Array(v) => v
                .iter()
                .map(array_string)
                .collect::<Option<Vec<_>>>()
                .map(|v| v.join(",")),
            Value::Object(_) => None,
            value => Some(value.to_string()),
        }
    }
    fn number(text: &str) -> Option<f64> {
        let text = text.trim_matches(whitespace);
        if text.is_empty() {
            return Some(0.0);
        }
        for (prefix, radix) in [
            ("0x", 16),
            ("0X", 16),
            ("0o", 8),
            ("0O", 8),
            ("0b", 2),
            ("0B", 2),
        ] {
            if let Some(digits) = text.strip_prefix(prefix) {
                return u64::from_str_radix(digits, radix).ok().map(|v| v as f64);
            }
        }
        text.parse::<f64>().ok()
    }
    let n = match value {
        Value::Null => 0.0,
        Value::Bool(v) => f64::from(u8::from(*v)),
        Value::Number(v) => v.as_f64()?,
        Value::String(v) => number(v)?,
        Value::Array(_) => number(&array_string(value)?)?,
        Value::Object(_) => return None,
    };
    (n.is_finite() && n > 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0)
        .then_some(n as u64)
}
pub(super) fn bounded(v: &Value, max: u64) -> bool {
    positive(v) && v.as_u64().is_some_and(|n| n <= max)
}
pub(super) fn ensure(condition: bool, code: &'static str) -> Result<()> {
    if condition { Ok(()) } else { Err(code.into()) }
}
pub(super) fn hash(kind: &str, v: &Value) -> Result<String> {
    hepta_legacy_compatibility::production_hash_record_v1(kind, v)
        .map(|h| h.as_str().to_owned())
        .map_err(|_| "nested_runtime_platform_hash_encoding_invalid".into())
}
pub(super) fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
pub(super) fn pod(v: &Value) -> bool {
    let x = s(v).as_bytes();
    x.len() == 36
        && [8, 13, 18, 23].iter().all(|i| x[*i] == b'-')
        && x.iter().enumerate().all(|(i, b)| {
            [8, 13, 18, 23].contains(&i) || b.is_ascii_digit() || (b'a'..=b'f').contains(b)
        })
        && (b'1'..=b'5').contains(&x[14])
        && b"89ab".contains(&x[19])
}
pub(super) fn absolute(v: &Value) -> bool {
    let t = s(v);
    t.len() <= 4096
        && t.starts_with('/')
        && t != "/"
        && no_placeholder(t)
        && t[1..].split('/').all(|p| {
            !p.is_empty()
                && p.as_bytes()[0].is_ascii_alphanumeric()
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
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
pub(super) fn window(v: &Value, now: i64, max: u64, prefix: &str) -> Vec<String> {
    let (Some(issued), Some(valid), Some(expires)) = (
        instant(&v["issuedAt"]),
        instant(&v["validFrom"]),
        instant(&v["expiresAt"]),
    ) else {
        return vec![format!("{prefix}_time_window_invalid")];
    };
    let mut out = Vec::new();
    if valid < issued || expires <= valid {
        out.push(format!("{prefix}_time_window_invalid"));
    }
    if now < valid {
        out.push(format!("{prefix}_not_yet_valid"));
    }
    if now >= expires {
        out.push(format!("{prefix}_expired"));
    }
    if expires - issued > max as i64 {
        out.push(format!("{prefix}_lifetime_exceeds_policy"));
    }
    out
}
pub(super) fn unique(values: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for v in values {
        if !out.contains(&v) {
            out.push(v)
        }
    }
    out
}

// Evidence paths are resolved lexically and opened descriptor-relatively from
// '/', refusing symlinks in every component. A renamed parent cannot redirect
// any later open. No input is ever written, chmodded, or repaired.
pub(super) fn resolve(base: &Path, value: &Value) -> Result<PathBuf> {
    let raw = s(value);
    ensure(
        !raw.is_empty() && raw.len() <= 4096 && !raw.contains('\0'),
        "nested_runtime_platform_evidence_path_not_canonical",
    )?;
    let input = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        base.join(raw)
    };
    let mut output = PathBuf::from("/");
    for part in input.components() {
        match part {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(v) => output.push(v),
            Component::ParentDir => {
                output.pop();
            }
            _ => return Err("nested_runtime_platform_evidence_path_not_canonical".into()),
        }
    }
    Ok(output)
}
pub(super) fn read_json(path: &Path, max: u64) -> Result<(Value, String)> {
    let mut parts = path
        .components()
        .filter_map(|p| {
            if let Component::Normal(s) = p {
                Some(s)
            } else {
                None
            }
        })
        .peekable();
    let mut directory = open(
        Path::new("/"),
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| {
        NestedRuntimeQualificationError::from("nested_runtime_platform_evidence_file_unavailable")
    })?;
    let mut selected = None;
    while let Some(part) = parts.next() {
        let flags = OFlag::O_RDONLY
            | OFlag::O_NOFOLLOW
            | OFlag::O_CLOEXEC
            | OFlag::O_NONBLOCK
            | if parts.peek().is_some() {
                OFlag::O_DIRECTORY
            } else {
                OFlag::empty()
            };
        let fd =
            openat(directory.as_fd(), Path::new(part), flags, Mode::empty()).map_err(|_| {
                NestedRuntimeQualificationError::from(
                    "nested_runtime_platform_evidence_path_not_canonical",
                )
            })?;
        if parts.peek().is_some() {
            directory = fd;
        } else {
            selected = Some(fd);
        }
    }
    let fd = selected.ok_or_else(|| {
        NestedRuntimeQualificationError::from("nested_runtime_platform_evidence_file_invalid")
    })?;
    let mut file = File::from(fd);
    let before = file.metadata().map_err(|_| {
        NestedRuntimeQualificationError::from("nested_runtime_platform_evidence_file_unavailable")
    })?;
    ensure(
        before.is_file()
            && before.nlink() == 1
            && (2..=max).contains(&before.len())
            && before.mode() & 0o022 == 0,
        "nested_runtime_platform_evidence_file_invalid",
    )?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            NestedRuntimeQualificationError::from(
                "nested_runtime_platform_evidence_file_unavailable",
            )
        })?;
    let after = file.metadata().map_err(|_| {
        NestedRuntimeQualificationError::from("nested_runtime_platform_evidence_file_unavailable")
    })?;
    ensure(
        bytes.len() as u64 == before.len()
            && after.len() == before.len()
            && after.dev() == before.dev()
            && after.ino() == before.ino()
            && after.mtime() == before.mtime()
            && after.mtime_nsec() == before.mtime_nsec()
            && after.ctime() == before.ctime()
            && after.ctime_nsec() == before.ctime_nsec(),
        "nested_runtime_platform_evidence_changed_during_read",
    )?;
    let parsed: StrictJson = serde_json::from_slice(&bytes).map_err(|_| {
        NestedRuntimeQualificationError::from("nested_runtime_platform_evidence_json_invalid")
    })?;
    ensure(
        parsed.0.is_object(),
        "nested_runtime_platform_evidence_json_invalid",
    )?;
    Ok((parsed.0, digest(&bytes)))
}
// serde's ordinary Value parser overwrites duplicate keys. Evidence rejects
// them, as well as unbounded collections and noncanonical envelope/identity
// insertion order used by the original Node verifier.
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
        // JSON.parse represents 2, 2.0 and 2e0 as the same JavaScript Number.
        // Normalize safe integral decimal tokens before typed contract checks.
        if v.is_finite() && v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0 {
            return Ok(StrictJson(if v >= 0.0 {
                Value::from(v as u64)
            } else {
                Value::from(v as i64)
            }));
        }
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
            if values.len() >= 4096 {
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
        let mut order = Vec::new();
        while let Some((k, v)) = map.next_entry::<String, StrictJson>()? {
            if k.len() > 192 || values.len() >= 256 || values.contains_key(&k) {
                return Err(de::Error::custom("invalid object key"));
            }
            order.push(k.clone());
            values.insert(k, v.0);
        }
        let value = Value::Object(values);
        let expected = match s(&value["kind"]) {
            "PinnedExternalEvidenceEnvelope" => Some(vec![
                "version",
                "kind",
                "subjectKind",
                "subjectHash",
                "signedAt",
                "expiresAt",
                "signatures",
            ]),
            "ExternalPrincipalIdentityAttestationSubject" => Some(vec![
                "version",
                "kind",
                "serviceId",
                "principalId",
                "provider",
                "providerAccountIdentityHash",
                "credentialRootIdentityHash",
                "hostIdentityHash",
                "processIdentityHash",
                "trustDomainIdentityHash",
                "signerPublicKeySpkiHash",
                "challengeHash",
                "assuranceProfile",
                "attestedAt",
                "expiresAt",
                "externalPrincipalIdentityAttestationSubjectHash",
            ]),
            _ => None,
        };
        if expected.is_some_and(|e| e != order) {
            return Err(de::Error::custom("noncanonical object order"));
        }
        Ok(StrictJson(value))
    }
}
