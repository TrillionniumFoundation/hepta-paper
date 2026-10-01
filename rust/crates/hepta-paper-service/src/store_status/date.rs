//! Passive Date.parse finite checks for the incumbent's schema timestamps.
//! This module never produces a signed clock or an authorization lifetime.
use regex::Regex;

pub(super) fn finite(value: &str) -> bool {
    let Ok(pattern) = Regex::new(
        r"^(?P<year>[+-][0-9]{6}|[0-9]{4})(?:-(?P<month>[0-9]{2})(?:-(?P<day>[0-9]{2}))?)?(?:[Tt ](?P<hour>[0-9]{2}):(?P<minute>[0-9]{2})(?::(?P<second>[0-9]{2})(?:\.(?P<fraction>[0-9]+))?)?(?P<zone>[Zz]|[+-][0-9]{2}:?[0-9]{2})?)?$",
    ) else {
        return false;
    };
    let Some(c) = pattern.captures(value) else {
        return legacy(value);
    };
    let number = |name: &str, default: i64| {
        c.name(name)
            .map_or(Some(default), |m| m.as_str().parse::<i64>().ok())
    };
    let Some(year) = number("year", 0) else {
        return false;
    };
    let Some(month) = number("month", 1) else {
        return false;
    };
    let Some(day) = number("day", 1) else {
        return false;
    };
    let Some(hour) = number("hour", 0) else {
        return false;
    };
    let Some(minute) = number("minute", 0) else {
        return false;
    };
    let Some(second) = number("second", 0) else {
        return false;
    };
    if value.starts_with("-000000")
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 24
        || minute > 59
        || second > 59
        || hour == 24
            && (minute != 0
                || second != 0
                || c.name("fraction")
                    .is_some_and(|m| m.as_str().bytes().any(|b| b != b'0')))
    {
        return if value.contains(['T', 't']) {
            false
        } else {
            legacy(value)
        };
    }
    let offset = if let Some(zone) = c
        .name("zone")
        .map(|m| m.as_str())
        .filter(|z| !matches!(*z, "Z" | "z"))
    {
        let digits = zone[1..].replace(':', "");
        let hours = digits[..2].parse::<i64>().unwrap_or(99);
        let minutes = digits[2..].parse::<i64>().unwrap_or(99);
        if hours > 23 || minutes > 59 {
            return false;
        }
        (hours * 60 + minutes) * if zone.starts_with('-') { -1 } else { 1 }
    } else {
        0
    };
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = month + if month > 2 { -3 } else { 9 };
    let days =
        era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + (153 * mp + 2) / 5 + day - 1 - 719468;
    let fraction = c
        .name("fraction")
        .map(|m| {
            format!("{:0<3}", m.as_str())
                .chars()
                .take(3)
                .collect::<String>()
                .parse::<i64>()
                .unwrap_or(0)
        })
        .unwrap_or(0);
    let clock = hour * 3_600_000 + minute * 60_000 + second * 1000 + fraction;
    if c.name("zone").is_none() && c.name("hour").is_some() {
        return super::timezone::finite_local(year, month, day, clock).unwrap_or(false);
    }
    (days * 86_400_000 + clock - offset * 60_000).abs() <= 8_640_000_000_000_000
}

