use hepta_legacy_compatibility::{production_digest_v1, production_hash_record_v1};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub(super) fn truth(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|n| n != 0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
pub(super) fn or<'a>(a: &'a Value, b: &'a Value) -> &'a Value {
    if truth(a) { a } else { b }
}
pub(super) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(v) => v.clone(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => ryu_js::Buffer::new()
            .format(v.as_f64().unwrap_or(f64::NAN))
            .to_owned(),
        Value::Array(v) => v.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}
pub(super) fn text(value: &Value) -> String {
    let input = js_string(value).replace('\r', "");
    let mut result = String::new();
    let mut space = false;
    let mut newlines = 0;
    for c in input.chars() {
        if c == ' ' || c == '\t' {
            if !space {
                result.push(' ')
            }
            space = true;
            newlines = 0;
        } else {
            space = false;
            if c == '\n' {
                newlines += 1;
                if newlines <= 2 {
                    result.push(c)
                }
            } else {
                newlines = 0;
                result.push(c)
            }
        }
    }
    result.trim_matches(|c:char|matches!(c, '\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')).to_owned()
}
pub(super) fn field_text(value: &Value, key: &str) -> String {
    text(&value[key])
}
pub(super) fn nullable(value: String) -> Value {
    if value.is_empty() {
        Value::Null
    } else {
        json!(value)
    }
}
pub(super) fn unique(values: impl IntoIterator<Item = String>, limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    for v in values {
        let v = text(&json!(v));
        if !v.is_empty() && !out.contains(&v) {
            out.push(v);
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}
pub(super) fn digest(value: &Value) -> Result<String, String> {
    production_digest_v1(value)
        .map(|h| h.as_str().to_owned())
        .map_err(|e| e.to_string())
}
pub(super) fn hash_record(kind: &str, value: &Value) -> Result<String, String> {
    production_hash_record_v1(kind, value)
        .map(|h| h.as_str().to_owned())
        .map_err(|e| e.to_string())
}
pub(super) fn hash_paper(kind: &str, value: &Value) -> Result<String, String> {
    digest(&json!({"version":1,"kind":kind,"payload":value}))
}
fn semantic(value: &Value) -> Value {
    match value {
        Value::Array(v) => Value::Array(v.iter().map(semantic).collect()),
        Value::Object(v) => Value::Object(
            v.iter()
                .filter(|(key, _)| {
                    !matches!(
                        key.as_str(),
                        "createdAt"
                            | "observedAt"
                            | "recordedAt"
                            | "verifiedAt"
                            | "semanticIdentityVersion"
                            | "semanticIdentityHash"
                    )
                })
                .map(|(k, v)| (k.clone(), semantic(v)))
                .collect(),
        ),
        _ => value.clone(),
    }
}
pub(super) fn semantic_hash(kind: &str, value: &Value) -> Result<String, String> {
    digest(
        &json!({"version":2,"policy":"paper-semantic-identity-v2","kind":kind,"payload":semantic(value)}),
    )
}
pub(super) fn resolve(root: &Path, value: &Value) -> Option<PathBuf> {
    let t = text(value);
    if t.is_empty() {
        None
    } else {
        Some(lexical(&root.join(t)))
    }
}
pub(super) fn lexical(path: &Path) -> PathBuf {
    let mut p = PathBuf::new();
    for c in path.components() {
        match c {
            std::path::Component::ParentDir => {
                p.pop();
            }
            std::path::Component::CurDir => {}
            _ => p.push(c.as_os_str()),
        }
    }
    p
}
pub(super) fn relative(root: &Path, path: &Path) -> Result<String, String> {
    let p = lexical(path);
    let rel = p
        .strip_prefix(root)
        .map_err(|_| "native_inventory_outside_root_refused")?;
    Ok(if rel.as_os_str().is_empty() {
        ".".to_owned()
    } else {
        rel.to_str()
            .ok_or("native_inventory_non_utf8_refused")?
            .to_owned()
    })
}
/// Node path.relative for a logical inventory identity only. Every actual read
/// continues to use observed_relative against its independently held owner.
pub(super) fn logical_relative(root: &Path, path: &Path) -> Result<String, String> {
    if !root.is_absolute() || !path.is_absolute() {
        return Err("native_inventory_path_invalid".to_owned());
    }
    let root = lexical(root);
    let target = lexical(path);
    let left = root.components().collect::<Vec<_>>();
    let right = target.components().collect::<Vec<_>>();
    let shared = left.iter().zip(&right).take_while(|(a, b)| a == b).count();
    let mut result = PathBuf::new();
    for _ in shared..left.len() {
        result.push("..");
    }
    for component in &right[shared..] {
        result.push(component.as_os_str());
    }
    Ok(if result.as_os_str().is_empty() {
        ".".to_owned()
    } else {
        result
            .to_str()
            .ok_or("native_inventory_non_utf8_refused")?
            .to_owned()
    })
}
pub(super) fn observed_relative(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let p = lexical(path);
    p.strip_prefix(root)
        .map(Path::to_path_buf)
        .map_err(|_| "native_inventory_outside_root_refused".to_owned())
}
struct BoundWriter {
    bytes: usize,
    maximum: usize,
}
impl std::io::Write for BoundWriter {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.bytes = self
            .bytes
            .checked_add(b.len())
            .filter(|n| *n <= self.maximum)
            .ok_or_else(|| std::io::Error::other("native_inventory_output_v1_exceeded"))?;
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub(super) fn bounded_json(value: &Value) -> Result<(), String> {
    serde_json::to_writer(
        BoundWriter {
            bytes: 0,
            maximum: 16 * 1024 * 1024,
        },
        value,
    )
    .map_err(|_| "native_inventory_output_v1_exceeded".to_owned())
}
pub(super) fn charge(value: &Value, remaining: &mut usize) -> Result<(), String> {
    let mut writer = BoundWriter {
        bytes: 0,
        maximum: *remaining,
    };
    serde_json::to_writer(&mut writer, value)
        .map_err(|_| "native_inventory_output_v1_exceeded".to_owned())?;
    *remaining -= writer.bytes;
    Ok(())
}

// Original JSON.parse text is parsed by the existing production UTF-16/Number
// owner. This native scan explicitly refuses values Rust cannot retain rather
// than silently replacing surrogate units or losing a declared quality field.
pub(super) fn native_json(bytes: &[u8]) -> Result<Option<Value>, String> {
    use hepta_legacy_compatibility::{ProductionJsonValue as N, parse_production_json_v1};
    fn representable(value: &N) -> bool {
        match value {
            N::String(s) => String::from_utf16(s).is_ok(),
            N::Number(v) => v.is_finite(),
            N::Array(v) => v.iter().all(representable),
            N::Object(v) => v
                .iter()
                .all(|(k, v)| String::from_utf16(k).is_ok() && representable(v)),
            _ => true,
        }
    }
    let value = match parse_production_json_v1(bytes) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if !representable(&value) {
        return Err("native_inventory_json_scalar_profile_refused".to_owned());
    }
    crate::online_runtime_activation::ordered_json::parse_ordered(bytes).map(|v| Some(v.to_value()))
}
