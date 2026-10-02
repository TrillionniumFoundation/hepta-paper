//! Byte/UTF-16 manuscript boundaries shared by the actual canonical readers.
use serde::Serialize;
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
#[derive(Clone, Copy)]
pub enum Universe {
    Formal,
    EmpiricalClaim,
    EmpiricalAssertion,
}
impl Universe {
    fn prefix(self) -> &'static str {
        match self {
            Self::Formal => "formal_claim_universe",
            Self::EmpiricalClaim => "empirical_claim_universe",
            Self::EmpiricalAssertion => "empirical_assertion_universe",
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteralInclude {
    pub path: String,
    pub byte_start: usize,
    pub byte_end: usize,
}
#[derive(Clone, Debug, Serialize)]
pub struct Includes {
    pub includes: Vec<LiteralInclude>,
    pub blockers: Vec<String>,
    #[serde(skip)]
    used_bytes: usize,
}
impl Includes {
    fn charge(&mut self, bytes: usize) -> Result<(), String> {
        if self.includes.len() + self.blockers.len() >= 4096 {
            return Err(refused());
        }
        self.used_bytes = self
            .used_bytes
            .checked_add(bytes)
            .filter(|v| *v <= 1024 * 1024)
            .ok_or_else(refused)?;
        Ok(())
    }
    fn include(&mut self, path: String, start: usize, end: usize) -> Result<(), String> {
        self.charge(path.len() + 32)?;
        self.includes.push(LiteralInclude {
            path,
            byte_start: start,
            byte_end: end,
        });
        Ok(())
    }
    fn blocker(&mut self, text: String) -> Result<(), String> {
        self.charge(text.len())?;
        self.blockers.push(text);
        Ok(())
    }
}
fn whitespace(unit: u16) -> bool {
    matches!(unit,0x0009..=0x000d|0x0020|0x00a0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
}
fn check(c: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if c.load(Ordering::SeqCst) {
        Err("native_research_manuscript_cancelled".into())
    } else if Instant::now() >= deadline {
        Err("native_research_manuscript_deadline_exceeded".into())
    } else {
        Ok(())
    }
}
fn refused() -> String {
    "native_research_manuscript_input_v1_refused".into()
}
fn trim_units(units: &[u16]) -> &[u16] {
    let mut start = 0;
    let mut end = units.len();
    while start < end && whitespace(units[start]) {
        start += 1;
    }
    while end > start && whitespace(units[end - 1]) {
        end -= 1;
    }
    &units[start..end]
}
pub fn safe_path(value: &str) -> Option<String> {
    if value.len() > 4096 {
        return None;
    }
    let value = value.replace('\\', "/");
    let value = value.strip_prefix("./").unwrap_or(&value);
    if value.is_empty() || value.starts_with('/') || value.split('/').any(|v| v == "..") {
        None
    } else {
        Some(if value.ends_with(".tex") {
            value.into()
        } else {
            format!("{value}.tex")
        })
    }
}
fn included_path(current: &str, raw: &[u16]) -> Option<String> {
    let raw = String::from_utf16(trim_units(raw)).ok()?;
    if raw.is_empty()
        || raw.starts_with('/')
        || !raw
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || b"._/-".contains(&v))
    {
        return None;
    }
    let dir = Path::new(current).parent()?.to_str()?;
    let joined = if dir.is_empty() {
        raw
    } else {
        format!("{dir}/{raw}")
    };
    let mut parts = Vec::new();
    for v in joined.split('/') {
        match v {
            "" | "." => (),
            ".." => {
                if parts.last().is_some_and(|p| *p != "..") {
                    parts.pop();
                } else {
                    parts.push(v);
                }
            }
            v => parts.push(v),
        }
    }
    let normalized = if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    };
    let normalized = if joined.ends_with('/') && !normalized.ends_with('/') {
        format!("{normalized}/")
    } else {
        normalized
    };
    safe_path(&normalized)
}
fn escaped(source: &[u16], index: usize) -> bool {
    source[..index]
        .iter()
        .rev()
        .take_while(|v| **v == u16::from(b'\\'))
        .count()
        % 2
        == 1
}
fn ascii_word(unit: u16) -> bool {
    unit == u16::from(b'@')
        || unit == 0x017f
        || unit == 0x212a
        || u8::try_from(unit).is_ok_and(|v| v.is_ascii_alphabetic())
}
fn command(source: &[u16], index: usize, name: &[u8]) -> Option<usize> {
    let end = index.checked_add(name.len() + 1)?;
    if source.get(index) != Some(&u16::from(b'\\')) || end > source.len() {
        return None;
    }
    if source[index + 1..end]
        .iter()
        .zip(name)
        .all(|(a, b)| u8::try_from(*a).is_ok_and(|a| a.eq_ignore_ascii_case(b)))
        && !source.get(end).is_some_and(|v| ascii_word(*v))
    {
        Some(end)
    } else {
        None
    }
}
pub fn literal_includes(
    source: &[u16],
    relative: &str,
    universe: Universe,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<Includes, String> {
    check(c, deadline)?;
    if source.len() > 4 * 1024 * 1024 || relative.len() > 4096 {
        return Err(refused());
    }
    let mut cursor = 0;
    let mut next_close = None;
    let mut close_exhausted = false;
    let mut out = Includes {
        includes: Vec::new(),
        blockers: Vec::new(),
        used_bytes: 0,
    };
    while cursor < source.len() {
        check(c, deadline)?;
        let index = cursor;
        let Some(end) =
            command(source, index, b"input").or_else(|| command(source, index, b"include"))
        else {
            cursor += 1;
            continue;
        };
        cursor = end;
        if escaped(source, index) {
            continue;
        }
        let mut open = end;
        while open < source.len() && whitespace(source[open]) {
            check(c, deadline)?;
            open += 1;
        }
        if source.get(open) != Some(&u16::from(b'{')) {
            out.blocker(format!(
                "{}_include_not_literal:{relative}:{index}",
                universe.prefix()
            ))?;
            continue;
        }
        if next_close.is_none_or(|close| close <= open) && !close_exhausted {
            let mut candidate = open + 1;
            while candidate < source.len() && source[candidate] != u16::from(b'}') {
                check(c, deadline)?;
                candidate += 1;
            }
            next_close = (candidate < source.len()).then_some(candidate);
            close_exhausted = next_close.is_none();
        }
        let close = next_close;
        let Some(close) = close else {
            out.blocker(format!(
                "{}_include_not_literal:{relative}:{index}",
                universe.prefix()
            ))?;
            continue;
        };
        let value = &source[open + 1..close];
        if value.len() > 4096 {
            return Err(refused());
        }
        if value.contains(&u16::from(b'{')) {
            out.blocker(format!(
                "{}_include_not_literal:{relative}:{index}",
                universe.prefix()
            ))?;
            continue;
        }
        if let Some(path) = included_path(relative, value) {
            if path.len() > 4096 {
                return Err(refused());
            }
            out.include(path, index, close + 1)?;
        } else {
            out.blocker(format!(
                "{}_include_path_invalid:{relative}:{}",
                universe.prefix(),
                String::from_utf16(trim_units(value)).map_err(|_| refused())?
            ))?;
        }
        if out.includes.len() + out.blockers.len() > 4096 {
            return Err(refused());
        }
        cursor = close + 1;
    }
    check(c, deadline)?;
    Ok(out)
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub byte_start: usize,
    pub byte_end: usize,
}
pub fn trim_range(
    source: &[u16],
    start: usize,
    end: usize,
    c: &AtomicBool,
    deadline: Instant,
) -> Result<Range, String> {
    check(c, deadline)?;
    if source.len() > 4 * 1024 * 1024 || end > source.len() || start > end {
        return Err(refused());
    }
    let (mut start, mut end) = (start, end);
    while start < end && whitespace(source[start]) {
        check(c, deadline)?;
        start += 1;
    }
    while end > start && whitespace(source[end - 1]) {
        check(c, deadline)?;
        end -= 1;
    }
    Ok(Range {
        byte_start: start,
        byte_end: end,
    })
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub text: String,
    pub byte_start: usize,
    pub content_byte_end: usize,
    pub byte_end: usize,
}
pub fn line_records(
    source: &[u16],
    c: &AtomicBool,
    deadline: Instant,
) -> Result<Vec<Line>, String> {
    check(c, deadline)?;
    if source.len() > 4 * 1024 * 1024 {
        return Err(refused());
    }
    let mut lines = Vec::new();
    let mut start = 0;
    for cursor in 0..=source.len() {
        check(c, deadline)?;
        if cursor < source.len() && source[cursor] != u16::from(b'\n') {
            continue;
        }
        let content_end = if cursor > start && source[cursor - 1] == u16::from(b'\r') {
            cursor - 1
        } else {
            cursor
        };
        if lines.len() >= 65536 {
            return Err(refused());
        }
        lines.push(Line {
            text: String::from_utf16(&source[start..content_end]).map_err(|_| refused())?,
            byte_start: start,
            content_byte_end: content_end,
            byte_end: if cursor < source.len() {
                cursor + 1
            } else {
                cursor
            },
        });
        start = cursor + 1;
    }
    Ok(lines)
}