// Legacy composition follows the incumbent V8 12.4 parser's token/day/time
// rules: https://github.com/v8/v8/tree/12.4.254/src/date. This is a passive
// finite-date gate; signed clock validation keeps its separate ISO owner.
#[derive(Clone)]
enum Token {
    Number(i64, usize),
    Word(String),
    Symbol(char),
    Space,
    Other,
}
fn whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}' | '\u{000b}' | '\u{000c}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}
fn tokens(input: &str) -> Vec<Token> {
    let chars = input.chars().collect::<Vec<_>>();
    let mut i = 0;
    let mut out = Vec::new();
    while i < chars.len() {
        let ch = chars[i];
        if ch == '\0' {
            break;
        }
        if ch.is_ascii_digit() {
            let start = i;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            let number = chars[start..i]
                .iter()
                .skip_while(|v| **v == '0')
                .take(9)
                .collect::<String>()
                .parse()
                .unwrap_or(0);
            out.push(Token::Number(number, i - start));
        } else if matches!(ch, ':' | '-' | '+' | '.' | ')') {
            out.push(Token::Symbol(ch));
            i += 1;
        } else if whitespace(ch) || matches!(ch, '\n' | '\r') {
            out.push(Token::Space);
            i += 1;
        } else if ch >= 'A' {
            let start = i;
            while i < chars.len() && chars[i] >= 'A' && !whitespace(chars[i]) {
                i += 1;
            }
            out.push(Token::Word(
                chars[start..i]
                    .iter()
                    .collect::<String>()
                    .to_ascii_lowercase(),
            ));
        } else if ch == '(' {
            let mut balance = 1;
            i += 1;
            while i < chars.len() && balance > 0 {
                if chars[i] == '(' {
                    balance += 1;
                } else if chars[i] == ')' {
                    balance -= 1;
                }
                i += 1;
            }
            out.push(Token::Other);
        } else {
            out.push(Token::Other);
            i += 1;
        }
    }
    out
}
fn legacy(input: &str) -> bool {
    let tokens = tokens(input);
    let mut cursor = 0;
    let mut day = Vec::new();
    let mut time = Vec::new();
    let mut named_month = None;
    let mut hour_offset = None;
    let mut zone_hour = None;
    let mut zone_minute = None;
    let mut zone_sign = 1;
    let mut has_number = false;
    let symbol = |tokens: &[Token], index: usize, ch: char| matches!(tokens.get(index),Some(Token::Symbol(c)) if *c==ch);
    while cursor < tokens.len() {
        let token = tokens[cursor].clone();
        cursor += 1;
        let expecting = |time: &Vec<i64>, n: i64| {
            (time.len() == 1 || time.len() == 2) && (0..=59).contains(&n)
                || time.len() == 3 && (0..=999).contains(&n)
        };
        match token {
            Token::Number(n, _) => {
                has_number = true;
                if symbol(&tokens, cursor, ':') {
                    cursor += 1;
                    if symbol(&tokens, cursor, ':') {
                        cursor += 1;
                        if !time.is_empty() {
                            return false;
                        }
                        time.extend([n, 0]);
                    } else {
                        if time.len() >= 4 {
                            return false;
                        }
                        time.push(n);
                        if symbol(&tokens, cursor, '.') {
                            cursor += 1;
                        }
                    }
                } else if symbol(&tokens, cursor, '.') {
                    cursor += 1;
                    if expecting(&time, n) {
                        time.push(n);
                        let Some(Token::Number(ms, len)) = tokens.get(cursor) else {
                            return false;
                        };
                        let ms = if *len < 3 {
                            *ms * 10_i64.pow((3 - len) as u32)
                        } else {
                            *ms / 10_i64.pow(((*len).min(9) - 3) as u32)
                        };
                        cursor += 1;
                        if time.len() >= 4 {
                            return false;
                        }
                        time.push(ms);
                        while time.len() < 4 {
                            time.push(0);
                        }
                    } else {
                        if day.len() >= 3 {
                            return false;
                        }
                        day.push(n);
                    }
                } else if zone_hour.is_some() && zone_minute.is_none() && (0..=59).contains(&n) {
                    zone_minute = Some(n);
                } else if expecting(&time, n) {
                    time.push(n);
                    while time.len() < 4 {
                        time.push(0);
                    }
                    if !matches!(
                        tokens.get(cursor),
                        None | Some(Token::Space) | Some(Token::Symbol('+' | '-'))
                    ) && !matches!(tokens.get(cursor),Some(Token::Word(w)) if w=="z")
                    {
                        return false;
                    }
                } else {
                    if day.len() >= 3 {
                        return false;
                    }
                    day.push(n);
                    if symbol(&tokens, cursor, '-') {
                        cursor += 1;
                    }
                }
            }
            Token::Word(word) => {
                let month = [
                    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov",
                    "dec",
                ]
                .iter()
                .position(|m| word.starts_with(m));
                let zone = match word.as_str() {
                    "ut" | "utc" | "z" | "gmt" => Some(0),
                    "cdt" | "est" => Some(-5),
                    "cst" | "mdt" => Some(-6),
                    "edt" => Some(-4),
                    "mst" | "pdt" => Some(-7),
                    "pst" => Some(-8),
                    _ => None,
                };
                if matches!(word.as_str(), "am" | "pm") && !time.is_empty() {
                    hour_offset = Some(if word == "pm" { 12 } else { 0 });
                } else if let Some(month) = month {
                    named_month = Some(month as i64 + 1);
                    if symbol(&tokens, cursor, '-') {
                        cursor += 1;
                    }
                } else if let Some(zone) = zone.filter(|_| has_number) {
                    zone_sign = if zone < 0 { -1 } else { 1 };
                    zone_hour = Some(i64::abs(zone));
                    zone_minute = Some(0);
                } else if has_number || matches!(tokens.get(cursor), Some(Token::Number(_, _))) {
                    return false;
                }
            }
            Token::Symbol(sign @ ('+' | '-'))
                if zone_hour == Some(0) && zone_minute == Some(0) || !time.is_empty() =>
            {
                zone_sign = if sign == '-' { -1 } else { 1 };
                let (n, len) = if let Some(Token::Number(n, len)) = tokens.get(cursor) {
                    cursor += 1;
                    (*n, *len)
                } else {
                    (0, 0)
                };
                has_number = true;
                if symbol(&tokens, cursor, ':') {
                    zone_hour = Some(n);
                    zone_minute = None;
                } else if (1..=2).contains(&len) {
                    zone_hour = Some(n);
                    zone_minute = Some(0);
                } else if (3..=4).contains(&len) {
                    zone_hour = Some(n / 100);
                    zone_minute = Some(n % 100);
                } else {
                    return false;
                }
            }
            Token::Symbol('+' | '-' | ')') if has_number => return false,
            _ => (),
        }
    }
    if day.is_empty() {
        return false;
    }
    let original = day.len();
    while day.len() < 3 {
        day.push(1);
    }
    let (mut year, month, date) = if let Some(month) = named_month {
        if original == 1 {
            (0, month, day[0])
        } else if !(1..=31).contains(&day[0]) {
            (day[0], month, day[1])
        } else {
            (day[1], month, day[0])
        }
    } else if !(1..=31).contains(&day[0]) {
        (day[0], day[1], day[2])
    } else {
        (day[2], day[0], day[1])
    };
    if (0..=49).contains(&year) {
        year += 2000;
    } else if (50..=99).contains(&year) {
        year += 1900;
    }
    if !(-300_000..=300_000).contains(&year)
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&date)
    {
        return false;
    }
    while time.len() < 4 {
        time.push(0);
    }
    if let Some(offset) = hour_offset {
        if !(0..=12).contains(&time[0]) {
            return false;
        }
        time[0] = time[0] % 12 + offset;
    }
    if (!(0..=23).contains(&time[0])
        || !(0..=59).contains(&time[1])
        || !(0..=59).contains(&time[2])
        || !(0..=999).contains(&time[3]))
        && time != [24, 0, 0, 0]
    {
        return false;
    }
    let offset = zone_hour.unwrap_or(0) * 3600 + zone_minute.unwrap_or(0) * 60;
    if offset > 1_073_741_823 {
        return false;
    }
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = month + if month > 2 { -3 } else { 9 };
    let days =
        era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + (153 * mp + 2) / 5 + date - 1 - 719468;
    let clock = time[0] * 3_600_000 + time[1] * 60_000 + time[2] * 1000 + time[3];
    if zone_hour.is_none() {
        return super::timezone::finite_local(year, month, date, clock).unwrap_or(false);
    }
    (days * 86_400_000 + clock - zone_sign * offset * 1000).abs() <= 8_640_000_000_000_000
}

