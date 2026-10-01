//! Read-only POSIX rules from the selected TZif file for local Date TimeClip.
//! Common timestamps cannot reach TimeClip, so they need no timezone IO.
use regex::Regex;
use std::{
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

fn offset(value: &str) -> Option<i64> {
    let sign = if value.starts_with('-') { -1 } else { 1 };
    let parts = value
        .trim_start_matches(['+', '-'])
        .split(':')
        .map(str::parse::<i64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if parts.is_empty()
        || parts.len() > 3
        || parts[0] > 167
        || parts.get(1).is_some_and(|v| *v > 59)
        || parts.get(2).is_some_and(|v| *v > 59)
    {
        return None;
    }
    Some(
        sign * (parts[0] * 3600
            + parts.get(1).copied().unwrap_or(0) * 60
            + parts.get(2).copied().unwrap_or(0)),
    )
}
fn days(year: i64, month: i64, day: i64) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = month + if month > 2 { -3 } else { 9 };
    era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + (153 * mp + 2) / 5 + day - 1 - 719468
}
fn rule(value: &str, year: i64) -> Option<i64> {
    let (day, time) = value
        .split_once('/')
        .map_or((value, 7200), |(d, t)| (d, offset(t).unwrap_or(i64::MAX)));
    if time == i64::MAX {
        return None;
    }
    let index = if let Some(parts) = day.strip_prefix('M') {
        let n = parts
            .split('.')
            .map(str::parse::<i64>)
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        if n.len() != 3
            || !(1..=12).contains(&n[0])
            || !(1..=5).contains(&n[1])
            || !(0..=6).contains(&n[2])
        {
            return None;
        }
        let first = (days(year, n[0], 1) + 4).rem_euclid(7);
        let mut date = 1 + (n[2] - first).rem_euclid(7) + (n[1] - 1) * 7;
        let next = if n[0] == 12 {
            days(year + 1, 1, 1)
        } else {
            days(year, n[0] + 1, 1)
        };
        if days(year, n[0], date) >= next {
            date -= 7;
        }
        days(year, n[0], date) - days(year, 1, 1)
    } else if let Some(day) = day.strip_prefix('J') {
        let d = day.parse::<i64>().ok()?;
        if !(1..=365).contains(&d) {
            return None;
        }
        d - 1 + i64::from(d >= 60 && year % 4 == 0 && (year % 100 != 0 || year % 400 == 0))
    } else {
        let d = day.parse::<i64>().ok()?;
        if !(0..=365).contains(&d) {
            return None;
        }
        d
    };
    Some(index * 86400 + time)
}
struct Rules {
    future: String,
    earliest_offset: Option<i64>,
    fixed: bool,
}
fn counts(bytes: &[u8], header: usize) -> Option<[usize; 6]> {
    if bytes.get(header..header + 4)? != b"TZif" {
        return None;
    }
    let mut out = [0; 6];
    for (index, value) in out.iter_mut().enumerate() {
        let begin = header + 20 + index * 4;
        *value = u32::from_be_bytes(bytes.get(begin..begin + 4)?.try_into().ok()?) as usize;
    }
    Some(out)
}
fn selected_rules() -> Option<Rules> {
    // ICU's Linux host selection accepts Olson IDs; unsupported POSIX strings
    // fall back to the host zone. Alias trees use the same canonical zone rules.
    let selected = std::env::var("TZ").ok().filter(|value| {
        value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'/' | b'_' | b'-' | b'+')
                || index == 0 && byte == b':'
        })
    });
    let selected = selected.map(|value| {
        let value = value.trim_start_matches(':');
        value
            .strip_prefix("posix/")
            .or_else(|| value.strip_prefix("right/"))
            .unwrap_or(value)
            .to_owned()
    });
    let plain = |future: &str| Rules {
        future: future.into(),
        earliest_offset: None,
        fixed: false,
    };
    if let Some(value) = selected.as_deref() {
        if ["", "UTC", "Etc/UTC", "GMT", "Etc/GMT"].contains(&value) {
            return Some(plain("UTC0"));
        }
        if !PathBuf::from("/usr/share/zoneinfo").join(value).is_file()
            && value.bytes().any(|b| b.is_ascii_digit())
            && !Path::new(value).is_absolute()
        {
            let mut rules = plain(value);
            rules.fixed = true;
            return Some(rules);
        }
    }
    let mut historical = true;
    let file = if let Some(value) = selected {
        let value = value.trim_start_matches(':');
        if Path::new(value).is_absolute() {
            // Incumbent ICU falls back to a fixed host standard offset for
            // an absolute libc TZ file, instead of its historical rules.
            historical = false;
            PathBuf::from(value)
        } else {
            if Path::new(value)
                .components()
                .any(|p| !matches!(p, Component::Normal(_)))
            {
                return Some(plain("UTC0"));
            }
            PathBuf::from("/usr/share/zoneinfo").join(value)
        }
    } else {
        PathBuf::from("/etc/localtime")
    };
    let mut bytes = Vec::new();
    // Real zoneinfo aliases are supported. NONBLOCK prevents a caller-selected
    // FIFO from blocking before the regular-file and bounded-read checks.
    let Ok(mut opened) = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
        .open(&file)
    else {
        return Some(plain("UTC0"));
    };
    let before = opened.metadata().ok()?;
    if !before.is_file() || before.len() > 1024 * 1024 {
        return None;
    }
    (&mut opened)
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    let after = opened.metadata().ok()?;
    let named = fs::metadata(&file).ok()?;
    let identity = |value: &fs::Metadata| {
        (
            value.dev(),
            value.ino(),
            value.uid(),
            value.gid(),
            value.mode(),
            value.nlink(),
            value.len(),
            value.mtime(),
            value.mtime_nsec(),
            value.ctime(),
            value.ctime_nsec(),
        )
    };
    if bytes.len() as u64 != before.len()
        || identity(&before) != identity(&after)
        || identity(&before) != identity(&named)
    {
        return None;
    }
    if bytes.len() > 1024 * 1024 || !bytes.starts_with(b"TZif") {
        return None;
    }
    let first = counts(&bytes, 0)?;
    let first_size = first[3]
        .checked_mul(5)?
        .checked_add(first[4].checked_mul(6)?)?
        .checked_add(first[5])?
        .checked_add(first[2].checked_mul(8)?)?
        .checked_add(first[1])?
        .checked_add(first[0])?;
    let header = 44_usize.checked_add(first_size)?;
    let second = counts(&bytes, header)?;
    if second[4] == 0 {
        return None;
    }
    let type_begin = header
        .checked_add(44)?
        .checked_add(second[3].checked_mul(9)?)?;
    let earliest =
        i32::from_be_bytes(bytes.get(type_begin..type_begin + 4)?.try_into().ok()?) as i64;
    let end = bytes.iter().rposition(|b| *b == b'\n')?;
    let start = bytes[..end].iter().rposition(|b| *b == b'\n')?;
    let future = std::str::from_utf8(&bytes[start + 1..end]).ok()?.to_owned();
    if future.is_empty() {
        return None;
    }
    Some(Rules {
        future,
        earliest_offset: historical.then_some(earliest),
        fixed: !historical,
    })
}
pub(super) fn finite_local(year: i64, month: i64, day: i64, clock_ms: i64) -> Option<bool> {
    let local = days(year, month, day) * 86_400_000 + clock_ms;
    if local.abs() < 8_640_000_000_000_000 - 86_400_000 {
        return Some(true);
    }
    if local.abs() > 8_640_000_000_000_000 + 86_400_000 {
        return Some(false);
    }
    let source = selected_rules()?;
    if local < 0
        && let Some(offset) = source.earliest_offset
    {
        return Some((local - offset * 1000).abs() <= 8_640_000_000_000_000);
    }
    let pattern=Regex::new(r"^(?:<[^>]+>|[A-Za-z]{3,})(?P<std>[+-]?[0-9]+(?::[0-9]+(?::[0-9]+)?)?)(?:(?:<[^>]+>|[A-Za-z]{3,})(?P<dst>[+-]?[0-9]+(?::[0-9]+(?::[0-9]+)?)?)?(?:,(?P<start>[^,]+),(?P<end>[^,]+))?)?$").ok()?;
    let c = pattern.captures(&source.future)?;
    let standard = -offset(c.name("std")?.as_str())?;
    let mut selected = standard;
    if !source.fixed
        && let (Some(start), Some(end)) = (c.name("start"), c.name("end"))
    {
        let daylight = c
            .name("dst")
            .map(|m| offset(m.as_str()).map(|v| -v))
            .unwrap_or(Some(standard + 3600))?;
        let within = (days(year, month, day) - days(year, 1, 1)) * 86400 + clock_ms / 1000;
        let begin = rule(start.as_str(), year)? + (daylight - standard).max(0);
        let finish = rule(end.as_str(), year)?;
        let summer = if begin < finish {
            within >= begin && within < finish
        } else {
            within >= begin || within < finish
        };
        if summer {
            selected = daylight;
        }
    }
    Some((local - selected * 1000).abs() <= 8_640_000_000_000_000)
}