#[cfg(test)]
mod tests {
    use super::finite;
    #[test]
    fn finite_schema_dates_match_the_actual_qualified_node_parser() {
        let mut dates = vec![
            String::new(),
            "not-a-date".into(),
            "Jan 1, 2026".into(),
            "2026T01:02".into(),
            "1.0".into(),
            "1".into(),
            "999999999/1/1".into(),
            "999999999999/1/1".into(),
            "-000000-01-01".into(),
            "+275760-09-13T00:00:00.001".into(),
            "-271821-04-20T00:00:00.000".into(),
            "Thu, 01 Oct 2026 00:00:00 GMT".into(),
            "01 Oct 2026 12:34:56 PM GMT+0530".into(),
            "10/1/2026".into(),
            "2026-10-01 01:02:03".into(),
            "2026-10-01T01:02:03.123456+02:30".into(),
            "+275760-09-13T00:00:00.000Z".into(),
            "+275760-09-13T00:00:00.001Z".into(),
            "-271821-04-20T00:00:00.000Z".into(),
            "-271821-04-19T23:59:59.999Z".into(),
            "2026-10-01T24:00:00Z".into(),
            "2026-10-01T24:00:00.001Z".into(),
            "2026-10-01T01:02:03+24:00".into(),
            "2026-10-01T01:02:03+23:59".into(),
            "March 0, 2026".into(),
            "2026 garbage".into(),
            "garbage 2026".into(),
            "2026 (ignored (nested)) Jan 1".into(),
            "2026 JanuaryLong 1".into(),
        ];
        for year in [0, 1, 49, 50, 99, 100, 2026, 9999] {
            for month in [0, 1, 2, 12, 13] {
                for day in [0, 1, 28, 29, 30, 31, 32] {
                    dates.push(format!("{year:04}-{month:02}-{day:02}"));
                    dates.push(format!("{year:04}-{month:02}-{day:02}T00:00:00Z"));
                }
            }
        }
        for boundary in [
            "\u{000b}", "\u{0085}", "\u{00a0}", "\u{1680}", "\u{2007}", "\u{2028}", "\u{202f}",
            "\u{3000}", "\u{feff}", "\0",
        ] {
            dates.push(format!("{boundary}2026-10-01{boundary}"));
            dates.push(format!("2026{boundary}Jan{boundary}1"));
        }
        for suffix in [
            "",
            "Z",
            "GMT",
            "UTC",
            " GMT+00",
            " GMT+0530",
            " +23:59",
            " EST",
            " garbage",
            " (comment)",
        ] {
            for date in [
                "Jan 1 2026",
                "2026/10/1",
                "2026-10-01",
                "2026-10-01 12:34:56",
                "Thu Oct 1 12:34:56 2026",
            ] {
                dates.push(format!("{date}{suffix}"));
            }
        }
        for hour in 0..24 {
            for date in [
                "+275760-09-12",
                "+275760-09-13",
                "-271821-04-19",
                "-271821-04-20",
            ] {
                dates.push(format!("{date}T{hour:02}:30:00.001"));
            }
        }
        let input = serde_json::to_string(&dates).unwrap();
        let output=std::process::Command::new("node").args(["--input-type=module","-e","const dates=JSON.parse(process.argv[1]); console.log(JSON.stringify({version:process.version,v8:process.versions.v8,finite:dates.map(v=>Number.isFinite(Date.parse(v)))}));",&input]).output().unwrap();
        assert!(output.status.success());
        let observed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(observed["version"], "v22.23.1");
        let expected = observed["finite"].as_array().unwrap();
        let differences = dates
            .iter()
            .zip(expected)
            .filter_map(|(value, node)| {
                (finite(value) != node.as_bool().unwrap()).then_some((value, finite(value), node))
            })
            .collect::<Vec<_>>();
        assert!(
            differences.is_empty(),
            "actual Node Date.parse differs: {differences:?}"
        );
        if std::env::var_os("HEPTA_STORE_DATE_ORACLE_CHILD_V1").is_none() {
            for timezone in [
                "UTC",
                "Asia/Shanghai",
                "America/New_York",
                "Europe/London",
                "Pacific/Kiritimati",
                "CST-8",
                "EST5EDT",
                ":/etc/localtime",
                "invalid-zone",
                "",
                "ABC3DEF,M3.2.0/2,M11.1.0/2",
                "right/Asia/Shanghai",
                "posix/America/New_York",
                "GMT+05:30",
            ] {
                let child = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "store_status::date::tests::finite_schema_dates_match_the_actual_qualified_node_parser", "--nocapture"])
                    .env("HEPTA_STORE_DATE_ORACLE_CHILD_V1", "1")
                    .env("TZ", timezone)
                    .output().unwrap();
                assert!(
                    child.status.success(),
                    "actual Node timezone {timezone:?} differs: {} {}",
                    String::from_utf8_lossy(&child.stdout),
                    String::from_utf8_lossy(&child.stderr)
                );
            }
        }
    }
}
